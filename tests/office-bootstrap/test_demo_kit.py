"""Offline package and first-install contracts. No server or service is touched."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
ENDPOINT = "https://srv1522777.tail72f980.ts.net/"


class PackageTests(unittest.TestCase):
    def test_agent_package_has_complete_source_bound_inventory_and_no_secrets(self):
        from build_independent_demo_kit import package_component, verify_package
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            publish = base / "publish"
            publish.mkdir()
            (publish / "CabinetPlatform.Agent.exe").write_bytes(b"lab synthetic executable")
            (publish / "appsettings.json").write_text('{"untrusted":true}')
            destination = base / "agent.zip"
            package_component("agent", publish, destination, "a" * 40)
            manifest = verify_package(destination, "agent")
            self.assertEqual("a" * 40, manifest["sourceCommit"])
            with zipfile.ZipFile(destination) as archive:
                names = set(archive.namelist())
                self.assertEqual(names, set(manifest["sha256"]) | {"kit-manifest.json"})
                config = json.loads(archive.read("appsettings.json"))
                self.assertEqual(ENDPOINT, config["Agent"]["ServerBaseUrl"])
                self.assertEqual("DiagnosticOnly", config["Agent"]["Actions"]["ExecutionMode"])
                self.assertEqual("office-enrollment.json", config["Agent"]["OfficeEnrollmentFile"])
                self.assertNotIn("Token", archive.read("appsettings.json").decode())
            self.assertTrue(destination.exists())

    def test_rejects_corrupt_extra_unsafe_and_missing_members(self):
        from build_independent_demo_kit import package_component, verify_package
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            publish = root / "publish"
            publish.mkdir()
            (publish / "CabinetPlatform.Console.exe").write_bytes(b"synthetic")
            target = root / "console.zip"
            package_component("console", publish, target, "b" * 40)
            with zipfile.ZipFile(target) as archive:
                original = {n: archive.read(n) for n in archive.namelist()}
            for kind in ("changed", "extra", "missing", "traversal", "duplicate", "wrong-config", "bad-manifest"):
                with self.subTest(kind=kind):
                    rows = dict(original)
                    if kind == "changed": rows["CabinetPlatform.Console.exe"] = b"tampered"
                    if kind == "extra": rows["other.exe"] = b"x"
                    if kind == "missing": del rows["CabinetPlatform.Console.exe"]
                    if kind == "traversal": rows["../escape"] = b"x"
                    if kind == "wrong-config":
                        rows["appsettings.json"] = b'{"Api":{"BaseAddress":"https://evil.example/"}}'
                        manifest = json.loads(rows["kit-manifest.json"])
                        manifest["sha256"]["appsettings.json"] = hashlib.sha256(rows["appsettings.json"]).hexdigest().upper()
                        rows["kit-manifest.json"] = json.dumps(manifest).encode()
                    if kind == "bad-manifest": rows["kit-manifest.json"] = b'{}'
                    with zipfile.ZipFile(target, "w") as archive:
                        for name, data in rows.items(): archive.writestr(name, data)
                        if kind == "duplicate": archive.writestr("appsettings.json", rows["appsettings.json"])
                    with self.assertRaises(ValueError): verify_package(target, "console")

    def test_builder_refuses_dirty_source_and_existing_destination(self):
        from build_independent_demo_kit import assert_clean_source, package_component
        with self.assertRaises(ValueError): assert_clean_source(" M tools/example.py")
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            publish = base / "publish"
            publish.mkdir()
            (publish / "CabinetPlatform.Console.exe").write_bytes(b"x")
            dest = base / "console.zip"
            dest.write_bytes(b"do not overwrite")
            with self.assertRaises(FileExistsError): package_component("console", publish, dest, "c" * 40)
            self.assertEqual(b"do not overwrite", dest.read_bytes())

    def test_rejects_windows_device_names_and_runtime_overlays(self):
        from build_independent_demo_kit import _safe_name, package_component
        for member in ("CON", "aux.txt", "folder/NUL.dll", "COM1", "LPT9.txt", "a/.hidden/../x"):
            self.assertFalse(_safe_name(member), member)
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            publish = base / "publish"
            publish.mkdir()
            (publish / "CabinetPlatform.Agent.exe").write_bytes(b"x")
            (publish / "appsettings.Production.json").write_text('{"Agent":{"ServerBaseUrl":"https://evil.example/"}}')
            package_component("agent", publish, base / "agent.zip", "a" * 40)
            with zipfile.ZipFile(base / "agent.zip") as archive:
                self.assertNotIn("appsettings.Production.json", archive.namelist())

    def test_helper_contract_keeps_install_and_enrollment_separate(self):
        helper = (ROOT / "tools/Install-CabinetDemoAgent.ps1").read_text()
        self.assertIn("CabinetPlatformAgent", helper)
        self.assertIn("C:\\Program Files\\Mashura\\CabinetAgent", helper)
        self.assertIn("LocalSystem", helper)
        self.assertIn("Start-Service", helper)
        self.assertIn("office-enrollment.json", helper)
        self.assertIn("ExpectedSha256", helper)
        self.assertIn("ExpectedSourceCommit", helper)
        self.assertIn("Get-FileHash", helper)
        self.assertIn("$PSVersionTable.PSVersion.Major", helper)
        self.assertIn("ExpiresUtc", helper)
        self.assertIn("GetProperty('ExpiresUtc').GetString()", helper)
        self.assertIn("Get-Service -Name $serviceName", helper)
        for forbidden in ("ExecutionPolicy Bypass", "Set-ExecutionPolicy", "DisableRealtimeMonitoring", "Expand-Archive", "Invoke-Expression"):
            self.assertNotIn(forbidden, helper)


if __name__ == "__main__":
    unittest.main()
