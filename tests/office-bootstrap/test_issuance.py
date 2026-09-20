"""Exercise additive office enrollment provisioning without a running server."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "tools/issue_office_enrollment.py"
ENDPOINT = "https://srv1522777.tail72f980.ts.net/"


class IssueEnrollmentTests(unittest.TestCase):
    def test_refuses_credential_output_inside_source_checkout(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory(dir=SCRIPT.parent) as destination:
            root = Path(directory)
            state = root / "grants.json"
            state.write_text("[]")
            state.chmod(0o600)
            manifest = root / "office-enrollment.json"
            manifest.write_text(json.dumps({"OfficeEnrollment": {"Enabled": True, "StateFile": str(state), "Tokens": []}}))
            manifest.chmod(0o600)
            before = manifest.read_bytes()
            output = Path(destination) / "new.json"
            result = subprocess.run([sys.executable, str(SCRIPT), "--manifest", str(manifest), "--output", str(output)], capture_output=True, text=True, check=False)
            self.assertNotEqual(0, result.returncode)
            self.assertFalse(output.exists())
            self.assertEqual(before, manifest.read_bytes())

    def test_rejects_duplicate_json_keys_without_erasing_prior_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "grants.json"
            state.write_text("[]")
            state.chmod(0o600)
            manifest = root / "office-enrollment.json"
            manifest.write_text('{"OfficeEnrollment":{"Enabled":true,"StateFile":' + json.dumps(str(state)) + ',"Tokens":[{"TokenHash":"' + 'A' * 64 + '"}],"Tokens":[]}}')
            manifest.chmod(0o600)
            before = manifest.read_bytes()
            output = root / "new.json"
            result = subprocess.run([sys.executable, str(SCRIPT), "--manifest", str(manifest), "--output", str(output)], capture_output=True, text=True, check=False)
            self.assertNotEqual(0, result.returncode)
            self.assertEqual(before, manifest.read_bytes())
            self.assertFalse(output.exists())

    def test_refuses_invalid_or_full_inventory_before_creating_credentials(self):
        for case in ("null-grants", "object-grants", "too-many-grants", "invalid-grant", "full-tokens", "invalid-token"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                state = root / "grants.json"
                grant = {"TokenHash": "A" * 64, "MachineId": "previous", "KeyHash": "B" * 64}
                states = {"null-grants": None, "object-grants": {}, "too-many-grants": [grant] * 100, "invalid-grant": [{}]}
                state.write_text(json.dumps(states.get(case, [])))
                state.chmod(0o600)
                token = {"TokenHash": "A" * 64, "IssuedUtc": "2026-01-01T00:00:00+00:00", "ExpiresUtc": "2026-01-01T00:20:00+00:00", "DeviceExpiresUtc": "2026-01-02T00:00:00+00:00"}
                tokens = [token] * 100 if case == "full-tokens" else ([{}] if case == "invalid-token" else [])
                manifest = root / "office-enrollment.json"
                manifest.write_text(json.dumps({"OfficeEnrollment": {"Enabled": True, "StateFile": str(state), "Tokens": tokens}}))
                manifest.chmod(0o600)
                before = manifest.read_bytes()
                output = root / "new.json"
                result = subprocess.run([sys.executable, str(SCRIPT), "--manifest", str(manifest), "--output", str(output)], capture_output=True, text=True, check=False)
                self.assertNotEqual(0, result.returncode)
                self.assertFalse(output.exists())
                self.assertEqual(before, manifest.read_bytes())

    def test_refuses_insecure_or_linked_paths_without_mutation(self):
        for target in ("manifest", "state", "output-parent", "manifest-link", "state-link", "output-link"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                state = root / "grants.json"
                state.write_text("[]")
                state.chmod(0o600)
                manifest = root / "office-enrollment.json"
                manifest.write_text(json.dumps({"OfficeEnrollment": {"Enabled": True, "StateFile": str(state), "Tokens": []}}))
                manifest.chmod(0o600)
                dest = root / "dest"
                dest.mkdir(mode=0o700)
                output = dest / "new.json"
                if target == "manifest": manifest.chmod(0o644)
                if target == "state": state.chmod(0o644)
                if target == "output-parent": dest.chmod(0o755)
                if target in ("manifest-link", "state-link"):
                    original = manifest if target == "manifest-link" else state
                    backing = root / "backing.json"
                    original.rename(backing)
                    original.symlink_to(backing)
                if target == "output-link": output.symlink_to(root / "missing.json")
                before = manifest.read_bytes()
                result = subprocess.run([sys.executable, str(SCRIPT), "--manifest", str(manifest), "--output", str(output)], capture_output=True, text=True, check=False)
                self.assertNotEqual(0, result.returncode)
                self.assertEqual(before, manifest.read_bytes())
                self.assertFalse(output.exists())

    def test_refuses_disabled_mode_without_creating_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "grants.json"
            state.write_text("[]")
            state.chmod(0o600)
            manifest = root / "office-enrollment.json"
            manifest.write_text(json.dumps({"OfficeEnrollment": {"Enabled": False, "StateFile": str(state), "Tokens": []}}))
            manifest.chmod(0o600)
            before = manifest.read_bytes()
            output = root / "new.json"
            result = subprocess.run([sys.executable, str(SCRIPT), "--manifest", str(manifest), "--output", str(output)], capture_output=True, text=True, check=False)
            self.assertNotEqual(0, result.returncode)
            self.assertFalse(output.exists())
            self.assertEqual(before, manifest.read_bytes())

    def test_appends_fresh_token_preserving_existing_manifest_and_consumed_journal(self):
        self.assertTrue(SCRIPT.exists(), "Additive issuance tool is missing")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "grants.json"
            state.write_text(json.dumps([{"TokenHash": "A" * 64, "MachineId": "previous-device", "KeyHash": "B" * 64}]))
            state.chmod(0o600)
            manifest = root / "office-enrollment.json"
            existing = {"TokenHash": "A" * 64, "IssuedUtc": "2026-01-01T00:00:00+00:00", "ExpiresUtc": "2026-01-01T00:20:00+00:00", "DeviceExpiresUtc": "2026-01-02T00:00:00+00:00"}
            manifest.write_text(json.dumps({"OfficeEnrollment": {"Enabled": True, "StateFile": str(state), "Tokens": [existing]}}))
            manifest.chmod(0o600)
            before = state.read_bytes()
            output = root / "device-new.json"
            result = subprocess.run([sys.executable, str(SCRIPT), "--manifest", str(manifest), "--output", str(output)], capture_output=True, text=True, check=False)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(before, state.read_bytes())
            tokens = json.loads(manifest.read_text())["OfficeEnrollment"]["Tokens"]
            self.assertEqual(existing, tokens[0])
            self.assertEqual(2, len(tokens))
            secret = json.loads(output.read_text())
            self.assertEqual(ENDPOINT, secret["ServerBaseUrl"])
            self.assertEqual(hashlib.sha256(secret["Token"].encode()).hexdigest().upper(), tokens[1]["TokenHash"])
            self.assertNotIn(secret["Token"], result.stdout + result.stderr + manifest.read_text())
            self.assertEqual(0o600, output.stat().st_mode & 0o777)
            self.assertEqual(0o600, manifest.stat().st_mode & 0o777)
            backups = list(root.glob("office-enrollment.json.*.bak"))
            self.assertEqual(1, len(backups))
            self.assertEqual([existing], json.loads(backups[0].read_text())["OfficeEnrollment"]["Tokens"])


if __name__ == "__main__":
    unittest.main()
