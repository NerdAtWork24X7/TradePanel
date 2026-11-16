"""The generated manifests: one valid package per venue, matching specs.json and the code."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import manifests  # noqa: E402
import plugin  # noqa: E402
import specs  # noqa: E402


class ManifestTests(unittest.TestCase):
    def test_the_artifact_is_what_the_generator_writes(self):
        self.assertEqual(manifests.read(), manifests.all_manifests(), "run `python manifests.py --write`")

    def test_every_venue_is_its_own_broker_plugin(self):
        found = manifests.read()
        self.assertEqual(set(found), {venue.id for venue in specs.venues()})
        codes = [manifest["exchange"] for manifest in found.values()]
        self.assertEqual(len(codes), len(set(codes)))
        for venue in specs.venues():
            manifest = found[venue.id]
            self.assertEqual(manifest["id"], venue.id)
            self.assertEqual(manifest["name"], venue.name)
            self.assertEqual(manifest["exchange"], venue.code)
            self.assertEqual(manifest["api"], plugin.API)
            self.assertEqual(manifest["version"], plugin.VERSION)
            self.assertEqual(manifest["version"], specs.catalog()["version"])
            self.assertEqual(manifest["provides"], ["broker"])
            self.assertEqual(manifest["runtime"], {
                "type": "process",
                "entry": "plugin.py",
                "args": ["--venue", venue.id],
            })
            self.assertEqual(manifest["platforms"], [])

    def test_settings_carry_the_credentials_the_broker_reads(self):
        for venue in specs.venues():
            manifest = manifests.read()[venue.id]
            fields = {field["key"]: field for field in manifest["settings"]}
            self.assertEqual(fields["apiKey"]["type"], "secret")
            self.assertEqual(fields["apiSecret"]["type"], "secret")
            self.assertEqual("passphrase" in fields, venue.passphrase)
            if venue.passphrase:
                self.assertEqual(fields["passphrase"]["type"], "secret")
            self.assertEqual(fields["network"]["default"], venue.default_network)
            self.assertEqual([option["value"] for option in fields["network"]["options"]], list(venue.networks))
            self.assertEqual(fields["market"]["default"], venue.default_market)
            self.assertEqual(set(option["value"] for option in fields["market"]["options"]), set(venue.markets))
            self.assertEqual(fields["pollSeconds"]["type"], "number")
            self.assertTrue(manifest["setup"].strip())

    def test_the_script_is_the_venue_it_was_packaged_for(self):
        self.assertEqual(specs.venue("kraken").code, "KRAKEN")
        self.assertEqual(specs.venue("gate").markets, {"futures": "gate", "spot": "gate"})
        self.assertEqual(specs.venue("coinbase").networks, ("live",))
        self.assertEqual(specs.venue("kucoin").default_market, "futures")
        with self.assertRaises(specs.SpecError):
            specs.venue("not-a-venue")


if __name__ == "__main__":
    unittest.main()
