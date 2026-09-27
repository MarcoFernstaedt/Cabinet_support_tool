"""Offline contracts for the distinct same-machine recovery helper."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))


class RecoveryContracts(unittest.TestCase):
    def test_kit_includes_distinct_recovery_helper_in_release_inventory(self):
        from build_independent_demo_kit import bundle_operator_files
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            output = Path(temporary) / "kit"
            (source / "tools").mkdir(parents=True)
            (source / "docs").mkdir()
            for name in ("Install-CabinetDemoAgent.ps1", "Restore-CabinetDemoAgent.ps1", "Manual-Reinstall-CabinetDemoAgent.ps1",
                         "RecoveryProcess.cs", "office_renewal_operator.py", "office_renewal_preflight.py", "issue_office_enrollment.py"):
                (source / "tools" / name).write_text(name)
            for name in ("independent-demo-kit.md", "demo-credential-renewal.md", "independent-demo-server.md"):
                (source / "docs" / name).write_text(name)
            output.mkdir()
            for name in ("agent", "console"):
                (output / f"cabinet-{name}.zip").write_bytes(name.encode())
            bundle_operator_files(source, output, "a" * 40)
            inventory = json.loads((output / "release-evidence.json").read_text())["sha256"]
            self.assertEqual(len(inventory), 12)
            self.assertIn("RecoveryProcess.cs", inventory)
            name = "Restore-CabinetDemoAgent.ps1"
            self.assertEqual((source / "tools" / name).read_bytes(), (output / name).read_bytes())
            self.assertEqual(hashlib.sha256((output / name).read_bytes()).hexdigest().upper(), inventory[name])

    def test_recovery_is_distinct_from_first_install_and_has_no_enrollment_input(self):
        recovery = (ROOT / "tools/Restore-CabinetDemoAgent.ps1").read_text()
        self.assertIn("ExpectedSha256", recovery)
        self.assertIn("ExpectedSourceCommit", recovery)
        self.assertIn("SAME MACHINE", recovery)
        self.assertIn("[Security.Principal.WindowsBuiltInRole]::Administrator", recovery)
        self.assertIn("if (!$ConfirmSameMachine", recovery)
        self.assertNotIn("-EnrollmentFile", recovery)
        self.assertIn("[IO.FileShare]::Read", recovery)
        self.assertIn("ZipArchive]::new($packageStream", recovery)
        self.assertIn("Stop-Service", recovery)
        self.assertIn("Start-Service", recovery)
        self.assertIn("office-enrollment.json.device", recovery)
        for forbidden in ("ExecutionPolicy Bypass", "Set-ExecutionPolicy", "Invoke-Expression", "Stop-Process"):
            self.assertNotIn(forbidden, recovery)


if __name__ == "__main__":
    unittest.main()
