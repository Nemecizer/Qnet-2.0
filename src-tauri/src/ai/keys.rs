//! API keys (LLMBackend.swift `LLMKeychain`; PARITY §6.17, AI-092): one generic-password item per
//! provider in the macOS login Keychain, under 0.90.34's own names — service `com.bnetgui.ai`,
//! account the provider id — so a key saved in 0.90.34 is found by 2.0 and the other way round.
//! (macOS asks once before a different app reads an item: "Always Allow" settles it.)
//!
//! Saving a key updates the item in place (or adds it); saving an empty key deletes it. 0.90.34
//! deleted the old item and then added the new one, so a failed add (Keychain locked, access
//! refused) lost the key that had been working; 2.0 never deletes before a write (SET-214, Changed).
//! Tests use `MemoryKeys`; nothing but `Keychain` touches the real Keychain.

#[cfg(test)]
use std::{collections::HashMap, sync::Mutex};

use super::Provider;

/// 0.90.34's Keychain service name (`LLMKeychain.service`).
pub const SERVICE: &str = "com.bnetgui.ai";

pub trait KeyStore: Send + Sync {
    /// The stored key, or "" when there is none (as `LLMKeychain.load` answers).
    fn load(&self, provider: Provider) -> Result<String, String>;
    /// Replaces the stored key; an empty one removes it.
    fn save(&self, provider: Provider, key: &str) -> Result<(), String>;
}

/// The macOS Keychain.
pub struct Keychain;

#[cfg(target_os = "macos")]
mod mac {
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    use super::{KeyStore, Keychain, Provider, SERVICE};

    /// errSecItemNotFound.
    const NOT_FOUND: i32 = -25300;

    impl KeyStore for Keychain {
        fn load(&self, provider: Provider) -> Result<String, String> {
            match get_generic_password(SERVICE, provider.id()) {
                // An item that is not text reads as no key, as 0.90.34 read it.
                Ok(bytes) => Ok(String::from_utf8(bytes).unwrap_or_default()),
                Err(e) if e.code() == NOT_FOUND => Ok(String::new()),
                Err(e) => Err(e.to_string()),
            }
        }

        fn save(&self, provider: Provider, key: &str) -> Result<(), String> {
            if key.is_empty() {
                return match delete_generic_password(SERVICE, provider.id()) {
                    Ok(()) => Ok(()),
                    Err(e) if e.code() == NOT_FOUND => Ok(()),
                    Err(e) => Err(e.to_string()),
                };
            }
            // Updates the existing item or adds one: if it fails, the old key is still there.
            set_generic_password(SERVICE, provider.id(), key.as_bytes()).map_err(|e| e.to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl KeyStore for Keychain {
    fn load(&self, _: Provider) -> Result<String, String> {
        Ok(String::new())
    }

    fn save(&self, _: Provider, _: &str) -> Result<(), String> {
        Err("API keys are kept in the macOS Keychain.".into())
    }
}

/// Keys in memory, for tests. `writes` records each set and delete, in order; `refuse_writes`
/// makes every write fail, as a locked Keychain would.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryKeys {
    pub items: Mutex<HashMap<&'static str, String>>,
    pub writes: Mutex<Vec<String>>,
    pub refuse_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl KeyStore for MemoryKeys {
    fn load(&self, provider: Provider) -> Result<String, String> {
        Ok(self.items.lock().unwrap().get(provider.id()).cloned().unwrap_or_default())
    }

    fn save(&self, provider: Provider, key: &str) -> Result<(), String> {
        if self.refuse_writes.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("The keychain is locked.".into());
        }
        let mut items = self.items.lock().unwrap();
        let mut writes = self.writes.lock().unwrap();
        if key.is_empty() {
            items.remove(provider.id());
            writes.push(format!("delete {}/{}", SERVICE, provider.id()));
        } else {
            items.insert(provider.id(), key.to_string());
            writes.push(format!("set {}/{}", SERVICE, provider.id()));
        }
        Ok(())
    }
}
