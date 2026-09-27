"""Portable guards for the native fixture's privileged cleanup boundary."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
PARENT = ROOT / "Test-ManualReinstallNative.ps1"
CHILD = ROOT / "Test-ManualReinstallNativeChild.ps1"
GUARD = ROOT / "DisposableServiceFixture.ps1"


def assert_manifest_binding(test, source):
    """Reject any second assignment, including one inserted between two gates."""
    assignments = list(re.finditer(r"(?im)^\s*\$fixtureManifestPath\s*=", source))
    test.assertEqual(1, len(assignments), "fixture manifest binding must be unique")
    test.assertRegex(source, r"(?im)^\s*Set-Variable\s+-Name\s+fixtureManifestPath\s+-Option\s+ReadOnly\b")
    test.assertLess(source.index('Set-Variable -Name fixtureManifestPath -Option ReadOnly'),
                    source.index('[IO.File]::WriteAllText($intent'))
    test.assertNotRegex(source, r"(?im)^\s*\$(?:manifest|fixtureManifestPath)\s*=.*ConvertTo-Json")
    gates = re.findall(r"-Action\s+(?:Gate|Cleanup)\s+-Manifest\s+\$([\w]+)", source)
    test.assertTrue(gates)
    test.assertEqual({"fixtureManifestPath"}, set(gates))


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
        self.assertIn('-Manifest $fixtureManifestPath', cleanup)

    def test_fixture_path_survives_intervening_package_assignment(self):
        parent = PARENT.read_text()
        assert_manifest_binding(self, parent)
        self.assertRegex(parent, r"\$packageManifestJson\s*=.*ConvertTo-Json")
        with self.assertRaises(AssertionError):
            assert_manifest_binding(self, parent.replace(
                " if ($LASTEXITCODE -ne 0) { throw 'Fixture gate failed before child.' }",
                " $fixtureManifestPath=$packageManifestJson\n if ($LASTEXITCODE -ne 0) { throw 'Fixture gate failed before child.' }"))

    def test_guest_approval_is_independent_of_detected_vm(self):
        guard = GUARD.read_text()
        self.assertIn('ApprovedGuestIdentity', guard)
        self.assertIn('ApprovedSnapshot', guard)
        self.assertIn('$product.UUID -cne $ApprovedGuestIdentity', guard)
        self.assertIn('-ApprovedGuestIdentity $ApprovedGuestIdentity', PARENT.read_text())

    def test_legacy_native_entrypoints_refuse_before_effects(self):
        for name in ('Test-RecoveryScmProbe.ps1', 'Test-RecoveryCleanNative.ps1'):
            text = (ROOT / name).read_text()
            self.assertLess(text.index('throw "Native fixture disabled'), text.index('New-Item'))

    def test_audit_readback_and_separate_owner_group_scenarios(self):
        parent = PARENT.read_text()
        audit = (ROOT / 'Set-DisposableAuditFixture.ps1').read_text()
        self.assertIn('Set-DisposableAuditFixture.ps1', parent)
        self.assertIn('if($LASTEXITCODE -ne 0)', parent)
        self.assertLess(audit.index('-Action Gate'), audit.index('::Audit($service)'))
        for marker in ('AdjustTokenPrivileges', 'LookupPrivilegeValue', 'QueryServiceObjectSecurity',
                       'SeSecurityPrivilege', 'ERROR_NOT_ALL_ASSIGNED', 'RawSecurityDescriptor',
                       'AuditReadback'):
            self.assertIn(marker, audit)
        for marker in ("'owner'", "'group'", '::Owner($held)', '::Group($held)'):
            self.assertIn(marker, parent)

    def test_manifest_is_new_only_and_cleanup_refuses_linked_tree(self):
        parent = PARENT.read_text()
        guard = GUARD.read_text()
        self.assertIn('[IO.FileMode]::CreateNew', parent)
        self.assertIn('Get-ChildItem -LiteralPath $target.Root -Recurse -Force', guard)
        self.assertLess(guard.index('Get-ChildItem -LiteralPath $target.Root -Recurse -Force'),
                        guard.index('Remove-Item -LiteralPath $target.Root'))


if __name__ == "__main__":
    unittest.main()
