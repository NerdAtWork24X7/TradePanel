"""Read and update the credential file (``keys/.env``) from the UI.

The workspace only ever receives *metadata* about stored secrets (set / not
set); raw secret values never cross the QWebChannel bridge and are never
logged. Writes are atomic and preserve unrelated lines/comments in the file.

Kept free of Qt imports so it can be unit-tested headlessly.
"""

from __future__ import annotations

import os
import re
import threading
from pathlib import Path

from backend.Core import config
from backend.Exchange import specs

# The catalog is the single source of truth for credential keys and groups.
FIELDS = specs.FIELDS
_KNOWN_KEYS = set(specs.KNOWN_KEYS)
_SECRET_KEYS = set(specs.SECRET_KEYS)

# Env var -> Core.config attribute, used to refresh live settings on save.
_CONFIG_ATTR = {
    "HL_ADDRESS": "HL_ADDRESS",
    "HL_PRIVATE_KEY": "HL_PRIVATE_KEY",
}

_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")

_LOCK = threading.RLock()


class CredentialError(ValueError):
    """Raised when a submitted credential value is invalid."""


def _env_path() -> Path:
    return config.KEYS_DIR / ".env"


def _effective(key: str) -> str:
    """Current effective value from the process environment."""
    return os.environ.get(key, "") or ""


def status() -> list[dict]:
    """Return credential metadata. Secret values are never included."""
    out: list[dict] = []
    for key, label, secret, group in FIELDS:
        value = _effective(key)
        entry = {
            "key": key,
            "label": label,
            "secret": secret,
            "group": group,
            "exchange": specs.field_exchange(key),
            "kind": specs.field_kind(key),
            "multiline": specs.field_multiline(key),
            "set": bool(value),
            "value": "" if secret else value,
        }
        out.append(entry)
    return out


def validate(key: str, value: str) -> None:
    """Validate a credential value without writing it anywhere.

    Public wrapper used by the sidecar, which stores secrets in the OS keyring
    (Rust side) and only mirrors them into the process environment.
    """
    if key not in _KNOWN_KEYS:
        raise CredentialError(f"Unknown credential: {key}")
    _validate(key, value)


def _validate(key: str, value: str) -> None:
    try:
        specs.validate_credential(key, value)
    except ValueError as exc:
        raise CredentialError(str(exc)) from exc


def _format(value: str) -> str:
    """Serialise a value for a KEY=value line (quote only when needed)."""
    if re.fullmatch(r"[^\s#'\"\\=]+", value):
        return value
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\r", "\\r")
        .replace("\n", "\\n")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def _upsert(text: str, key: str, value: str) -> str:
    """Replace every existing line for *key* with one line at its first position."""
    kept: list[str] = []
    index: int | None = None
    for line in text.splitlines():
        match = _LINE.match(line)
        if match and match.group(1) == key:
            if index is None:
                index = len(kept)
            continue
        kept.append(line)
    if index is None:
        if kept and kept[-1].strip():
            kept.append("")
        kept.append(f"{key}={_format(value)}")
    else:
        kept.insert(index, f"{key}={_format(value)}")
    return "\n".join(kept).rstrip("\n") + "\n"


def _remove(text: str, key: str) -> str:
    kept = []
    for line in text.splitlines():
        match = _LINE.match(line)
        if match and match.group(1) == key:
            continue
        kept.append(line)
    return "\n".join(kept) + ("\n" if kept else "")


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass  # Windows / restricted filesystems
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def _sync_process(key: str, value: str) -> None:
    if value:
        os.environ[key] = value
    else:
        os.environ.pop(key, None)
    attr = _CONFIG_ATTR.get(key)
    if attr:
        setattr(config, attr, value)


def save(values: dict[str, str] | None = None, clear: list[str] | None = None) -> dict:
    """Persist credential changes to ``keys/.env`` and apply them live.

    ``values`` maps env keys to new values; ``clear`` lists keys to delete.
    Blank values are ignored so the UI can leave stored secrets untouched.
    Returns ``{"ok": True, "keys": [changed env keys]}``.
    """
    cleanup = {str(k) for k in (clear or [])}
    updates: dict[str, str] = {}
    for key, raw in (values or {}).items():
        key = str(key)
        if key not in _KNOWN_KEYS:
            raise CredentialError(f"Unknown credential: {key}")
        value = str(raw if raw is not None else "")
        if not value.strip():
            continue
        updates[key] = (
            value
            if key in _SECRET_KEYS and specs.field_multiline(key)
            else value.strip()
        )
    unknown = cleanup - _KNOWN_KEYS
    if unknown:
        raise CredentialError(f"Unknown credential: {sorted(unknown)[0]}")
    if not updates and not cleanup:
        return {"ok": True, "keys": []}

    for key, value in updates.items():
        _validate(key, value)

    with _LOCK:
        path = _env_path()
        try:
            text = path.read_text(encoding="utf-8") if path.exists() else ""
        except OSError as exc:
            raise CredentialError(f"Cannot read {path}: {exc}") from exc
        original = text
        for key in cleanup:
            text = _remove(text, key)
        for key, value in updates.items():
            text = _upsert(text, key, value)
        if text != original:
            try:
                _write_atomic(path, text)
            except OSError as exc:
                raise CredentialError(f"Cannot write {path}: {exc}") from exc

    changed = sorted({*updates, *cleanup})
    for key in changed:
        _sync_process(key, updates.get(key, ""))
    config.refresh_credentials()
    # Drop cached SDK clients so the new keys/network apply without a restart.
    try:
        from backend.Core import trading_service

        trading_service.reset_client()
    except Exception:  # pragma: no cover - defensive during shutdown
        pass
    return {"ok": True, "keys": changed}
