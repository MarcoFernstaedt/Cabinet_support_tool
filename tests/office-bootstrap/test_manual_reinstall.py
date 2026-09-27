"""Manual reinstall is a distinct supported two-phase operation, not an upgrade alias."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class ManualReinstallContract(unittest.TestCase):
    def test_scm_config_query_stays_inside_documented_8192_byte_ceiling(self):
        helper = (ROOT / 'tools/Restore-CabinetDemoAgent.ps1').read_text()
        self.assertIn('needed > 8192', helper)
        self.assertNotIn('needed > 65536', helper)
        self.assertIn('QueryServiceConfig(service, buffer, needed, out needed)', helper)
        self.assertIn('QueryServiceConfig2(service, level, buffer, needed, out needed)', helper)

    def test_recovery_does_not_reapply_matching_native_audit_sacl(self):
        helper = (ROOT / 'tools/Restore-CabinetDemoAgent.ps1').read_text()
        create = helper.split('public static void CreateFromSnapshot', 1)[1].split('public static void ApplyPolicy', 1)[0]
        self.assertIn('ReadAudit(name)!=value.SecurityAudit', create)
        self.assertIn('ApplyAudit(name,value.SecurityAudit)', create)
        self.assertIn('ReadAudit(name)!=value.SecurityAudit', create.split('ApplyAudit(name,value.SecurityAudit)', 1)[1])

    def test_private_destination_precedes_each_preserved_byte_and_rechecks_identity(self):
        text = (ROOT / 'tools/Manual-Reinstall-CabinetDemoAgent.ps1').read_text()
        body = text.split('function Restore-Installation', 1)[1]
        self.assertIn('New-Item -ItemType Directory -Path $install', body)
        self.assertLess(body.index('Lock-Directory $install'), body.index('Copy-Item -LiteralPath $entry.FullName'))
        self.assertIn('Assert-Destination', body)
        self.assertNotIn('Copy-Item -LiteralPath $copy -Destination $install -Recurse', body)

    def test_metadata_and_deletion_boundary_are_preflighted(self):
        helper = (ROOT / 'tools/Restore-CabinetDemoAgent.ps1').read_text()
        manual = (ROOT / 'tools/Manual-Reinstall-CabinetDemoAgent.ps1').read_text()
        for marker in ('Preshutdown', 'SecurityAudit', 'OwnerGroup', 'Unsupported original service security metadata'):
            self.assertIn(marker, helper)
        self.assertIn('Preshutdown', manual.split('function Same-Definition')[1].split('function Snapshot-FromRecord')[0])
        self.assertLess(manual.index('$deletionRequested=$true'), manual.index('Service-WaitAbsent'))
        self.assertIn('if (!$deletionRequested -and [CabinetRecoveryDefinition]::DeletionState', manual)

    def test_two_phase_entrypoint_and_private_sealed_manifest(self):
        text = (ROOT / 'tools/Manual-Reinstall-CabinetDemoAgent.ps1').read_text()
        for marker in ('Prepare', 'Restore', 'ProtectedData', 'LocalMachine',
                       'CreateFromSnapshot', "Invoke-Sc @('delete', $serviceName)",
                       'Assert-ExecutionEnvironment', 'Same-Tree', 'Service-Start'):
            self.assertIn(marker, text)
        self.assertNotIn('EnrollmentFile', text)

    def test_builder_excludes_experimental_operator_entrypoint(self):
        text = (ROOT / 'tools/build_independent_demo_kit.py').read_text()
        self.assertNotIn('Manual-Reinstall-CabinetDemoAgent.ps1', text)
        self.assertIn('Install-CabinetDemoAgent.ps1', text)


if __name__ == '__main__':
    unittest.main()
