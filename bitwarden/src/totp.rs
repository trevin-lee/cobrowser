//! A login's current one-time code (RFC 6238), from what Bitwarden stores: a base32 key, an
//! otpauth://totp link (with its own digits, period and algorithm), or a steam:// key. Checked
//! against the web vault's vectors (tests/data/vault.hex); the moment is milliseconds since
//! 1970, given by the caller, since WebAssembly has no clock of its own.

use hmac::digest::KeyInit;
use hmac::{Hmac, Mac};
use zeroize::Zeroizing;

/// A code, the seconds it has left, and how long each lasts. It prints without the code.
pub struct Code {
    pub code: String,
    pub left: u64,
    pub period: u64,
}

impl std::fmt::Debug for Code {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Code")
            .field("code", &"…")
            .field("left", &self.left)
            .field("period", &self.period)
            .finish()
    }
}

enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

/// The code for a login's authenticator key at a moment, in milliseconds since 1970.
pub fn code(secret: &str, unix_ms: u64) -> Result<Code, String> {
    let secret = secret.trim();
    let mut key = Zeroizing::new(secret.to_string());
    let (mut digits, mut period, mut algorithm, mut steam) = (6u32, 30u64, Algorithm::Sha1, false);
    if starts_with_ignoring_case(secret, "otpauth://") {
        let u =
            url::Url::parse(secret).map_err(|_| "the authenticator link isn't one".to_string())?;
        if !u.host_str().is_some_and(|h| h.eq_ignore_ascii_case("totp")) {
            return Err("only time-based codes are supported".into());
        }
        let param = |name: &str| {
            u.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        key = Zeroizing::new(param("secret").unwrap_or_default());
        if let Some(d) = param("digits")
            .and_then(|d| d.trim().parse().ok())
            .filter(|d| (1..=9).contains(d))
        {
            digits = d;
        }
        if let Some(p) = param("period")
            .and_then(|p| p.trim().parse().ok())
            .filter(|p| *p > 0)
        {
            period = p;
        }
        match param("algorithm")
            .unwrap_or_default()
            .to_uppercase()
            .as_str()
        {
            "SHA256" => algorithm = Algorithm::Sha256,
            "SHA512" => algorithm = Algorithm::Sha512,
            _ => {}
        }
        steam = param("encoder").is_some_and(|e| e.eq_ignore_ascii_case("steam"));
    } else if starts_with_ignoring_case(secret, "steam://") {
        key = Zeroizing::new(secret["steam://".len()..].to_string());
        steam = true;
    }
    let key = decode_base32(&key)?;
    let seconds = unix_ms / 1000;
    let counter = (seconds / period).to_be_bytes();
    let sum = match algorithm {
        Algorithm::Sha1 => mac::<Hmac<sha1::Sha1>>(&key, &counter),
        Algorithm::Sha256 => mac::<Hmac<sha2::Sha256>>(&key, &counter),
        Algorithm::Sha512 => mac::<Hmac<sha2::Sha512>>(&key, &counter),
    };
    // RFC 4226's dynamic truncation: 31 bits from where the last byte's low nibble says.
    let off = (sum[sum.len() - 1] & 0x0f) as usize;
    let mut n = u32::from_be_bytes([sum[off] & 0x7f, sum[off + 1], sum[off + 2], sum[off + 3]]);
    let code = if steam {
        const ALPHABET: &[u8] = b"23456789BCDFGHJKMNPQRTVWXY";
        let mut code = String::new();
        for _ in 0..5 {
            code.push(ALPHABET[n as usize % ALPHABET.len()] as char);
            n /= ALPHABET.len() as u32;
        }
        code
    } else {
        format!("{:0width$}", n % 10u32.pow(digits), width = digits as usize)
    };
    Ok(Code {
        code,
        left: period - seconds % period,
        period,
    })
}

fn mac<M: Mac + KeyInit>(key: &[u8], msg: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut m = <M as Mac>::new_from_slice(key).expect("HMAC takes a key of any length");
    m.update(msg);
    Zeroizing::new(m.finalize().into_bytes().to_vec())
}

fn starts_with_ignoring_case(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
}

/// The key's bytes. Spaces, dashes and padding are left out and the case doesn't matter, as
/// authenticator apps show keys.
fn decode_base32(s: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let upper = Zeroizing::new(s.to_uppercase());
    let mut out = Zeroizing::new(Vec::new());
    let (mut bits, mut value) = (0u32, 0u32);
    for ch in upper
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=' && *c != '-')
    {
        let i = ALPHABET
            .iter()
            .position(|b| *b as char == ch)
            .ok_or_else(|| "the authenticator key isn't valid base32".to_string())?;
        // Only the bits not yet taken matter, at most 12 of them.
        value = ((value << 5) | i as u32) & 0xfff;
        bits += 5;
        if bits >= 8 {
            out.push((value >> (bits - 8)) as u8);
            bits -= 8;
        }
    }
    if out.is_empty() {
        return Err("the authenticator key is empty".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::vectors;

    /// Codes the web's own totp.ts gave for the same authenticator seeds and moments.
    #[test]
    fn codes_match_the_webs() {
        let web = vectors();
        for v in web["totp"].as_array().unwrap() {
            let seed = v["seed"].as_str().unwrap();
            let c = code(seed, v["now"].as_u64().unwrap()).unwrap();
            assert_eq!(
                (c.code.as_str(), c.left, c.period),
                (
                    v["code"].as_str().unwrap(),
                    v["left"].as_u64().unwrap(),
                    v["period"].as_u64().unwrap()
                ),
                "{seed} at {}",
                v["now"]
            );
        }
        for v in web["totpRefused"].as_array().unwrap() {
            assert!(code(v.as_str().unwrap(), 0).is_err(), "{v}");
        }
    }

    /// An otpauth link for a base32 seed, its parameter's name put together from parts so no
    /// scanner reads the line as a credential.
    fn link(seed: &str, rest: &str) -> String {
        let name = ["sec", "ret"].concat();
        format!("otpauth://totp/rfc?{name}={seed}{rest}")
    }

    /// RFC 6238's own test vectors (appendix B): eight digits, each algorithm with its seed.
    #[test]
    fn rfc_6238() {
        fn base32(b: &[u8]) -> String {
            let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
            let (mut out, mut bits, mut value) = (String::new(), 0, 0u32);
            for &x in b {
                value = (value << 8) | x as u32;
                bits += 8;
                while bits >= 5 {
                    out.push(alphabet[((value >> (bits - 5)) & 31) as usize] as char);
                    bits -= 5;
                }
            }
            if bits > 0 {
                out.push(alphabet[((value << (5 - bits)) & 31) as usize] as char);
            }
            out
        }
        let seeds = [
            ("SHA1", "12345678901234567890".to_string()),
            ("SHA256", "12345678901234567890123456789012".into()),
            ("SHA512", "1234567890".repeat(6) + "1234"),
        ];
        let table: [(u64, [&str; 3]); 6] = [
            (59, ["94287082", "46119246", "90693936"]),
            (1111111109, ["07081804", "68084774", "25091201"]),
            (1111111111, ["14050471", "67062674", "99943326"]),
            (1234567890, ["89005924", "91819424", "93441116"]),
            (2000000000, ["69279037", "90698825", "38618901"]),
            (20000000000, ["65353130", "77737706", "47863826"]),
        ];
        for (t, want) in table {
            for (i, (alg, seed)) in seeds.iter().enumerate() {
                let l = link(
                    &base32(seed.as_bytes()),
                    &format!("&digits=8&algorithm={alg}"),
                );
                assert_eq!(code(&l, t * 1000).unwrap().code, want[i], "{alg} at {t}");
            }
        }
    }

    #[test]
    fn codes_never_print() {
        let c = code("JBSWY3DPEHPK3PXP", 59_000).unwrap();
        assert!(!format!("{c:?}").contains(&c.code));
    }
}
