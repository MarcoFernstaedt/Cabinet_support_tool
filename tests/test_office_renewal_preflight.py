"""Synthetic read-only Office activation checks. Never use a live journal here."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import office_renewal_preflight as pre

H1 = 'A' * 64
H2 = 'B' * 64
K = 'C' * 64


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.journal = self.root / 'grants.json'
        self.manifest = self.root / 'office-enrollment.json'
        self.effective = self.root / 'effective.json'
        self.inventory = self.root / 'inventory.json'
        self.token = {'TokenHash': H1, 'IssuedUtc': '2026-09-01T00:00:00Z',
                      'ExpiresUtc': '2026-09-01T00:20:00Z', 'DeviceExpiresUtc': '2026-09-02T00:00:00Z'}
        self.grant = {'TokenHash': H1, 'KeyHash': K, 'MachineId': 'device', 'Revoked': False,
                      'KeyDestroyed': False, 'Renewals': [{'RequestId': '11111111-1111-1111-1111-111111111111',
                      'ActorId': 'operator', 'Reason': 'lab', 'IssuedUtc': '2026-09-01T00:00:00Z',
                      'ExpiresUtc': '2026-09-02T00:00:00Z'}]}
        self.put(self.journal, [self.grant])
        self.options = {'Enabled': True, 'StateFile': str(self.journal), 'Tokens': [self.token]}
        self.put(self.manifest, {'OfficeEnrollment': self.options})
        self.put(self.effective, {'OfficeEnrollment': self.options})
        self.put(self.inventory, {'StateFile': str(self.journal), 'Tokens': [H1], 'Revoked': []})

    def put(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def check(self):
        return pre.check(self.manifest, self.effective, self.inventory, self.journal)

    def test_complete_config_and_legacy_renewal_are_read_only(self):
        before = self.journal.read_bytes()
        self.check()
        self.assertEqual(self.journal.read_bytes(), before)

    def test_missing_manifest_and_empty_config_refuse_without_shredding(self):
        before = self.journal.read_bytes()
        self.manifest.unlink()
        with self.assertRaises(pre.Refusal): self.check()
        self.put(self.manifest, {'OfficeEnrollment': self.options})
        self.put(self.effective, {'OfficeEnrollment': {'Enabled': True, 'StateFile': str(self.journal), 'Tokens': []}})
        with self.assertRaises(pre.Refusal): self.check()
        self.assertEqual(self.journal.read_bytes(), before)

    def test_partial_config_and_inventory_mismatch_refuse(self):
        before = self.journal.read_bytes()
        self.put(self.effective, {'OfficeEnrollment': {'Enabled': True, 'StateFile': str(self.journal), 'Tokens': []}})
        with self.assertRaises(pre.Refusal): self.check()
        self.put(self.effective, {'OfficeEnrollment': self.options})
        self.put(self.inventory, {'StateFile': str(self.journal), 'Tokens': [H2], 'Revoked': []})
        with self.assertRaises(pre.Refusal): self.check()
        self.assertEqual(self.journal.read_bytes(), before)

    def test_explicit_revocation_only_after_removal_from_manifest_and_effective(self):
        before = self.journal.read_bytes()
        self.put(self.inventory, {'StateFile': str(self.journal), 'Tokens': [H1], 'Revoked': [H1]})
        with self.assertRaises(pre.Refusal): self.check()
        self.options['Tokens'] = []
        self.put(self.manifest, {'OfficeEnrollment': self.options})
        self.put(self.effective, {'OfficeEnrollment': self.options})
        self.check()
        self.assertEqual(self.journal.read_bytes(), before)

    def test_unlisted_missing_binding_refuses(self):
        self.options['Tokens'] = []
        self.put(self.manifest, {'OfficeEnrollment': self.options})
        self.put(self.effective, {'OfficeEnrollment': self.options})
        with self.assertRaises(pre.Refusal): self.check()

    def test_all_empty_configuration_and_inventory_refuse(self):
        self.options['Tokens'] = []
        self.put(self.manifest, {'OfficeEnrollment': self.options})
        self.put(self.effective, {'OfficeEnrollment': self.options})
        self.put(self.inventory, {'StateFile': str(self.journal), 'Tokens': [], 'Revoked': []})
        self.put(self.journal, [])
        with self.assertRaises(pre.Refusal): self.check()

    def test_path_override_and_ambiguous_properties_refuse(self):
        self.put(self.effective, {'OfficeEnrollment': {**self.options, 'StateFile': str(self.root / 'wrong.json')}})
        with self.assertRaises(pre.Refusal): self.check()
        self.effective.write_text('{"OfficeEnrollment": {}, "officeenrollment": {}}')
        with self.assertRaises(pre.Refusal): self.check()

    def test_corrupt_journal_and_missing_inventory_refuse(self):
        self.journal.write_text('{')
        with self.assertRaises(pre.Refusal): self.check()
        self.inventory.unlink()
        with self.assertRaises(pre.Refusal): self.check()


if __name__ == '__main__': unittest.main()
