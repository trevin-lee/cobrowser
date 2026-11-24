//! A Bitwarden account's vault as cobrowser reads and writes it: signing in (the master key, the
//! hash the server checks, the user key it opens), the keys a sync carries (the account's RSA
//! key and each organization's key), the items of a sync decrypted (logins and cards, with their
//! notes and custom fields), and a new login encrypted for the server. The app does the network
//! and hands the answers here.

use crate::crypto::{
    MasterKey, PrivateKey, SymKey, master_key, master_key_argon2, password_hash, stretch,
};
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// A custom field of an item, decrypted. `hidden` is Bitwarden's hidden type (1), which cobrowser
/// fills but never shows; `boolean` is its checkbox type (2), whose value is "true" or "false".
#[derive(Default, Zeroize, ZeroizeOnDrop, Serialize, Clone)]
pub struct Field {
    pub name: String,
    pub value: String,
    pub hidden: bool,
    pub boolean: bool,
}

/// What every item has, decrypted: where it is kept and what's written about it.
#[derive(Default, Zeroize, ZeroizeOnDrop, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Common {
    pub id: String,
    pub name: String,
    pub notes: String,
    pub fields: Vec<Field>,
    /// The organization it's shared in, or empty for the account's own.
    pub organization_id: String,
    pub collection_ids: Vec<String>,
    pub folder_id: String,
    pub revision_date: String,
    /// Whether the account may change it (Bitwarden's "edit"; false in a read-only collection).
    pub edit: bool,
}

/// A login, decrypted. Its strings are wiped when it's dropped, and it prints only its id.
#[derive(Default, Zeroize, ZeroizeOnDrop)]
pub struct Login {
    pub common: Common,
    pub username: String,
    pub password: String,
    pub totp: String,
    pub uris: Vec<String>,
    /// How each of its addresses is matched (`matches[i]` for `uris[i]`), as set per website:
    /// Bitwarden's number, or `MATCH_DEFAULT` for none (null).
    pub matches: Vec<i64>,
    /// How many passkeys it holds. They're never opened here.
    pub passkeys: usize,
}

impl std::fmt::Debug for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Login")
            .field("id", &self.common.id)
            .finish_non_exhaustive()
    }
}

/// A payment card, decrypted.
#[derive(Default, Zeroize, ZeroizeOnDrop, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    #[serde(flatten)]
    pub common: Common,
    pub cardholder_name: String,
    pub brand: String,
    pub number: String,
    pub exp_month: String,
    pub exp_year: String,
    pub code: String,
}

impl std::fmt::Debug for Card {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Card")
            .field("id", &self.common.id)
            .finish_non_exhaustive()
    }
}

/// A folder or a collection, by name: where a new login can be saved.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    pub name: String,
    /// The organization a collection is in; empty for a folder.
    pub organization_id: String,
    /// Whether the account may add to it (always for a folder).
    pub writable: bool,
}

/// A field of the server's JSON, which has gone from PascalCase to camelCase across versions:
/// either is read.
fn field<'a>(o: &'a Value, name: &str) -> &'a Value {
    match o.get(name) {
        Some(v) => v,
        None => {
            let mut c = name.chars();
            let pascal: String = c
                .next()
                .map(|f| f.to_uppercase().chain(c).collect())
                .unwrap_or_default();
            o.get(&pascal).unwrap_or(&Value::Null)
        }
    }
}

fn str_field<'a>(o: &'a Value, name: &str) -> Option<&'a str> {
    field(o, name).as_str()
}

fn string(o: &Value, name: &str) -> String {
    str_field(o, name).unwrap_or_default().to_string()
}

fn list<'a>(o: &'a Value, name: &str) -> &'a [Value] {
    field(o, name)
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// A value decrypted as text; none, null or empty is empty.
fn open(key: &SymKey, v: &Value) -> Result<String> {
    match v.as_str() {
        Some(s) if !s.is_empty() => Ok(std::mem::take(&mut *key.decrypt_text(s)?)),
        _ => Ok(String::new()),
    }
}

/// The first half of signing in: the master key from the password, and the hash the server
/// checks, from the account's key derivation (prelogin's answer): PBKDF2-SHA256 or Argon2id.
pub struct SignIn {
    email: String,
    master: MasterKey,
    hash: Zeroizing<String>,
}

impl std::fmt::Debug for SignIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignIn")
            .field("email", &self.email)
            .finish_non_exhaustive()
    }
}

fn number(prelogin: &Value, name: &str) -> Result<u32> {
    field(prelogin, name)
        .as_u64()
        .and_then(|i| u32::try_from(i).ok())
        .ok_or_else(|| anyhow!("The server didn't say how this account's key is made."))
}

impl SignIn {
    pub fn new(email: &str, password: &str, prelogin: &Value) -> Result<SignIn> {
        let email = email.trim().to_lowercase();
        if email.is_empty() {
            bail!("Give the account's email.");
        }
        let master = match field(prelogin, "kdf").as_u64() {
            Some(0) => master_key(password, &email, number(prelogin, "kdfIterations")?)?,
            Some(1) => master_key_argon2(
                password,
                &email,
                number(prelogin, "kdfIterations")?,
                number(prelogin, "kdfMemory")?,
                number(prelogin, "kdfParallelism")?,
            )?,
            _ => bail!("This account makes its key in a way cobrowser doesn't know."),
        };
        let hash = password_hash(&master, password);
        Ok(SignIn {
            email,
            master,
            hash,
        })
    }

    pub fn email(&self) -> &str {
        &self.email
    }

    /// What the token request sends as the password. It stands in for the password.
    pub fn hash(&self) -> &str {
        &self.hash
    }

    /// The second half: the user key, from the token's answer ("Key", the user key encrypted with
    /// the stretched master key). A wrong one means the password wasn't the account's.
    pub fn open(self, token: &Value) -> Result<SymKey> {
        stretch(&self.master)
            .decrypt(str_field(token, "key").unwrap_or_default())
            .and_then(|b| SymKey::from_bytes(&b))
            .map_err(|_| anyhow!("The master password isn't this account's."))
    }
}

/// The keys a sync carries, opened with the user key: each organization the account is a
/// confirmed member of, by id, with its name.
pub struct Keys {
    pub orgs: Vec<(String, String, SymKey)>,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keys")
            .field("orgs", &self.orgs.len())
            .finish()
    }
}

/// A Bitwarden membership's status: confirmed is the one whose key the member holds.
const CONFIRMED: u64 = 2;

/// The organizations' keys, from the sync's profile. An organization's key comes encrypted to
/// the account's RSA key (sent by whoever let the account in), or with the user key itself (the
/// account made the organization). One that doesn't open is left out, with the rest still read.
pub fn open_keys(user: &SymKey, sync: &Value) -> Result<Keys> {
    let profile = field(sync, "profile");
    let private = match str_field(profile, "privateKey").filter(|k| !k.is_empty()) {
        Some(k) => Some(PrivateKey::from_der(&user.decrypt(k).map_err(|_| {
            anyhow!("The account's private key doesn't open with its user key.")
        })?)?),
        None => None,
    };
    let mut orgs = Vec::new();
    for o in list(profile, "organizations") {
        if field(o, "status").as_u64() != Some(CONFIRMED) {
            continue;
        }
        let Some(sealed) = str_field(o, "key").filter(|k| !k.is_empty()) else {
            continue;
        };
        let bytes = if sealed.starts_with("2.") {
            user.decrypt(sealed)
        } else {
            match &private {
                Some(p) => p.decrypt(sealed),
                None => continue,
            }
        };
        if let Ok(key) = bytes.and_then(|b| SymKey::from_bytes(&b)) {
            orgs.push((string(o, "id"), string(o, "name"), key));
        }
    }
    Ok(Keys { orgs })
}

impl Keys {
    fn org(&self, id: &str) -> Option<&SymKey> {
        self.orgs.iter().find(|(o, _, _)| o == id).map(|(_, _, k)| k)
    }
}

/// An item's key: its organization's, or the user key for the account's own, or its own key
/// (newer items carry one, encrypted with either).
fn item_key<'a>(
    user: &'a SymKey,
    keys: &'a Keys,
    c: &Value,
    own: &'a mut Option<SymKey>,
) -> Result<&'a SymKey> {
    let base = match str_field(c, "organizationId").filter(|o| !o.is_empty()) {
        Some(id) => keys
            .org(id)
            .ok_or_else(|| anyhow!("an item of an organization whose key isn't here"))?,
        None => user,
    };
    match str_field(c, "key").filter(|k| !k.is_empty()) {
        Some(k) => {
            *own = Some(SymKey::from_bytes(&base.decrypt(k)?)?);
            Ok(own.as_ref().expect("just set"))
        }
        None => Ok(base),
    }
}

fn open_common(key: &SymKey, c: &Value) -> Result<Common> {
    let mut fields = Vec::new();
    for f in list(c, "fields") {
        let kind = field(f, "type").as_u64().unwrap_or(0);
        if kind == 3 {
            continue; // linked: it names another of the item's values, holds none
        }
        fields.push(Field {
            name: open(key, field(f, "name"))?,
            value: open(key, field(f, "value"))?,
            hidden: kind == 1,
            boolean: kind == 2,
        });
    }
    Ok(Common {
        id: string(c, "id"),
        name: open(key, field(c, "name"))?,
        notes: open(key, field(c, "notes"))?,
        fields,
        organization_id: string(c, "organizationId"),
        collection_ids: list(c, "collectionIds")
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        folder_id: string(c, "folderId"),
        revision_date: string(c, "revisionDate"),
        edit: field(c, "edit").as_bool().unwrap_or(true),
    })
}

fn open_login(key: &SymKey, c: &Value) -> Result<Login> {
    let l = field(c, "login");
    let mut login = Login::default();
    login.common = open_common(key, c)?;
    login.username = open(key, field(l, "username"))?;
    login.password = open(key, field(l, "password"))?;
    login.totp = open(key, field(l, "totp"))?;
    login.passkeys = list(l, "fido2Credentials").len();
    for u in list(l, "uris") {
        let uri = open(key, field(u, "uri"))?;
        if !uri.is_empty() {
            login.uris.push(uri);
            login
                .matches
                .push(field(u, "match").as_i64().unwrap_or(MATCH_DEFAULT));
        }
    }
    Ok(login)
}

fn open_card(key: &SymKey, c: &Value) -> Result<Card> {
    let d = field(c, "card");
    Ok(Card {
        common: open_common(key, c)?,
        cardholder_name: open(key, field(d, "cardholderName"))?,
        brand: open(key, field(d, "brand"))?,
        number: open(key, field(d, "number"))?,
        exp_month: open(key, field(d, "expMonth"))?,
        exp_year: open(key, field(d, "expYear"))?,
        code: open(key, field(d, "code"))?,
    })
}

/// What a sync holds, decrypted: its logins and cards (not in the trash), and the folders and
/// collections a new login can be saved to.
#[derive(Default)]
pub struct Opened {
    pub logins: Vec<Login>,
    pub cards: Vec<Card>,
    pub places: Vec<Place>,
    /// Items that didn't open (an organization's key missing, a damaged value): counted, never
    /// guessed at.
    pub unreadable: usize,
}

const LOGIN: u64 = 1;
const CARD: u64 = 3;

/// The items of a sync, decrypted with the user key and the organizations' keys.
pub fn open_sync(user: &SymKey, keys: &Keys, sync: &Value) -> Result<Opened> {
    let mut out = Opened::default();
    for c in list(sync, "ciphers") {
        if !field(c, "deletedDate").is_null() {
            continue;
        }
        let kind = field(c, "type").as_u64();
        if kind != Some(LOGIN) && kind != Some(CARD) {
            continue;
        }
        let mut own = None;
        let opened = item_key(user, keys, c, &mut own).and_then(|k| {
            if kind == Some(LOGIN) {
                open_login(k, c).map(|l| out.logins.push(l))
            } else {
                open_card(k, c).map(|d| out.cards.push(d))
            }
        });
        if opened.is_err() {
            out.unreadable += 1;
        }
    }
    out.logins
        .sort_by_cached_key(|l| l.common.name.to_lowercase());
    out.cards.sort_by_cached_key(|c| c.common.name.to_lowercase());
    for f in list(sync, "folders") {
        if let Ok(name) = open(user, field(f, "name")) {
            out.places.push(Place {
                id: string(f, "id"),
                name,
                organization_id: String::new(),
                writable: true,
            });
        }
    }
    for c in list(sync, "collections") {
        let org = string(c, "organizationId");
        let Some(key) = keys.org(&org) else { continue };
        if let Ok(name) = open(key, field(c, "name")) {
            out.places.push(Place {
                id: string(c, "id"),
                name,
                organization_id: org,
                writable: !field(c, "readOnly").as_bool().unwrap_or(false),
            });
        }
    }
    Ok(out)
}

/// A new login as the app asks for one: where it goes (a folder of the account's own, or a
/// collection of an organization) and what it holds. The app made its values, and keeps them
/// itself, so they aren't wiped here.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewLogin {
    pub name: String,
    pub username: String,
    pub password: String,
    pub uris: Vec<String>,
    pub notes: String,
    pub organization_id: String,
    pub collection_id: String,
    pub folder_id: String,
    /// Custom fields: text (0), hidden (1) or a checkbox (2, its value "true" or "false").
    pub fields: Vec<NewField>,
}

/// A custom field of a new login.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewField {
    pub name: String,
    pub value: String,
    #[serde(rename = "type")]
    pub kind: u8,
}

/// The request body for a new login, every value encrypted: for POST /api/ciphers (the account's
/// own) or, with `collectionIds`, POST /api/ciphers/create (an organization's). `random` gives
/// the IVs, 16 bytes for each value sealed (the app's own randomness); too few is an error.
pub fn new_login(user: &SymKey, keys: &Keys, n: &NewLogin, random: &[u8]) -> Result<Value> {
    let key = if n.organization_id.is_empty() {
        user
    } else {
        keys.org(&n.organization_id)
            .ok_or_else(|| anyhow!("That organization isn't one this account is in."))?
    };
    let mut ivs = random.chunks_exact(16);
    let mut seal = |plain: &str| -> Result<Value> {
        if plain.is_empty() {
            return Ok(Value::Null);
        }
        let iv: &[u8; 16] = ivs
            .next()
            .ok_or_else(|| anyhow!("not enough random bytes to encrypt the login"))?
            .try_into()
            .expect("chunks of 16");
        Ok(Value::String(key.seal(iv, plain.as_bytes())))
    };
    if n.name.trim().is_empty() {
        bail!("A login needs a name.");
    }
    let fields: Vec<Value> = n
        .fields
        .iter()
        .filter(|f| !f.name.trim().is_empty())
        .map(|f| {
            if f.kind > 2 {
                bail!("a field's type is text (0), hidden (1) or a checkbox (2)");
            }
            Ok(json!({ "name": seal(f.name.trim())?, "value": seal(&f.value)?, "type": f.kind }))
        })
        .collect::<Result<_>>()?;
    let uris: Vec<Value> = n
        .uris
        .iter()
        .filter(|u| !u.trim().is_empty())
        .map(|u| Ok(json!({ "uri": seal(u.trim())?, "match": Value::Null })))
        .collect::<Result<_>>()?;
    let cipher = json!({
        "type": LOGIN,
        "name": seal(n.name.trim())?,
        "notes": seal(&n.notes)?,
        "favorite": false,
        "reprompt": 0,
        "fields": fields,
        "folderId": if n.folder_id.is_empty() { Value::Null } else { Value::String(n.folder_id.clone()) },
        "organizationId": if n.organization_id.is_empty() { Value::Null } else { Value::String(n.organization_id.clone()) },
        "login": {
            "username": seal(&n.username)?,
            "password": seal(&n.password)?,
            "totp": Value::Null,
            "uris": uris,
        },
    });
    Ok(if n.organization_id.is_empty() {
        cipher
    } else {
        if n.collection_id.is_empty() {
            bail!("A login saved in an organization needs one of its collections.");
        }
        json!({ "cipher": cipher, "collectionIds": [n.collection_id] })
    })
}

/// The random bytes `new_login` takes, 16 for each value it may seal: name, notes, username,
/// password, each address, and each field's name and value.
pub fn ivs_needed(n_uris: usize, n_fields: usize) -> usize {
    16 * (4 + n_uris + 2 * n_fields)
}

/// A login address's match, as Bitwarden numbers them: none set (null), base domain, host,
/// starts with, exact, regular expression, never.
pub const MATCH_DEFAULT: i64 = -1;
pub const MATCH_BASE_DOMAIN: i64 = 0;
pub const MATCH_NEVER: i64 = 5;

/// A saved address, or a site named in words: one written without a scheme is https's, but only
/// a bare host, so mailto:sam@account.example isn't account.example.
fn parse(raw: &str) -> Option<url::Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.contains("://") {
        return checked(raw);
    }
    if raw.split('/').next().unwrap_or("").contains('@') {
        return None;
    }
    checked(&format!("https://{raw}"))
}

/// A page's address, which always has its scheme: about:blank, mailto: or anything else
/// without one is no site, never taken for https.
fn parse_page(raw: &str) -> Option<url::Url> {
    let raw = raw.trim();
    if !raw.contains("://") {
        return None;
    }
    checked(raw)
}

/// An http or https address whose host is as written: none with a trailing dot (amazon.com.),
/// and an IPv4 address only as four plain decimals. The url crate reads 0x0a.0.0.5, 010.0.0.5
/// and 167772165 as IP addresses, which browsers' address bars don't agree on: none is guessed.
fn checked(raw: &str) -> Option<url::Url> {
    let parsed = url::Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let written = written_host(raw)?.to_ascii_lowercase();
    if written.ends_with('.') {
        return None;
    }
    if let Some(url::Host::Ipv4(ip)) = parsed.host()
        && written != ip.to_string()
    {
        return None;
    }
    Some(parsed)
}

/// The host as an absolute address writes it: after "://" and any user, before its port, path,
/// query or fragment.
fn written_host(raw: &str) -> Option<&str> {
    let rest = raw.split_once("://")?.1;
    let authority = rest.split(['/', '\\', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if host.starts_with('[') {
        return Some(host.split_once(']').map_or(host, |(h, _)| h));
    }
    Some(host.rsplit_once(':').map_or(host, |(h, _)| h))
}

/// A page's origin, for a page's address only (`parse_page`): where a fill may land.
#[cfg(test)]
fn page_origin(raw: &str) -> Option<String> {
    origin_of(&parse_page(raw)?)
}

#[cfg(test)]
fn origin_of(parsed: &url::Url) -> Option<String> {
    let host = parsed.host_str()?.to_lowercase();
    Some(match parsed.port() {
        Some(p) => format!("{}://{host}:{p}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}

/// Where a page or a login's address is, as a fill compares them: its scheme, host and port
/// (the scheme's own when none is written), and its registrable domain (shop.example for
/// www.shop.example, by the public suffix list; the host itself for an IP address or a public
/// suffix).
struct Site {
    scheme: String,
    host: String,
    port: u16,
    base: String,
    /// Whether the host is a registrable domain itself (shop.example, not github.io or an IP).
    apex: bool,
}

fn site(raw: &str) -> Option<Site> {
    site_of(&parse(raw)?)
}

fn page_site(raw: &str) -> Option<Site> {
    site_of(&parse_page(raw)?)
}

fn site_of(parsed: &url::Url) -> Option<Site> {
    let (host, base, apex) = match parsed.host()? {
        url::Host::Domain(d) => {
            let d = d.to_lowercase();
            let registrable = psl::domain_str(&d).map(str::to_string);
            let apex = registrable.as_deref() == Some(d.as_str());
            (d.clone(), registrable.unwrap_or(d), apex)
        }
        _ => {
            let ip = parsed.host_str()?.to_string();
            (ip.clone(), ip, false)
        }
    };
    Some(Site {
        scheme: parsed.scheme().to_string(),
        port: parsed.port_or_known_default()?,
        host,
        base,
        apex,
    })
}

/// Whether one of a login's addresses, with the match set on it, fills into a page. Always only
/// with the address's own scheme and port, never an https login into an http page. Then by its
/// match: none set, as Bitwarden's default, any host of the same registrable domain over https
/// (proton.me and account.proton.me; never across a public suffix: foo.github.io isn't
/// bar.github.io, and github.io itself or an IP address is only itself), and for an http address
/// only its own host or its www twin (shop.example and www.shop.example); Base domain, any host
/// of the same registrable domain, http too; Never, nowhere; anything else (host, starts with,
/// exact, a regular expression, which is never run), the address's exact host. Held to
/// tests/data/vault-match.json, its "extension" column.
fn fills_at(raw: &str, m: i64, p: &Site) -> bool {
    let Some(s) = site(raw) else {
        return false;
    };
    if m == MATCH_NEVER || s.scheme != p.scheme || s.port != p.port {
        return false;
    }
    match m {
        MATCH_DEFAULT => {
            s.host == p.host
                || (p.host == format!("www.{}", s.host) && s.apex)
                || (s.host == format!("www.{}", p.host) && p.apex)
                || (s.scheme == "https" && s.base == p.base)
        }
        MATCH_BASE_DOMAIN => s.base == p.base,
        _ => s.host == p.host,
    }
}

/// Whether a login may be filled into a page: one of its addresses fills there (`fills_at`).
pub fn fills_on(login: &Login, page: &str) -> bool {
    page_site(page).is_some_and(|p| {
        login.uris.iter().enumerate().any(|(i, u)| {
            fills_at(
                u,
                login.matches.get(i).copied().unwrap_or(MATCH_DEFAULT),
                &p,
            )
        })
    })
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::vectors;
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    /// The web vault's own test vault (vault.hex), made by its code: its account signs in to the
    /// same hash and user key, and its sync opens to the same logins and card. The items it can't
    /// open (another organization's, one sealed with the wrong key) are counted, not guessed.
    #[test]
    fn signs_in_and_opens_the_webs_vault() {
        let v = &vectors()["vault"];
        let pre = json!({ "kdf": 0, "kdfIterations": v["iterations"] });
        let s = SignIn::new(
            v["user"].as_str().unwrap(),
            v["typed"].as_str().unwrap(),
            &pre,
        )
        .unwrap();
        assert_eq!(s.hash(), v["hash"].as_str().unwrap());
        let user = s.open(&json!({ "Key": v["sealedUser"] })).unwrap();
        let keys = open_keys(&user, &v["sync"]).unwrap();
        assert!(keys.org(v["orgId"].as_str().unwrap()).is_some());
        let opened = open_sync(&user, &keys, &v["sync"]).unwrap();
        let want: Vec<&Value> = v["entries"].as_array().unwrap().iter().collect();
        let logins: Vec<&&Value> = want.iter().filter(|e| e["kind"] == "login").collect();
        assert_eq!(opened.logins.len(), logins.len());
        assert_eq!(opened.unreadable, 2, "another organization's item and a wrongly sealed one");
        for w in logins {
            let l = opened
                .logins
                .iter()
                .find(|l| l.common.id == w["id"].as_str().unwrap())
                .unwrap();
            assert_eq!(
                (
                    l.common.name.as_str(),
                    l.username.as_str(),
                    l.password.as_str(),
                    l.totp.as_str()
                ),
                (
                    w["name"].as_str().unwrap(),
                    w["username"].as_str().unwrap(),
                    w["password"].as_str().unwrap(),
                    w["totp"].as_str().unwrap()
                )
            );
            let uris: Vec<&str> = w["uris"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u.as_str().unwrap())
                .collect();
            assert_eq!(l.uris, uris);
        }
        let card = want.iter().find(|e| e["kind"] == "card").unwrap();
        let c = opened
            .cards
            .iter()
            .find(|c| c.common.id == card["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            (c.cardholder_name.as_str(), c.number.as_str(), c.exp_month.as_str(), c.exp_year.as_str(), c.code.as_str()),
            (
                card["holder"].as_str().unwrap(),
                card["number"].as_str().unwrap(),
                card["expMonth"].as_str().unwrap(),
                card["expYear"].as_str().unwrap(),
                card["code"].as_str().unwrap()
            )
        );
        // The user key is the web's: what the web's key seals, it opens.
        let theirs =
            SymKey::from_bytes(&STANDARD.decode(v["userBytes"].as_str().unwrap()).unwrap())
                .unwrap();
        assert_eq!(&user.decrypt(&theirs.seal(&[1; 16], b"x")).unwrap()[..], b"x");
    }

    #[test]
    fn a_wrong_password_and_weak_derivations_are_refused() {
        let v = &vectors()["vault"];
        let pre = json!({ "kdf": 0, "kdfIterations": v["iterations"] });
        // Put together from parts so no scanner reads the line as a credential.
        let typed = ["not", "it"].concat();
        let wrong = SignIn::new(v["user"].as_str().unwrap(), &typed, &pre).unwrap();
        assert_ne!(wrong.hash(), v["hash"].as_str().unwrap());
        assert!(wrong.open(&json!({ "Key": v["sealedUser"] })).is_err());
        assert!(SignIn::new("a@example.com", "x", &json!({ "kdf": 0, "kdfIterations": 100 })).is_err());
        assert!(SignIn::new("a@example.com", "x", &json!({ "kdf": 1, "kdfIterations": 1, "kdfMemory": 64, "kdfParallelism": 4 })).is_err());
        assert!(SignIn::new("a@example.com", "x", &json!({ "kdf": 7 })).is_err());
        assert!(SignIn::new(" ", "x", &pre).is_err());
    }

    /// Argon2id, Bitwarden's SDK vector (crates/bitwarden-crypto/src/keys/kdf.rs,
    /// test_master_key_derive_argon2): the same key from the same password, salt and settings.
    #[test]
    fn argon2id_master_key_matches_bitwardens() {
        let typed = ["67t9b5g67", "$%", "Dh89n"].concat();
        let salt = ["test", "_k", "ey"].concat();
        let m = crate::crypto::master_key_argon2(&typed, &salt, 4, 32, 2).unwrap();
        let s = SignIn::new(&salt, &typed, &json!({ "kdf": 1, "kdfIterations": 4, "kdfMemory": 32, "kdfParallelism": 2 })).unwrap();
        assert_eq!(s.hash(), password_hash(&m, &typed).as_str());
        assert_eq!(
            crate::crypto::tests_master_bytes(&m),
            [
                207, 240, 225, 177, 162, 19, 163, 76, 98, 106, 179, 175, 224, 9, 17, 240, 20, 147,
                237, 47, 246, 150, 141, 184, 62, 225, 131, 242, 51, 53, 225, 242
            ]
        );
    }

    fn seal(k: &SymKey, plain: &str) -> Value {
        Value::String(k.seal(&[5; 16], plain.as_bytes()))
    }

    /// A member someone else let into their organization: its key comes encrypted to the
    /// member's RSA public key (type 4), and the member's private key is in the profile, sealed
    /// with the user key. The organization's items, a card and an item with a key of its own,
    /// open; custom fields keep their kind; a trashed item and a secure note aren't listed.
    #[test]
    fn opens_an_organization_shared_with_the_account() {
        use rsa::pkcs8::EncodePrivateKey as _;
        let mut rng = rand::thread_rng();
        let private = rsa::RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let public = rsa::RsaPublicKey::from(&private);
        let user = SymKey::from_bytes(&[7; 64]).unwrap();
        let org_bytes = [9u8; 64];
        let org = SymKey::from_bytes(&org_bytes).unwrap();
        let item_bytes = [4u8; 64];
        let item = SymKey::from_bytes(&item_bytes).unwrap();
        let sealed_org = public
            .encrypt(&mut rng, rsa::Oaep::new::<sha1::Sha1>(), &org_bytes)
            .unwrap();
        let der = private.to_pkcs8_der().unwrap();
        let sync = json!({
            "profile": {
                "privateKey": user.seal(&[1; 16], der.as_bytes()),
                "organizations": [
                    { "id": "org-1", "name": "Family", "status": 2, "key": format!("4.{}", STANDARD.encode(&sealed_org)) },
                    { "id": "org-2", "name": "Invited", "status": 1, "key": null },
                ],
            },
            "folders": [{ "id": "f-1", "name": seal(&user, "Work") }],
            "collections": [
                { "id": "c-1", "organizationId": "org-1", "name": seal(&org, "Shared"), "readOnly": true },
                { "id": "c-2", "organizationId": "org-1", "name": seal(&org, "Mine"), "readOnly": false },
            ],
            "ciphers": [
                { "id": "l-1", "type": 1, "organizationId": "org-1", "collectionIds": ["c-1"], "name": seal(&org, "Bank"), "notes": seal(&org, "call first"),
                  "fields": [
                      { "name": seal(&org, "Q: First pet"), "value": seal(&org, "Rex"), "type": 1 },
                      { "name": seal(&org, "Share notes with agents"), "value": seal(&org, "true"), "type": 2 },
                      { "name": seal(&org, "linked"), "value": null, "type": 3, "linkedId": 100 },
                  ],
                  "login": { "username": seal(&org, "sam"), "password": seal(&org, "pw"), "uris": [{ "uri": seal(&org, "https://bank.example"), "match": 1 }] } },
                { "id": "l-2", "type": 1, "organizationId": "org-1", "key": org.seal(&[2; 16], &item_bytes), "name": seal(&item, "Keyed"),
                  "login": { "username": seal(&item, "kim"), "password": seal(&item, "pw2") } },
                { "id": "l-3", "type": 1, "organizationId": null, "folderId": "f-1", "name": seal(&user, "Own"), "login": { "username": seal(&user, "me") } },
                { "id": "l-4", "type": 1, "organizationId": "org-1", "deletedDate": "2026-01-01", "name": seal(&org, "Trashed"), "login": {} },
                { "id": "n-1", "type": 2, "organizationId": "org-1", "name": seal(&org, "Note") },
                { "id": "c-9", "type": 3, "organizationId": "org-1", "name": seal(&org, "Visa"), "card": { "cardholderName": seal(&org, "Sam Lee"), "number": seal(&org, "4111111111111111"), "expMonth": seal(&org, "3"), "expYear": seal(&org, "2029"), "code": seal(&org, "123") } },
            ],
        });
        let keys = open_keys(&user, &sync).unwrap();
        assert_eq!(keys.orgs.len(), 1, "only the confirmed membership");
        let o = open_sync(&user, &keys, &sync).unwrap();
        let names: Vec<&str> = o.logins.iter().map(|l| l.common.name.as_str()).collect();
        assert_eq!(names, ["Bank", "Keyed", "Own"]);
        assert_eq!(o.unreadable, 0);
        let bank = &o.logins[0];
        assert_eq!((bank.username.as_str(), bank.password.as_str(), bank.common.notes.as_str()), ("sam", "pw", "call first"));
        assert_eq!(bank.matches, [1]);
        assert_eq!(bank.common.collection_ids, ["c-1"]);
        assert_eq!(bank.common.fields.len(), 2, "a linked field holds no value");
        assert!(bank.common.fields[0].hidden && !bank.common.fields[0].boolean);
        assert!(bank.common.fields[1].boolean && bank.common.fields[1].value == "true");
        assert_eq!(o.logins[1].password, "pw2");
        assert_eq!(o.logins[2].common.folder_id, "f-1");
        assert_eq!(o.cards.len(), 1);
        assert_eq!((o.cards[0].number.as_str(), o.cards[0].code.as_str()), ("4111111111111111", "123"));
        assert_eq!(
            o.places,
            [
                Place { id: "f-1".into(), name: "Work".into(), organization_id: "".into(), writable: true },
                Place { id: "c-1".into(), name: "Shared".into(), organization_id: "org-1".into(), writable: false },
                Place { id: "c-2".into(), name: "Mine".into(), organization_id: "org-1".into(), writable: true },
            ]
        );
    }

    /// A new login, sealed for the server, opens back to what was asked for: in the account's own
    /// vault with a folder, and in an organization's collection with that organization's key.
    #[test]
    fn a_new_login_opens_back_to_itself() {
        let user = SymKey::from_bytes(&[7; 64]).unwrap();
        let org = SymKey::from_bytes(&[9; 64]).unwrap();
        let keys = Keys { orgs: vec![("org-1".into(), "Family".into(), org)] };
        let random: Vec<u8> = (0..ivs_needed(2, 1)).map(|i| i as u8).collect();
        let mut n = NewLogin {
            name: "Shop".into(),
            username: "sam".into(),
            password: "Xq9-secret".into(),
            uris: vec!["https://shop.example/login".into(), " ".into(), "shop.example".into()],
            notes: "made by an agent".into(),
            folder_id: "f-1".into(),
            fields: vec![NewField { name: "Share notes with agents".into(), value: "true".into(), kind: 2 }],
            ..NewLogin::default()
        };
        let mine = new_login(&user, &keys, &n, &random).unwrap();
        assert_eq!(mine["folderId"], "f-1");
        assert!(!mine.to_string().contains("Xq9-secret"));
        let mut back = mine.clone();
        back["id"] = "new-1".into();
        let l = open_login(&user, &back).unwrap();
        assert_eq!(
            (l.common.name.as_str(), l.username.as_str(), l.password.as_str(), l.common.notes.as_str()),
            ("Shop", "sam", "Xq9-secret", "made by an agent")
        );
        assert_eq!(l.uris, ["https://shop.example/login", "shop.example"]);
        assert_eq!(l.matches, [MATCH_DEFAULT, MATCH_DEFAULT]);
        assert_eq!(l.common.fields.len(), 1);
        assert!(l.common.fields[0].boolean && l.common.fields[0].value == "true");

        n.folder_id = String::new();
        n.organization_id = "org-1".into();
        assert!(new_login(&user, &keys, &n, &random).is_err(), "an organization's login needs a collection");
        n.collection_id = "c-2".into();
        let shared = new_login(&user, &keys, &n, &random).unwrap();
        assert_eq!(shared["collectionIds"], json!(["c-2"]));
        let mut back = shared["cipher"].clone();
        back["id"] = "new-2".into();
        let keys2 = Keys { orgs: vec![("org-1".into(), "Family".into(), SymKey::from_bytes(&[9; 64]).unwrap())] };
        let mut own = None;
        let k = item_key(&user, &keys2, &back, &mut own).unwrap();
        assert_eq!(open_login(k, &back).unwrap().password, "Xq9-secret");
        assert!(open_login(&user, &back).is_err(), "sealed with the organization's key, not the user's");

        assert!(new_login(&user, &keys, &n, &random[..20]).is_err(), "too few random bytes");
        n.organization_id = "org-9".into();
        assert!(new_login(&user, &keys, &n, &random).is_err(), "not one of the account's organizations");
    }

    fn made(
        id: &str,
        name: &str,
        username: &str,
        password: &str,
        totp: &str,
        uris: &[&str],
    ) -> Login {
        let mut l = Login::default();
        (l.common.id, l.common.name, l.username, l.password, l.totp) = (
            id.into(),
            name.into(),
            username.into(),
            password.into(),
            totp.into(),
        );
        l.uris = uris.iter().map(|u| u.to_string()).collect();
        l
    }

    fn login(uris: &[&str]) -> Login {
        made("1", "Shop", "sam", "pw", "", uris)
    }

    /// A login with no match set fills on any host of its domain over https, on the port it's
    /// saved for; an http one only on its own host. Every match is in
    /// `fills_by_the_shared_table`.
    #[test]
    fn fills_only_on_its_domain_and_port() {
        let l = login(&[
            "https://shop.example/login",
            "https://accounts.shop.example:8443/",
        ]);
        for (page, fills) in [
            ("https://shop.example/", true),
            ("https://shop.example/cart?x=1", true),
            ("https://SHOP.example/", true),
            ("https://shop.example:443/", true),
            ("https://accounts.shop.example:8443/signin", true),
            ("https://accounts.shop.example/signin", true),
            ("http://shop.example/", false),
            ("https://www.shop.example/", true),
            ("https://other.shop.example/", true),
            ("https://other.shop.example:8443/", true),
            ("https://other.shop.example:9443/", false),
            ("https://shop.example.evil.example/", false),
            // The second address's port, on its domain.
            ("https://shop.example:8443/", true),
            ("https://shop.example:9443/", false),
            ("file:///shop.example/", false),
            ("javascript:alert(1)", false),
            ("", false),
        ] {
            assert_eq!(fills_on(&l, page), fills, "{page}");
        }
        // A saved address without a scheme is https's.
        assert!(fills_on(&login(&["shop.example"]), "https://shop.example/"));
        assert!(!fills_on(&login(&["shop.example"]), "http://shop.example/"));
        // An http login fills only into the http page.
        assert!(fills_on(
            &login(&["http://intranet.example"]),
            "http://intranet.example/"
        ));
        assert!(!fills_on(
            &login(&["http://intranet.example"]),
            "https://intranet.example/"
        ));
    }

    /// The shared match table (tests/data/vault-match.json), its "extension" column: Bitwarden's
    /// default for an address with no match set. Where an address fills, by its match, and that a
    /// fill may land only on the page's own origin.
    #[test]
    fn fills_by_the_shared_table() {
        let table: Value = serde_json::from_str(include_str!(
            "../tests/data/vault-match.json"
        ))
        .unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(cases.len() >= 40);
        for c in cases {
            let s = |k: &str| c[k].as_str().unwrap_or("").to_string();
            let mut l = made("1", "Login", "sam", "pw-123", "", &[&s("uri")]);
            l.matches = vec![c["match"].as_i64().unwrap_or(MATCH_DEFAULT)];
            let want = c["extension"].as_bool().unwrap();
            assert_eq!(fills_on(&l, &s("page")), want, "{}", s("why"));
            if want {
                assert_eq!(page_origin(&s("page")).unwrap_or_default(), s("origin"), "{}", s("why"));
            }
        }
        // Each address by its own match: the second has none.
        let mut l = login(&["https://amazon.com", "https://shop.example"]);
        l.matches = vec![MATCH_BASE_DOMAIN];
        assert!(fills_on(&l, "https://smile.amazon.com/"));
        assert!(fills_on(&l, "https://www.shop.example/"));
        assert!(!fills_on(&l, "http://accounts.shop.example/"));
    }

}
