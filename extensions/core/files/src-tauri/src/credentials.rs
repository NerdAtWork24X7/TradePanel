/*
 * The OS credential store (Credential Manager, Keychain, Secret Service), called off every async
 * runtime.
 *
 * keyring's Linux backend drives the Secret Service through zbus, whose blocking API starts its
 * own tokio runtime. Starting a runtime inside a tokio worker (a Tauri async command, the plugin
 * connection handler, the analyst) panics: "Cannot start a runtime from within a runtime". A fresh
 * thread has no runtime context, so zbus may start its own there; that is where every keyring call
 * runs (the pattern keyring recommends for its async-secret-service backend).
 */
use keyring::Error;

/// Run `f` with the entry of `service` / `user` on a thread with no async runtime context.
pub fn with_entry<T: Send>(
    service: &str,
    user: &str,
    f: impl FnOnce(&keyring::Entry) -> keyring::Result<T> + Send,
) -> keyring::Result<T> {
    std::thread::scope(|scope| {
        match scope
            .spawn(move || keyring::Entry::new(service, user).and_then(|entry| f(&entry)))
            .join()
        {
            Ok(result) => result,
            // A panic is the caller's to see, as if the call had not left this thread.
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
}

/// The stored secret (`None` when none is stored, or it is empty).
pub fn read(service: &str, user: &str) -> keyring::Result<Option<String>> {
    with_entry(service, user, |entry| match entry.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    })
}

/// Store a secret.
pub fn write(service: &str, user: &str, value: &str) -> keyring::Result<()> {
    with_entry(service, user, |entry| entry.set_password(value))
}

/// Delete the stored secret (an absent one is not an error).
pub fn delete(service: &str, user: &str) -> keyring::Result<()> {
    with_entry(service, user, |entry| match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of this module: the credential call must not see the tokio runtime it was
    /// called from, or zbus starts a nested runtime and panics on Linux.
    #[tokio::test]
    async fn runs_off_the_async_runtime() {
        let inside = with_entry("OpenTrader test", "runtime", |_| {
            Ok(tokio::runtime::Handle::try_current().is_ok())
        });
        assert_eq!(inside.ok(), Some(false));
    }
}

