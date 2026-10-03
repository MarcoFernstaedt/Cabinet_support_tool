"""Static guards for the nonshipping Windows-only absent-service fixture."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / 'tools/experimental/Invoke-AbsentServiceFixture.ps1'
FIXTURE = ROOT / 'tests/office-bootstrap/AbsentServiceFixture.Tests.ps1'
GUID_PREFIX = 'cabinet-absent-fixture-'

class AbsentFixtureContractTests(unittest.TestCase):
    def test_each_case_root_matches_helper_admission_rule(self):
        helper = HELPER.read_text()
        fixture = FIXTURE.read_text()
        self.assertIn(r'\\cabinet-absent-fixture-[0-9a-f]{32}$', helper)
        case_line = next(line.strip() for line in fixture.splitlines() if line.strip().startswith('$case = Join-Path'))
        self.assertIn(GUID_PREFIX, case_line, 'the path passed as -FixtureRoot needs the required prefix')
        self.assertRegex(case_line, re.compile(r'NewGuid\(\)'))

    def test_runbook_does_not_bypass_execution_policy(self):
        text = (ROOT / 'tools/experimental/README.md').read_text()
        self.assertNotIn('-ExecutionPolicy Bypass', text)

    def test_fixture_does_not_recursively_delete_temp_root(self):
        fixture = FIXTURE.read_text()
        self.assertNotIn('Remove-Item -LiteralPath $root -Recurse', fixture)

    def test_runbook_names_exact_service_and_install_checks(self):
        text = (ROOT / 'tools/experimental/README.md').read_text()
        self.assertNotIn('production installation exists', text)
        self.assertIn('CabinetPlatformAgent', text)
        self.assertIn(r'C:\Program Files\Mashura\CabinetAgent', text)

    def test_helper_retains_named_live_refusal_gates(self):
        helper = HELPER.read_text()
        self.assertIn('Get-CimInstance Win32_Service -Filter "Name=\'CabinetPlatformAgent\'"', helper)
        self.assertIn(r"Test-Path -LiteralPath 'C:\Program Files\Mashura\CabinetAgent'", helper)
        self.assertIn('if (!$FixtureOnly', helper)

    def test_runbook_separates_native_fixture_from_recovery_gates(self):
        text = (ROOT / 'tools/experimental/README.md').read_text()
        self.assertIn('13 fixture cases passed', text)
        self.assertNotIn('No Windows native run was available', text)
        self.assertIn('SCM', text)
        self.assertIn('Server', text)

if __name__ == '__main__':
    unittest.main()
