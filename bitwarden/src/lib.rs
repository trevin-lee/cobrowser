//! cobrowser's Bitwarden core, in WebAssembly. The companion app (app/bitwarden-source.js) talks
//! to the server; everything that touches a key is here, so the master key, the user key and
//! organizations' keys never become JavaScript values. What comes out is what the app's own
//! built-in vault holds while unlocked: items' values, to fill into pages. An authenticator key
//! never comes out: only its current code does.
//!
//! The user key leaves only through `exportKey`, for the app to keep in the macOS keychain
//! (Electron's safeStorage) so the vault unlocks with Touch ID without the master password.

use serde::Serialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

mod crypto;
pub mod totp;
mod vault;

/// A JavaScript value as JSON.
fn from_js(v: JsValue) -> Result<Value, JsError> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsError::new(&e.to_string()))
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsError::new(&e.to_string()))
}

fn err(e: anyhow::Error) -> JsError {
    JsError::new(&e.to_string())
}

/// Signing in, between the two requests: made from the password and prelogin's answer, it gives
/// the hash the token request sends, then opens the token's answer into an Account. The master
/// key stays in here.
#[wasm_bindgen]
pub struct SignIn(vault::SignIn);

#[wasm_bindgen]
impl SignIn {
    #[wasm_bindgen(constructor)]
    pub fn new(email: &str, password: &str, prelogin: JsValue) -> Result<SignIn, JsError> {
        vault::SignIn::new(email, password, &from_js(prelogin)?)
            .map(SignIn)
            .map_err(err)
    }

    #[wasm_bindgen(getter)]
    pub fn email(&self) -> String {
        self.0.email().to_string()
    }

    /// What the token request sends as its password.
    #[wasm_bindgen(getter)]
    pub fn hash(&self) -> String {
        self.0.hash().to_string()
    }

    /// The account, opened with the token's answer. The SignIn is used up.
    pub fn open(self, token: JsValue) -> Result<Account, JsError> {
        let user = self.0.open(&from_js(token)?).map_err(err)?;
        Ok(Account::with(user))
    }
}

/// An open account: its keys and the items of the last sync, in this module's memory only.
/// free() (or dropping it) wipes them: that's locking.
#[wasm_bindgen]
pub struct Account {
    user: crypto::SymKey,
    keys: vault::Keys,
    opened: vault::Opened,
}

impl Account {
    fn with(user: crypto::SymKey) -> Account {
        Account {
            user,
            keys: vault::Keys { orgs: Vec::new() },
            opened: vault::Opened::default(),
        }
    }

    fn login(&self, id: &str) -> Result<&vault::Login, JsError> {
        self.opened
            .logins
            .iter()
            .find(|l| l.common.id == id)
            .ok_or_else(|| JsError::new("there's no such login"))
    }
}

#[wasm_bindgen]
impl Account {
    /// An account from its user key, as `exportKey` gave it: unlocking without the master
    /// password. A sync must be loaded before it has any items.
    #[wasm_bindgen(js_name = fromKey)]
    pub fn from_key(bytes: &[u8]) -> Result<Account, JsError> {
        crypto::SymKey::from_bytes(bytes)
            .map(Account::with)
            .map_err(err)
    }

    /// The user key's 64 bytes, for the app to keep in the keychain.
    #[wasm_bindgen(js_name = exportKey)]
    pub fn export_key(&self) -> Vec<u8> {
        self.user.bytes().to_vec()
    }

    /// Opens a sync's answer (GET /api/sync) in place of the last: the organizations' keys and
    /// the items. Says how much it holds.
    pub fn load(&mut self, sync: JsValue) -> Result<JsValue, JsError> {
        let sync = from_js(sync)?;
        self.keys = vault::open_keys(&self.user, &sync).map_err(err)?;
        self.opened = vault::open_sync(&self.user, &self.keys, &sync).map_err(err)?;
        let orgs: Vec<Value> = self
            .keys
            .orgs
            .iter()
            .map(|(id, name, _)| json!({ "id": id, "name": name }))
            .collect();
        to_js(&json!({
            "logins": self.opened.logins.len(),
            "cards": self.opened.cards.len(),
            "unreadable": self.opened.unreadable,
            "organizations": orgs,
        }))
    }

    /// Every login and card, decrypted, for the app's vault. A login's authenticator key is left
    /// out: `hasTotp` says it has one, and `code` makes its current code.
    pub fn items(&self) -> Result<JsValue, JsError> {
        let logins: Vec<Value> = self
            .opened
            .logins
            .iter()
            .map(|l| {
                let mut v = serde_json::to_value(&l.common).unwrap_or(Value::Null);
                v["username"] = l.username.clone().into();
                v["password"] = l.password.clone().into();
                v["uris"] = l.uris.clone().into();
                v["matches"] = l.matches.clone().into();
                v["hasTotp"] = (!l.totp.is_empty()).into();
                v["passkeys"] = l.passkeys.into();
                v
            })
            .collect();
        to_js(&json!({ "logins": logins, "cards": &self.opened.cards }))
    }

    /// The folders and collections a new login can be saved to.
    pub fn places(&self) -> Result<JsValue, JsError> {
        to_js(&self.opened.places)
    }

    /// Whether a login fills into a page (its address), by Bitwarden's matching.
    #[wasm_bindgen(js_name = fillsOn)]
    pub fn fills_on(&self, id: &str, page: &str) -> Result<bool, JsError> {
        Ok(vault::fills_on(self.login(id)?, page))
    }

    /// A login's current one-time code, at a moment (Date.now()).
    pub fn code(&self, id: &str, unix_ms: f64) -> Result<JsValue, JsError> {
        let l = self.login(id)?;
        if l.totp.is_empty() {
            return Err(JsError::new("this login has no authenticator key"));
        }
        totp(&l.totp, unix_ms)
    }

    /// The request body for a new login, every value encrypted ({ name, username, password,
    /// uris, notes, and folderId, or organizationId and collectionId }). `random` is the app's
    /// own random bytes, `ivsNeeded(uris.length)` of them.
    #[wasm_bindgen(js_name = newLogin)]
    pub fn new_login(&self, login: JsValue, random: &[u8]) -> Result<JsValue, JsError> {
        let n: vault::NewLogin =
            serde_wasm_bindgen::from_value(login).map_err(|e| JsError::new(&e.to_string()))?;
        to_js(&vault::new_login(&self.user, &self.keys, &n, random).map_err(err)?)
    }
}

/// How many random bytes `newLogin` needs for a login with this many addresses.
#[wasm_bindgen(js_name = ivsNeeded)]
pub fn ivs_needed(uris: usize) -> usize {
    vault::ivs_needed(uris)
}

/// The crate's version, so a stale build is plain.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// A one-time code with how long it lasts.
#[derive(Serialize)]
struct CodeOut {
    code: String,
    left: u64,
    period: u64,
}

/// The code for an authenticator key at a moment (Date.now(), in milliseconds).
fn totp(secret: &str, unix_ms: f64) -> Result<JsValue, JsError> {
    if !unix_ms.is_finite() || unix_ms < 0.0 {
        return Err(JsError::new("the time isn't one"));
    }
    let c = totp::code(secret, unix_ms as u64).map_err(|e| JsError::new(&e))?;
    to_js(&CodeOut {
        code: c.code,
        left: c.left,
        period: c.period,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    /// The test vectors the web vault's own code made: JSON, hex-packed so secret scanners don't
    /// take its made-up accounts for credentials.
    pub(crate) fn vectors() -> serde_json::Value {
        let hex: Vec<u8> = include_str!("../tests/data/vault.hex")
            .bytes()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        let json: Vec<u8> = hex
            .chunks(2)
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect();
        serde_json::from_slice(&json).unwrap()
    }
}
