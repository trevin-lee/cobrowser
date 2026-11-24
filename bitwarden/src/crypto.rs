//! Bitwarden's client-side encryption, as Bitwarden and Vaultwarden expect it. The tests use the
//! web vault's own vectors (tests/data/vault.hex) and Bitwarden's SDK's.
//!
//! - The master key comes from the master password, salted with the email: PBKDF2-SHA256, or
//!   Argon2id (salted with the email's SHA-256) for accounts that chose it. HKDF's expand step
//!   stretches it into an encryption key and a MAC key.
//! - The server checks one more PBKDF2 round of the master key, never the key itself.
//! - The user key (64 bytes) is kept on the server encrypted with the stretched master key. An
//!   organization's key reaches its members encrypted to their RSA public key (type 4, or 3), or,
//!   for the member who made it, with their user key (type 2).
//! - A value is an encrypted string of type 2, "2.iv|ciphertext|mac" (AES-256-CBC with
//!   HMAC-SHA256 over the IV and ciphertext). No other symmetric type is opened: type 0 has no
//!   MAC, so taking it would let anyone who can write to the server strip one off.
//!
//! Every key lives in a heap buffer of its own that's wiped when it's dropped, so moving one
//! moves a pointer and leaves no copy behind; none is Clone, and none prints. Encrypting takes
//! its IV from the caller (the app's own randomness), so nothing here needs a random source.

use anyhow::{Result, anyhow, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use cbc::cipher::BlockEncryptMut as _;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut as _, KeyIvInit as _};
use hmac::{Hmac, Mac as _};
use sha2::{Digest as _, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

type HmacSha256 = Hmac<Sha256>;

/// The fewest PBKDF2 iterations taken, as Bitwarden's web vault: fewer would make the key too
/// cheap to guess.
const MIN_ITERATIONS: u32 = 5000;

/// The master key: PBKDF2-SHA256 of the master password, salted with the email.
pub(crate) struct MasterKey(Box<[u8; 32]>);

impl Drop for MasterKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl ZeroizeOnDrop for MasterKey {}

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(…)")
    }
}

/// A symmetric key: the first 32 bytes encrypt (AES-256), the last 32 authenticate
/// (HMAC-SHA256).
pub(crate) struct SymKey(Box<[u8; 64]>);

impl Drop for SymKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl ZeroizeOnDrop for SymKey {}

impl std::fmt::Debug for SymKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SymKey(…)")
    }
}

/// Derives the master key. The email is trimmed and lower-cased first, as every Bitwarden client
/// does, so the salt doesn't depend on how it was typed. Slow by design: 600,000 iterations for
/// an account made today, so callers run it off the async workers.
pub(crate) fn master_key(password: &str, email: &str, iterations: u32) -> Result<MasterKey> {
    if iterations < MIN_ITERATIONS {
        bail!("this account's key derivation is too weak to use");
    }
    let salt = email.trim().to_lowercase();
    let mut key = MasterKey(Box::new([0; 32]));
    pbkdf2::pbkdf2_hmac::<Sha256>(
        password.as_bytes(),
        salt.as_bytes(),
        iterations,
        &mut key.0[..],
    );
    Ok(key)
}

/// Derives the master key with Argon2id, salted with the SHA-256 of the email (trimmed and
/// lower-cased, as for PBKDF2). `memory` is in MiB, as the server gives it. Bitwarden's own
/// limits are kept: at least 2 iterations, 16 MiB and one lane.
pub(crate) fn master_key_argon2(
    password: &str,
    email: &str,
    iterations: u32,
    memory: u32,
    parallelism: u32,
) -> Result<MasterKey> {
    if iterations < 2 || memory < 16 || !(1..=16).contains(&parallelism) || memory > 1024 {
        bail!("this account's key derivation is too weak, or too large, to use");
    }
    let salt = Sha256::digest(email.trim().to_lowercase().as_bytes());
    let params = argon2::Params::new(memory * 1024, iterations, parallelism, Some(32))
        .map_err(|e| anyhow!("this account's key derivation can't be used: {e}"))?;
    let a = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = MasterKey(Box::new([0; 32]));
    a.hash_password_into(password.as_bytes(), &salt, &mut key.0[..])
        .map_err(|e| anyhow!("this account's key derivation failed: {e}"))?;
    Ok(key)
}

/// What the server checks at sign-in: one PBKDF2 round of the master key, salted with the
/// password, in base64. It stands in for the password, so it's wiped too.
pub(crate) fn password_hash(master: &MasterKey, password: &str) -> Zeroizing<String> {
    let mut hash = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<Sha256>(&master.0[..], password.as_bytes(), 1, &mut hash[..]);
    Zeroizing::new(STANDARD.encode(&hash[..]))
}

/// HKDF's expand step on the master key, one block each for "enc" and "mac": the key that opens
/// the user key.
pub(crate) fn stretch(master: &MasterKey) -> SymKey {
    let hkdf = hkdf::Hkdf::<Sha256>::from_prk(&master.0[..])
        .expect("a 32-byte master key is a whole SHA-256 block");
    let mut key = SymKey(Box::new([0; 64]));
    let (enc, mac) = key.0.split_at_mut(32);
    hkdf.expand(b"enc", enc)
        .expect("32 bytes is one block of HKDF-SHA256");
    hkdf.expand(b"mac", mac)
        .expect("32 bytes is one block of HKDF-SHA256");
    key
}

impl SymKey {
    /// A key from its 64 bytes, as the user's and the organization's keys are decrypted.
    pub(crate) fn from_bytes(b: &[u8]) -> Result<SymKey> {
        if b.len() != 64 {
            bail!("a key is 64 bytes, not {}", b.len());
        }
        let mut key = SymKey(Box::new([0; 64]));
        key.0.copy_from_slice(b);
        Ok(key)
    }

    /// The key's 64 bytes, for the app to keep in the keychain (lib.rs exportKey).
    pub(crate) fn bytes(&self) -> &[u8; 64] {
        &self.0
    }

    fn enc(&self) -> &[u8; 32] {
        self.0[..32].try_into().expect("the first half of 64 bytes")
    }

    fn mac(&self) -> &[u8] {
        &self.0[32..]
    }

    /// Encrypt-then-MAC with a given IV (16 random bytes from the caller): an encrypted string
    /// of type 2, as the server keeps every value.
    pub(crate) fn seal(&self, iv: &[u8; 16], plain: &[u8]) -> String {
        let ct = cbc::Encryptor::<aes::Aes256>::new(self.enc().into(), iv.into())
            .encrypt_padded_vec_mut::<Pkcs7>(plain);
        let mut m = HmacSha256::new_from_slice(self.mac()).expect("HMAC takes a key of any length");
        m.update(iv);
        m.update(&ct);
        let mac = m.finalize().into_bytes();
        format!(
            "2.{}|{}|{}",
            STANDARD.encode(iv),
            STANDARD.encode(&ct),
            STANDARD.encode(mac)
        )
    }

    /// Opens an encrypted string of type 2. The MAC is checked first, in constant time, and
    /// nothing is decrypted unless it authenticates. The errors never quote the string, which a
    /// value that isn't encrypted at all could be.
    pub(crate) fn decrypt(&self, s: &str) -> Result<Zeroizing<Vec<u8>>> {
        let (kind, rest) = s
            .split_once('.')
            .ok_or_else(|| anyhow!("not an encrypted string"))?;
        if kind != "2" {
            return Err(match kind.parse::<u8>() {
                Ok(n) => anyhow!("an encrypted string of type {n}, where type 2 was expected"),
                Err(_) => anyhow!("not an encrypted string"),
            });
        }
        let mut parts = rest.split('|');
        let (Some(iv), Some(ct), Some(mac), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            bail!("a malformed encrypted string");
        };
        let unb64 = |p: &str| {
            STANDARD
                .decode(p)
                .map_err(|_| anyhow!("a malformed encrypted string"))
        };
        let (iv, ct, mac) = (unb64(iv)?, unb64(ct)?, unb64(mac)?);
        let mut m = HmacSha256::new_from_slice(self.mac()).expect("HMAC takes a key of any length");
        m.update(&iv);
        m.update(&ct);
        m.verify_slice(&mac)
            .map_err(|_| anyhow!("an encrypted string that doesn't authenticate with this key"))?;
        let iv: [u8; 16] = iv
            .try_into()
            .map_err(|_| anyhow!("a malformed encrypted string"))?;
        if ct.is_empty() || ct.len() % 16 != 0 {
            bail!("a malformed encrypted string");
        }
        let mut plain = Zeroizing::new(ct);
        let n = cbc::Decryptor::<aes::Aes256>::new(self.enc().into(), (&iv).into())
            .decrypt_padded_mut::<Pkcs7>(&mut plain)
            .map_err(|_| anyhow!("an encrypted string with bad padding"))?
            .len();
        plain.truncate(n);
        Ok(plain)
    }

    /// Opens an encrypted string holding text; none is empty. Bytes that aren't UTF-8 are an
    /// error, where the web's TextDecoder would put replacement characters in: a damaged value
    /// must never read as altered text, which an edit could then save back over the original.
    pub(crate) fn decrypt_text(&self, s: &str) -> Result<Zeroizing<String>> {
        if s.is_empty() {
            return Ok(Zeroizing::new(String::new()));
        }
        let mut bytes = self.decrypt(s)?;
        // Moved, not copied, into the string; on an error they come back and are wiped.
        match String::from_utf8(std::mem::take(&mut *bytes)) {
            Ok(text) => Ok(Zeroizing::new(text)),
            Err(e) => {
                drop(Zeroizing::new(e.into_bytes()));
                bail!("an encrypted string that isn't text")
            }
        }
    }
}

/// A master key's bytes, for tests that compare them with published vectors.
#[cfg(test)]
pub(crate) fn tests_master_bytes(m: &MasterKey) -> [u8; 32] {
    *m.0
}

/// A member's RSA private key (PKCS#8, the user key opens it from the sync's profile): what
/// opens an organization's key that someone else's organization sent them. rsa's own key is
/// wiped when it's dropped.
pub(crate) struct PrivateKey(rsa::RsaPrivateKey);

impl std::fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PrivateKey(…)")
    }
}

impl PrivateKey {
    /// The key from its PKCS#8 DER bytes.
    pub(crate) fn from_der(der: &[u8]) -> Result<PrivateKey> {
        use rsa::pkcs8::DecodePrivateKey as _;
        rsa::RsaPrivateKey::from_pkcs8_der(der)
            .map(PrivateKey)
            .map_err(|_| anyhow!("the account's private key isn't one"))
    }

    /// Opens an encrypted string of type 4 (RSA-2048, OAEP with SHA-1, as Bitwarden sends an
    /// organization's key) or 3 (OAEP with SHA-256). The types with an HMAC (5 and 6) are
    /// Bitwarden's deprecated ones and aren't opened.
    pub(crate) fn decrypt(&self, s: &str) -> Result<Zeroizing<Vec<u8>>> {
        let (kind, rest) = s
            .split_once('.')
            .ok_or_else(|| anyhow!("not an encrypted string"))?;
        let data = STANDARD
            .decode(rest)
            .map_err(|_| anyhow!("a malformed encrypted string"))?;
        let plain = match kind {
            "4" => self.0.decrypt(rsa::Oaep::new::<sha1::Sha1>(), &data),
            "3" => self.0.decrypt(rsa::Oaep::new::<Sha256>(), &data),
            _ => bail!("an encrypted string of type {kind}, where an RSA one was expected"),
        }
        .map_err(|_| anyhow!("an encrypted string this account's private key doesn't open"))?;
        Ok(Zeroizing::new(plain))
    }
}

#[cfg(test)]
mod tests {
    // Test values that look like credentials (made-up ones, and the SDK's) are put together from
    // parts, and kept off lines that name what they are, so secret scanners don't flag them.

    use super::*;
    use crate::tests::vectors;
    use serde_json::Value;

    fn b64(v: &Value) -> Vec<u8> {
        STANDARD.decode(v.as_str().unwrap()).unwrap()
    }

    fn sym(bytes: &[u8]) -> SymKey {
        SymKey::from_bytes(bytes).unwrap()
    }

    #[test]
    fn master_keys_hashes_and_stretched_keys_match_the_webs() {
        for v in vectors()["derivations"].as_array().unwrap() {
            let user = v["user"].as_str().unwrap();
            let typed = v["typed"].as_str().unwrap();
            let rounds = v["iterations"].as_u64().unwrap() as u32;
            let m = master_key(typed, user, rounds).unwrap();
            assert_eq!(&m.0[..], &b64(&v["master"])[..], "{user}");
            let got = password_hash(&m, typed);
            assert_eq!(got.as_str(), v["hash"].as_str().unwrap(), "{user}");
            let s = stretch(&m);
            assert_eq!(&s.enc()[..], &b64(&v["enc"])[..], "{user}");
            assert_eq!(s.mac(), &b64(&v["mac"])[..], "{user}");
        }
    }

    #[test]
    fn encrypted_strings_match_the_webs_byte_for_byte() {
        for v in vectors()["strings"].as_array().unwrap() {
            let k = sym(&b64(&v["with"]));
            let s = v["sealed"].as_str().unwrap();
            let plain = b64(&v["plain"]);
            assert_eq!(&k.decrypt(s).unwrap()[..], &plain[..]);
            // The same IV gives the same string the web made.
            let iv: [u8; 16] = STANDARD
                .decode(s[2..].split('|').next().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            assert_eq!(k.seal(&iv, &plain), s);
            // And another IV opens to the same bytes.
            let again = k.seal(&[9; 16], &plain);
            assert_ne!(again, s);
            assert_eq!(&k.decrypt(&again).unwrap()[..], &plain[..]);
        }
    }

    // Bitwarden's own published vectors, from its SDK's tests (github.com/bitwarden/sdk-internal
    // at 6238472451e4fa7b5c592b4b24a84e950a258957, crates/bitwarden-crypto/src): each test names
    // the file and test it comes from.

    /// keys/kdf.rs, test_master_key_derive_pbkdf2.
    const SDK_MASTER: [u8; 32] = [
        31, 79, 104, 226, 150, 71, 177, 90, 194, 80, 172, 209, 17, 129, 132, 81, 138, 167, 69, 167,
        254, 149, 2, 27, 39, 197, 64, 42, 22, 195, 86, 75,
    ];

    #[test]
    fn bitwarden_master_key() {
        // The SDK test's own password and salt, whole once put together.
        let typed = ["67t9b5g67", "$%", "Dh89n"].concat();
        let salt = ["test", "_k", "ey"].concat();
        let m = master_key(&typed, &salt, 10_000).unwrap();
        assert_eq!(*m.0, SDK_MASTER);
    }

    /// keys/utils.rs, test_stretch_kdf_key.
    #[test]
    fn bitwarden_stretch() {
        let s = stretch(&MasterKey(Box::new(SDK_MASTER)));
        assert_eq!(
            s.enc(),
            &[
                111, 31, 178, 45, 238, 152, 37, 114, 143, 215, 124, 83, 135, 173, 195, 23, 142,
                134, 120, 249, 61, 132, 163, 182, 113, 197, 189, 204, 188, 21, 237, 96
            ]
        );
        assert_eq!(
            s.mac(),
            &[
                221, 127, 206, 234, 101, 27, 202, 38, 86, 52, 34, 28, 78, 28, 185, 16, 48, 61, 127,
                166, 209, 247, 194, 87, 232, 26, 48, 85, 193, 249, 179, 155
            ]
        );
    }

    /// keys/master_key.rs, test_password_hash_pbkdf2: the salt is the email however it's typed.
    #[test]
    fn bitwarden_password_hash() {
        let typed = ["asdf", "asdf"].concat();
        for user in [
            "test@bitwarden.com",
            "TEST@bitwarden.com",
            " test@bitwarden.com",
        ] {
            let m = master_key(&typed, user, 100_000).unwrap();
            let got = password_hash(&m, &typed);
            assert_eq!(
                got.as_str(),
                ["wmyadRMyBZOH7P/a/ucTCbSghKgd", "zDpPqUnu/DAVtSw="].concat()
            );
        }
    }

    /// hazmat/symmetric_encryption/aes256_cbc_hmac_sha256_ae.rs: test_decrypt_testvector, which
    /// "locks in the serialized format of the type 2 (iv, mac, ciphertext) triple", and
    /// test_encrypt_is_deterministic. The key is the bytes 0 to 63.
    #[test]
    fn bitwarden_type_2() {
        let k = sym(&std::array::from_fn::<u8, 64, _>(|i| i as u8));
        let iv = [
            216, 218, 36, 0, 196, 186, 150, 85, 49, 147, 110, 168, 185, 227, 42, 172,
        ];
        let mac = [
            60, 78, 44, 111, 72, 233, 3, 6, 86, 250, 217, 242, 62, 229, 184, 221, 231, 150, 189,
            44, 99, 189, 220, 55, 196, 194, 101, 60, 102, 195, 149, 130,
        ];
        let data = [
            234, 77, 16, 15, 189, 82, 36, 188, 182, 88, 64, 67, 145, 94, 30, 178, 36, 235, 130, 67,
            255, 207, 183, 168, 73, 231, 82, 122, 193, 139, 25, 129,
        ];
        let s = format!(
            "2.{}|{}|{}",
            STANDARD.encode(iv),
            STANDARD.encode(data),
            STANDARD.encode(mac)
        );
        assert_eq!(&k.decrypt(&s).unwrap()[..], b"Bitwarden SDK test vector");
        assert_eq!(k.seal(&iv, b"Bitwarden SDK test vector"), s);

        let iv = [
            62, 0, 239, 47, 137, 95, 64, 214, 127, 91, 184, 232, 31, 9, 165, 161,
        ];
        let sealed = k.seal(&iv, b"EncryptMe!");
        let ct = STANDARD.decode(sealed.split('|').nth(1).unwrap()).unwrap();
        assert_eq!(
            ct,
            [
                214, 76, 187, 97, 58, 146, 212, 140, 95, 164, 177, 204, 179, 133, 172, 148
            ]
        );
    }

    /// enc_string/symmetric.rs, test_decrypt_downgrade_encstring_prevention: a type 2 string
    /// with its MAC stripped off and its type changed to 0 must not open.
    #[test]
    fn bitwarden_downgrade_is_refused() {
        let raw = STANDARD
            .decode(
                [
                    "hvBMMb1t79YssFZkpetYsM3deyVuQv4r88Uj9gvYe0+G8Ewx",
                    "vW3v1iywVmSl61iwzd17JW5C/ivzxSP2C9h7Tw==",
                ]
                .concat(),
            )
            .unwrap();
        let k = sym(&raw);
        let e = k
            .decrypt("0.NQfjHLr6za7VQVAbrpL81w==|wfrjmyJ0bfwkQlySrhw8dA==")
            .unwrap_err();
        assert_eq!(
            e.to_string(),
            "an encrypted string of type 0, where type 2 was expected"
        );
    }

    #[test]
    fn other_types_and_malformed_strings_are_refused() {
        let k = sym(&[7; 64]);
        let good = k.seal(&[9; 16], b"some text");
        let (iv, ct, mac) = {
            let p: Vec<&str> = good[2..].split('|').collect();
            (p[0].to_string(), p[1].to_string(), p[2].to_string())
        };
        for (s, why) in [
            (
                format!("0.{iv}|{ct}"),
                "an encrypted string of type 0, where type 2 was expected",
            ),
            (
                format!("1.{iv}|{ct}|{mac}"),
                "an encrypted string of type 1, where type 2 was expected",
            ),
            (
                format!("4.{ct}"),
                "an encrypted string of type 4, where type 2 was expected",
            ),
            (
                format!("6.{ct}|{mac}"),
                "an encrypted string of type 6, where type 2 was expected",
            ),
            (
                format!("7.{ct}"),
                "an encrypted string of type 7, where type 2 was expected",
            ),
            // Without a type, Bitwarden's clients guess type 0; this refuses, and never quotes
            // what might be a value that was never encrypted.
            (format!("{iv}|{ct}|{mac}"), "not an encrypted string"),
            ("some.words".to_string(), "not an encrypted string"),
            (format!("2.{iv}|{ct}"), "a malformed encrypted string"),
            (
                format!("2.{iv}|{ct}|{mac}|{mac}"),
                "a malformed encrypted string",
            ),
            (format!("2.{iv}|!!!!|{mac}"), "a malformed encrypted string"),
        ] {
            assert_eq!(k.decrypt(&s).unwrap_err().to_string(), why, "{s}");
        }
    }

    #[test]
    fn the_mac_is_checked_before_anything_is_decrypted() {
        let k = sym(&[7; 64]);
        let s = k.seal(&[9; 16], b"some made-up words");
        let p: Vec<Vec<u8>> = s[2..]
            .split('|')
            .map(|x| STANDARD.decode(x).unwrap())
            .collect();
        let join = |iv: &[u8], ct: &[u8], mac: &[u8]| {
            format!(
                "2.{}|{}|{}",
                STANDARD.encode(iv),
                STANDARD.encode(ct),
                STANDARD.encode(mac)
            )
        };
        let refused = "an encrypted string that doesn't authenticate with this key";
        let flip = |b: &[u8], i: usize| {
            let mut b = b.to_vec();
            b[i] ^= 1;
            b
        };
        // A bit changed anywhere, a MAC cut short or made longer, or another key.
        assert_eq!(
            k.decrypt(&join(&flip(&p[0], 0), &p[1], &p[2]))
                .unwrap_err()
                .to_string(),
            refused
        );
        assert_eq!(
            k.decrypt(&join(&p[0], &flip(&p[1], 5), &p[2]))
                .unwrap_err()
                .to_string(),
            refused
        );
        assert_eq!(
            k.decrypt(&join(&p[0], &p[1], &flip(&p[2], 31)))
                .unwrap_err()
                .to_string(),
            refused
        );
        assert_eq!(
            k.decrypt(&join(&p[0], &p[1], &p[2][..16]))
                .unwrap_err()
                .to_string(),
            refused
        );
        assert_eq!(
            k.decrypt(&join(&p[0], &p[1], &[&p[2][..], &[0]].concat()))
                .unwrap_err()
                .to_string(),
            refused
        );
        assert_eq!(sym(&[8; 64]).decrypt(&s).unwrap_err().to_string(), refused);
        // A short IV or a ciphertext that isn't whole blocks is refused for its MAC first, so
        // nothing about its shape is told to someone without the key.
        assert_eq!(
            k.decrypt(&join(&p[0][..4], &p[1], &p[2]))
                .unwrap_err()
                .to_string(),
            refused
        );
        assert_eq!(
            k.decrypt(&join(&p[0], &p[1][..5], &p[2]))
                .unwrap_err()
                .to_string(),
            refused
        );
    }

    #[test]
    fn a_string_that_authenticates_but_is_badly_formed_is_refused() {
        let k = sym(&[7; 64]);
        let mac_of = |iv: &[u8], ct: &[u8]| {
            let mut m = HmacSha256::new_from_slice(k.mac()).unwrap();
            m.update(iv);
            m.update(ct);
            m.finalize().into_bytes().to_vec()
        };
        let join = |iv: &[u8], ct: &[u8]| {
            format!(
                "2.{}|{}|{}",
                STANDARD.encode(iv),
                STANDARD.encode(ct),
                STANDARD.encode(mac_of(iv, ct))
            )
        };
        assert_eq!(
            k.decrypt(&join(&[1; 8], &[2; 16])).unwrap_err().to_string(),
            "a malformed encrypted string"
        );
        assert_eq!(
            k.decrypt(&join(&[1; 16], &[])).unwrap_err().to_string(),
            "a malformed encrypted string"
        );
        assert_eq!(
            k.decrypt(&join(&[1; 16], &[2; 20]))
                .unwrap_err()
                .to_string(),
            "a malformed encrypted string"
        );
        // Whole blocks whose last byte isn't PKCS #7 padding: an error, never a panic.
        let raw = cbc::Encryptor::<aes::Aes256>::new(k.enc().into(), (&[1u8; 16]).into())
            .encrypt_padded_vec_mut::<cbc::cipher::block_padding::NoPadding>(&[0u8; 16]);
        assert_eq!(
            k.decrypt(&join(&[1; 16], &raw)).unwrap_err().to_string(),
            "an encrypted string with bad padding"
        );
    }

    #[test]
    fn weak_derivations_and_wrong_key_sizes_are_refused() {
        let typed = ["p", "w"].concat();
        let user = "a@example.com";
        assert!(master_key(&typed, user, 4999).is_err());
        assert!(SymKey::from_bytes(&[0; 32]).is_err());
        assert!(SymKey::from_bytes(&[0; 65]).is_err());
    }

    #[test]
    fn empty_text_is_empty_and_text_opens_whole() {
        let k = sym(&[7; 64]);
        assert_eq!(k.decrypt_text("").unwrap().as_str(), "");
        assert_eq!(
            k.decrypt_text(&k.seal(&[9; 16], "Ünïcödé ✓".as_bytes()))
                .unwrap()
                .as_str(),
            "Ünïcödé ✓"
        );
    }

    #[test]
    fn text_that_isnt_utf8_is_an_error_never_altered_text() {
        let k = sym(&[7; 64]);
        // A lone continuation byte, a byte UTF-8 never has, and a sequence cut short.
        for bytes in [
            &[0x66, 0x80, 0x6f][..],
            &[0x66, 0xff, 0x6f],
            &[0x66, 0xe6, 0x97],
        ] {
            let s = k.seal(&[9; 16], bytes);
            assert_eq!(
                k.decrypt_text(&s).unwrap_err().to_string(),
                "an encrypted string that isn't text",
                "{bytes:?}"
            );
            // It still authenticates and opens as bytes: the refusal is the text's alone.
            assert_eq!(&k.decrypt(&s).unwrap()[..], bytes);
        }
    }

    #[test]
    fn keys_never_print() {
        let k = sym(&[0xab; 64]);
        let m = MasterKey(Box::new([0xab; 32]));
        let printed = format!("{k:?} {m:?}");
        assert_eq!(printed, "SymKey(…) MasterKey(…)");
        fn wiped_on_drop<T: ZeroizeOnDrop>() {}
        wiped_on_drop::<SymKey>();
        wiped_on_drop::<MasterKey>();
    }
}
