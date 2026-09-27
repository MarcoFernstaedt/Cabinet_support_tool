"""Offline package and first-install contracts. No server or service is touched."""
import hashlib
import json
import re
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
    def test_json_scanner_uses_only_json_whitespace_and_ascii_digits(self):
        helper = (ROOT / "tools/Install-CabinetDemoAgent.ps1").read_text()
        scanner = helper.split("function Read-Json", 1)[1].split("function Json-TopString", 1)[0]
        self.assertNotIn(r"\s", scanner)
        self.assertNotIn(r"\d", scanner)
        self.assertIn(r"[ \t\r\n]", scanner)
        self.assertIn(r"[0-9]", scanner)

    def test_acl_mutation_mask_excludes_read_and_allows_trusted_installer_only_on_ancestors(self):
        helper = (ROOT / "tools/Install-CabinetDemoAgent.ps1").read_text()
        mask = helper.split("$mutation =", 1)[1].split("foreach ($rule", 1)[0]
        names = re.findall(r'FileSystemRights\]::(\w+)', mask)
        rights = {"WriteData": 2, "CreateFiles": 2, "AppendData": 4,
                  "CreateDirectories": 4, "WriteExtendedAttributes": 16, "WriteAttributes": 256,
                  "DeleteSubdirectoriesAndFiles": 64, "Delete": 65536,
                  "ChangePermissions": 262144, "TakeOwnership": 524288,
                  "Write": 278, "Modify": 197055, "FullControl": 2032127}
        self.assertTrue(set(names) <= rights.keys())
        mask_value = 0
        for name in names:
            mask_value |= rights[name]
        self.assertEqual(0, mask_value & 131241, "ReadAndExecute must not count as mutation")
        self.assertEqual(0, mask_value & 131209, "Read must not count as mutation")
        for name in ("WriteData", "AppendData", "WriteExtendedAttributes", "WriteAttributes",
                     "DeleteSubdirectoriesAndFiles", "Delete", "ChangePermissions", "TakeOwnership"):
            self.assertNotEqual(0, mask_value & rights[name], name)
        acl = helper.split("function Check-Acl", 1)[1].split("function Lock-Directory", 1)[0]
        self.assertRegex(acl, r'\$secret\s*-or\s*\(\$sid -notin \$trustedAncestor -and \(\(\$rule\.FileSystemRights -band \$mutation\) -ne 0\)\)')
        self.assertIn("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", acl)
        self.assertIn("$trustedAncestor", acl)

    def test_agent_package_has_complete_source_bound_inventory_and_no_secrets(self):
        from build_independent_demo_kit import package_component, verify_package
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            publish = base / "publish"
            publish.mkdir()
            (publish / "CabinetPlatform.Agent.exe").write_bytes(b"lab synthetic executable")
            (publish / "appsettings.json").write_text('{"untrusted":true}')
            (publish / "appsettings.Development.json").write_text('{"Token":"synthetic"}')
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
            with self.assertRaises(ValueError):
                package_component("agent", publish, base / "agent.zip", "a" * 40)
            self.assertFalse((base / "agent.zip").exists())

    def test_nested_state_and_overlays_are_refused_before_output(self):
        from build_independent_demo_kit import package_component
        for name in ("office-enrollment.json.device", "deep/office-enrollment.json.device",
                     "deep/appsettings.Production.json", "deep/state/record", "deep/x.sqlite",
                     "deep/x.log", "deep/x.pfx", "deep/grants.json", "deep/secret.txt",
                     "deep/Agent.dll", "deep/config.json"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                base = Path(root)
                publish = base / "publish"
                publish.mkdir()
                (publish / "CabinetPlatform.Agent.exe").write_bytes(b"synthetic")
                item = publish / name
                item.parent.mkdir(parents=True, exist_ok=True)
                item.write_bytes(b"synthetic")
                with self.assertRaises(ValueError):
                    package_component("agent", publish, base / "agent.zip", "a" * 40)
                self.assertFalse((base / "agent.zip").exists())

    def test_archive_refuses_windows_conflicts_and_bounded_size(self):
        from build_independent_demo_kit import _safe_name, package_component, verify_package
        self.assertFalse(_safe_name("bad\x01.txt"))
        helper = (ROOT / "tools/Install-CabinetDemoAgent.ps1").read_text()
        valid_name = helper.split("function Valid-Name", 1)[1].split("function Forbidden-Member", 1)[0]
        self.assertFalse(_safe_name(" leading.dll"))
        self.assertIn("$name -cne $name.Trim()", valid_name)
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            publish = base / "publish"
            publish.mkdir()
            (publish / "CabinetPlatform.Console.exe").write_bytes(b"synthetic")
            target = base / "console.zip"
            package_component("console", publish, target, "b" * 40)
            original = target.read_bytes()
            for kind in ("reparse", "case", "prefix", "control", "leading"):
                with self.subTest(kind=kind):
                    target.write_bytes(original)
                    self.assertEqual("console", verify_package(target, "console")["component"])
                    with zipfile.ZipFile(target, "r") as source:
                        rows = [(entry.filename, source.read(entry)) for entry in source.infolist()]
                    with zipfile.ZipFile(target, "w") as archive:
                        for name, data in rows:
                            entry = zipfile.ZipInfo(name)
                            if kind == "reparse" and entry.filename == "CabinetPlatform.Console.exe":
                                entry.external_attr |= 0x400
                            archive.writestr(entry, data)
                        if kind == "case": archive.writestr("APPSETTINGS.JSON", b"x")
                        if kind == "prefix": archive.writestr("appsettings.json/child", b"x")
                        if kind == "control": archive.writestr("unsafe\x01.txt", b"x")
                        if kind == "leading": archive.writestr(" leading.dll", b"x")
                    with self.assertRaisesRegex(ValueError, "Unsafe archive member"):
                        verify_package(target, "console")

    def test_archive_size_boundaries_use_actual_zip_member_lengths(self):
        from build_independent_demo_kit import package_component, verify_package
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            publish = base / "publish"
            publish.mkdir()
            (publish / "CabinetPlatform.Console.exe").write_bytes(b"synthetic")
            exact = b"\0" * (100 * 1024 * 1024)
            (publish / "boundary.dll").write_bytes(exact)
            target = base / "at-limit.zip"
            package_component("console", publish, target, "b" * 40)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(len(exact), archive.getinfo("boundary.dll").file_size)
            self.assertEqual("console", verify_package(target, "console")["component"])
            (publish / "boundary.dll").write_bytes(exact + b"x")
            with self.assertRaises(ValueError): package_component("console", publish, base / "over-limit.zip", "b" * 40)
            self.assertFalse((base / "over-limit.zip").exists())

            aggregate = base / "aggregate.zip"
            with zipfile.ZipFile(aggregate, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                with zipfile.ZipFile(target) as valid:
                    for name in valid.namelist():
                        if name != "kit-manifest.json":
                            archive.writestr(name, valid.read(name))
                    manifest = json.loads(valid.read("kit-manifest.json"))
                # Recreate the manifest last, so the sole invalid property is size.
                # The accepted boundary member is already 100 MiB.
                for index in range(10):
                    name = f"extra{index}.dll"
                    archive.writestr(name, exact)
                    manifest["sha256"][name] = hashlib.sha256(exact).hexdigest().upper()
                archive.writestr("kit-manifest.json", json.dumps(manifest))
            with zipfile.ZipFile(aggregate) as archive:
                self.assertGreater(sum(item.file_size for item in archive.infolist()), 1024 * 1024 * 1024)
            with self.assertRaisesRegex(ValueError, "Unsafe archive member"):
                verify_package(aggregate, "console")

    def test_operator_bundle_copies_exact_source_helper_and_guide(self):
        from build_independent_demo_kit import bundle_operator_files
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            source = base / "source"
            (source / "tools").mkdir(parents=True)
            (source / "docs").mkdir()
            (source / "tools/Install-CabinetDemoAgent.ps1").write_bytes(b"trusted helper")
            (source / "tools/Restore-CabinetDemoAgent.ps1").write_bytes(b"trusted recovery helper")
            (source / "docs/independent-demo-kit.md").write_bytes(b"trusted guide")
            for name in ("office_renewal_operator.py", "office_renewal_preflight.py", "issue_office_enrollment.py"):
                (source / "tools" / name).write_bytes(name.encode())
            for name in ("demo-credential-renewal.md", "independent-demo-server.md"):
                (source / "docs" / name).write_bytes(name.encode())
            output = base / "kit"
            output.mkdir()
            for name in ("agent", "console"):
                (output / f"cabinet-{name}.zip").write_bytes(name.encode())
            bundle_operator_files(source, output, "a" * 40)
            evidence = json.loads((output / "release-evidence.json").read_text())
            self.assertEqual("a" * 40, evidence["sourceCommit"])
            self.assertEqual({"cabinet-agent.zip", "cabinet-console.zip", "Install-CabinetDemoAgent.ps1", "Restore-CabinetDemoAgent.ps1",
                              "independent-demo-kit.md", "office_renewal_operator.py", "office_renewal_preflight.py",
                              "issue_office_enrollment.py", "demo-credential-renewal.md", "independent-demo-server.md"}, set(evidence["sha256"]))
            for name, digest in evidence["sha256"].items():
                self.assertEqual(hashlib.sha256((output / name).read_bytes()).hexdigest().upper(), digest)
                if name.endswith((".py", ".md", ".ps1")):
                    folder = "docs" if name.endswith(".md") else "tools"
                    self.assertEqual((source / folder / name).read_bytes(), (output / name).read_bytes())
            self.assertEqual(b"trusted helper", (output / "Install-CabinetDemoAgent.ps1").read_bytes())

    def test_helper_contract_keeps_install_and_enrollment_separate(self):
        helper = (ROOT / "tools/Install-CabinetDemoAgent.ps1").read_text()
        self.assertIn("CabinetPlatformAgent", helper)
        self.assertIn("C:\\Program Files\\Mashura\\CabinetAgent", helper)
        self.assertIn("LocalSystem", helper)
        self.assertIn("Start-Service", helper)
        self.assertIn("office-enrollment.json", helper)
        self.assertIn("ExpectedSha256", helper)
        self.assertIn("ExpectedSourceCommit", helper)
        self.assertIn("[IO.FileShare]::Read", helper)
        self.assertIn("ComputeHash($packageStream)", helper)
        self.assertIn("ZipArchive]::new($packageStream", helper)
        self.assertIn("$packageStream.Dispose()", helper)
        self.assertIn("$PSVersionTable.PSVersion.Major", helper)
        self.assertIn("ExpiresUtc", helper)
        self.assertIn("Json-TopString $script:jsonTokens", helper)
        self.assertIn("Get-Service -Name $serviceName", helper)
        for forbidden in ("ExecutionPolicy Bypass", "Set-ExecutionPolicy", "DisableRealtimeMonitoring", "Expand-Archive", "Invoke-Expression"):
            self.assertNotIn(forbidden, helper)


if __name__ == "__main__":
    unittest.main()
