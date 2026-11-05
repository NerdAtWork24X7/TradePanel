"""Tests for Core.credentials — keys/.env updates and secret handling."""

from __future__ import annotations

import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.Core import config, credentials

KEY = "ab" * 32
ADDRESS = "0x" + "cd" * 20
ENV_KEYS = ("HL_ADDRESS", "HL_PRIVATE_KEY")


class CredentialsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.env_file = self.root / ".env"

        self._env_backup = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        self.addCleanup(self._restore_env)

        self._attr_backup = {name: getattr(config, name) for name in
                             ("HL_ADDRESS", "HL_PRIVATE_KEY")}
        self.addCleanup(self._restore_config)

        self._patches = [mock.patch.object(config, "KEYS_DIR", self.root)]
        for patch in self._patches:
            patch.start()
            self.addCleanup(patch.stop)
        config.refresh_credentials()

    def _restore_env(self):
        for key, value in self._env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _restore_config(self):
        for name, value in self._attr_backup.items():
            setattr(config, name, value)

    def _status(self, key: str) -> dict:
        return next(item for item in credentials.status() if item["key"] == key)

    # ── status ───────────────────────────────────────────────────────────

    def test_status_never_exposes_secrets(self):
        os.environ["HL_PRIVATE_KEY"] = KEY
        os.environ["HL_ADDRESS"] = ADDRESS
        private = self._status("HL_PRIVATE_KEY")
        address = self._status("HL_ADDRESS")
        self.assertTrue(private["secret"])
        self.assertTrue(private["set"])
        self.assertEqual(private["value"], "")
        self.assertNotIn(KEY, repr(private))
        self.assertEqual(address["value"], ADDRESS)

    # ── writes ───────────────────────────────────────────────────────────

    def test_save_preserves_file_and_updates_process(self):
        self.env_file.write_text(
            "# keep me\nHL_ADDRESS=0xold\nUNRELATED=1\n", encoding="utf-8")
        result = credentials.save({"HL_ADDRESS": ADDRESS})
        self.assertEqual(result, {"ok": True, "keys": ["HL_ADDRESS"]})
        text = self.env_file.read_text(encoding="utf-8")
        self.assertIn("# keep me", text)
        self.assertIn("UNRELATED=1", text)
        self.assertIn(f"HL_ADDRESS={ADDRESS}", text)
        self.assertNotIn("0xold", text)
        self.assertEqual(os.environ["HL_ADDRESS"], ADDRESS)
        self.assertEqual(config.HL_ADDRESS, ADDRESS)

    def test_blank_secret_keeps_value_and_clear_removes_it(self):
        credentials.save({"HL_PRIVATE_KEY": KEY})
        self.assertEqual(os.environ["HL_PRIVATE_KEY"], KEY)

        credentials.save(values={"HL_PRIVATE_KEY": "   "}, clear=[])
        self.assertEqual(os.environ["HL_PRIVATE_KEY"], KEY)
        self.assertIn(f"HL_PRIVATE_KEY={KEY}", self.env_file.read_text())

        credentials.save(clear=["HL_PRIVATE_KEY"])
        self.assertNotIn("HL_PRIVATE_KEY", os.environ)
        self.assertNotIn("HL_PRIVATE_KEY", self.env_file.read_text())
        self.assertNotIn(KEY, self.env_file.read_text())

    def test_save_is_noop_when_nothing_changes(self):
        self.assertEqual(credentials.save({}, []), {"ok": True, "keys": []})
        self.assertFalse(self.env_file.exists())
        credentials.save(clear=["HL_ADDRESS"])
        self.assertFalse(self.env_file.exists())

    def test_duplicate_keys_collapse_to_one_line(self):
        self.env_file.write_text(
            "HL_ADDRESS=0xold\nOTHER=1\nHL_ADDRESS=0xolder\n", encoding="utf-8")
        credentials.save({"HL_ADDRESS": ADDRESS})
        text = self.env_file.read_text(encoding="utf-8")
        self.assertEqual(text.count("HL_ADDRESS="), 1)
        self.assertIn(f"HL_ADDRESS={ADDRESS}", text)
        self.assertIn("OTHER=1", text)

    def test_file_permissions_are_private(self):
        if os.name != "posix":
            self.skipTest("POSIX permissions only")
        credentials.save({"HL_ADDRESS": ADDRESS})
        mode = stat.S_IMODE(self.env_file.stat().st_mode)
        self.assertEqual(mode, 0o600)

    # ── validation ───────────────────────────────────────────────────────

    def test_invalid_private_key_rejected_without_writing(self):
        with self.assertRaises(credentials.CredentialError):
            credentials.save({"HL_PRIVATE_KEY": "not-a-key"})
        self.assertFalse(self.env_file.exists())
        self.assertNotIn("HL_PRIVATE_KEY", os.environ)

    def test_invalid_address_rejected(self):
        with self.assertRaises(credentials.CredentialError):
            credentials.save({"HL_ADDRESS": "0x1234"})

    def test_control_characters_rejected(self):
        with self.assertRaises(credentials.CredentialError):
            credentials.save({"HL_ADDRESS": "0x11\nINJECTED=1"})

    def test_quoting_preserves_special_characters(self):
        self.assertEqual(credentials._format("abc123"), "abc123")
        self.assertEqual(credentials._format("a b#c"), '"a b#c"')
        self.assertEqual(credentials._format('a"b\\c'), '"a\\"b\\\\c"')

    def test_unknown_key_rejected(self):
        with self.assertRaises(credentials.CredentialError):
            credentials.save({"NOT_A_KEY": "x"})
        with self.assertRaises(credentials.CredentialError):
            credentials.save(clear=["NOT_A_KEY"])


if __name__ == "__main__":
    unittest.main()
