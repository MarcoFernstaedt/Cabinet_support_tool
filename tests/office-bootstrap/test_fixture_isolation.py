"""Portable guards for the native fixture's privileged cleanup boundary."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
PARENT = ROOT / "Test-ManualReinstallNative.ps1"
CHILD = ROOT / "Test-ManualReinstallNativeChild.ps1"
GUARD = ROOT / "DisposableServiceFixture.ps1"


class FixtureIsolation(unittest.TestCase):
    def test_parent_cannot_dot_source_production_helper_or_cleanup_from_ambient_target(self):
        text = PARENT.read_text()
        self.assertNotIn(". $helper", text)
        self.assertNotIn("Stop-Service $serviceName", text)
        self.assertNotIn("delete $serviceName", text)
        self.assertNotIn("Remove-Item -LiteralPath $root -Recurse", text)
        self.assertIn("DisposableServiceFixture.ps1", text)
        self.assertIn("-Action Cleanup", text)
        self.assertIn("if ($LASTEXITCODE -ne 0)", text)

    def test_all_destructive_actions_use_manifest_and_vm_gate(self):
        text = GUARD.read_text()
        for marker in ("Win32_ComputerSystem", "Win32_ComputerSystemProduct", "MachineGuid",
                       "CabinetManualProbe-", "CabinetPlatformAgent", "[IO.Path]::GetFullPath",
                       "PathName", "Get-FileHash", "Stop-Service", "sc.exe", "Remove-Item"):
            self.assertIn(marker, text)
        self.assertIn("Assert-Fixture", text)
        self.assertIn("-Action Gate", CHILD.read_text())
        # A manifest field must not be treated as permission to target the real service.
        self.assertIn("if ($service -ceq 'CabinetPlatformAgent')", text)

    def test_overwritten_parent_variables_are_not_cleanup_authority(self):
        parent = PARENT.read_text()
        cleanup = parent.rsplit('} finally {', 1)[-1]
        # The incident's ambient $serviceName was overwritten by dot sourcing.
        # Even with a hostile assignment before finally, it is not a cleanup operand.
        hostile = parent.rsplit('} finally {', 1)[0] + "$serviceName='CabinetPlatformAgent'\n} finally {" + cleanup
        self.assertIn("$serviceName='CabinetPlatformAgent'", hostile)
        for name in ('$serviceName', '$root', '$install', '$helper'):
            self.assertNotIn(name, cleanup)
        self.assertIn('-Manifest $manifest', cleanup)


if __name__ == "__main__":
    unittest.main()
