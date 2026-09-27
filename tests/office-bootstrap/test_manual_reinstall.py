"""Manual reinstall is a distinct supported two-phase operation, not an upgrade alias."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class ManualReinstallContract(unittest.TestCase):
    def test_two_phase_entrypoint_and_private_sealed_manifest(self):
        text = (ROOT / 'tools/Manual-Reinstall-CabinetDemoAgent.ps1').read_text()
        for marker in ('Prepare', 'Restore', 'ProtectedData', 'LocalMachine',
                       'CreateFromSnapshot', 'Service-Delete',
                       'Assert-ExecutionEnvironment', 'Same-Tree', 'Service-Start'):
            self.assertIn(marker, text)
        self.assertNotIn('EnrollmentFile', text)

    def test_builder_inventories_operator_entrypoint(self):
        text = (ROOT / 'tools/build_independent_demo_kit.py').read_text()
        self.assertIn('Manual-Reinstall-CabinetDemoAgent.ps1', text)


if __name__ == '__main__':
    unittest.main()
