"""In-memory credential mirror for the sidecar.

The Tauri shell owns the OS keyring and pushes secrets into the sidecar's
environment at spawn time and through ``system.set_credentials``. This module
only validates values and applies them to ``os.environ`` + ``Core.config`` so
the exchange client picks them up. It never writes secrets to disk and never
returns secret values.
"""

from __future__ import annotations

import logging
import os
import threading

from backend.Core import config, credentials, trading_service

log = logging.getLogger(__name__)

KNOWN_KEYS = tuple(field[0] for field in credentials.FIELDS)
SECRET_KEYS = tuple(field[0] for field in credentials.FIELDS if field[2])


class CredentialStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()

    def apply(self, values: dict | None, clear: list | None) -> list[str]:
        """Validate and apply credential updates. Returns changed keys."""
        cleanup = [str(key) for key in (clear or [])]
        updates: dict[str, str] = {}
        for key, raw in (values or {}).items():
            key = str(key)
            if key not in KNOWN_KEYS:
                raise credentials.CredentialError(f"Unknown credential: {key}")
            value = "" if raw is None else str(raw)
            if not value.strip():
                continue
            if key in SECRET_KEYS:
                credentials.validate(key, value)
            else:
                credentials.validate(key, value.strip())
            updates[key] = value if key in SECRET_KEYS else value.strip()

        unknown = [key for key in cleanup if key not in KNOWN_KEYS]
        if unknown:
            raise credentials.CredentialError(f"Unknown credential: {unknown[0]}")
        changed = sorted({*updates, *cleanup})
        if not changed:
            return []

        with self._lock:
            for key in cleanup:
                os.environ.pop(key, None)
            os.environ.update(updates)
            config.refresh_credentials()
            trading_service.reset_client()

        # Log key names only — never values.
        log.info("Applied credential updates: %s", ", ".join(changed))
        return changed

    def describe(self) -> list[dict]:
        out = []
        for key, label, secret, group in credentials.FIELDS:
            out.append(
                {
                    "key": key,
                    "label": label,
                    "secret": bool(secret),
                    "group": group,
                    "set": bool(os.environ.get(key, "")),
                }
            )
        return out
