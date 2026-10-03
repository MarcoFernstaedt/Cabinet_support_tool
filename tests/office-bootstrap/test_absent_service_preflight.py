"""Fail-closed, nonsecret offline evidence triage for issue #35."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / 'tools/absent_service_recovery_preflight.py'
FIXTURE = Path(__file__).with_name('fixtures') / 'absent-service-evidence.json'


class AbsentServicePreflightTests(unittest.TestCase):
    def run_evidence(self, evidence, *args):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            path.write_text(json.dumps(evidence))
            path.chmod(0o600)
            return subprocess.run([sys.executable, str(TOOL), '--evidence', str(path), *args],
                                  capture_output=True, text=True)

    def test_exact_absent_case_reports_gaps_and_never_go(self):
        evidence = json.loads(FIXTURE.read_text())
        result = self.run_evidence(evidence)
        self.assertEqual(result.returncode, 2, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['decision'], 'NO_GO')
        self.assertEqual(report['scenario'], 'ABSENT_SERVICE_ABSENT_INSTALL_ORIGINAL_BACKUP')
        self.assertIn('PROVENANCE_UNVERIFIED', report['gaps'])
        self.assertIn('ACL_UNVERIFIED', report['gaps'])
        self.assertIn('SCM_DEFINITION_MISSING', report['gaps'])
        self.assertIn('IDENTITY_MATCH_UNVERIFIED', report['gaps'])
        self.assertIn('ROLLBACK_BOUNDARY_UNVERIFIED', report['gaps'])
        self.assertIn('JOURNAL_ADVANCEMENT_UNKNOWN', report['gaps'])
        self.assertIn('SERVER_COMPATIBILITY_UNVERIFIED', report['gaps'])

    def test_digest_mismatch_and_incident_copy_are_not_accepted_as_original(self):
        evidence = json.loads(FIXTURE.read_text())
        evidence['backups']['original_installed']['state_sha256'] = 'b' * 64
        evidence['backups']['incident_copy']['device_sha256'] = 'c' * 64
        report = json.loads(self.run_evidence(evidence).stdout)
        self.assertIn('ORIGINAL_COPIES_DISAGREE', report['gaps'])
        self.assertNotIn('incident_copy', json.dumps(report))  # never promote or disclose incident evidence

    def test_fresh_enrollment_and_other_shapes_are_refused(self):
        evidence = json.loads(FIXTURE.read_text())
        evidence['intent'] = 'fresh_enrollment'
        report = json.loads(self.run_evidence(evidence).stdout)
        self.assertEqual(report['gaps'], ['SCENARIO_REFUSED'])
        evidence['intent'] = 'same_identity_recovery'
        evidence['service'] = 'running'
        self.assertEqual(json.loads(self.run_evidence(evidence).stdout)['gaps'], ['SCENARIO_REFUSED'])

    def test_unknown_or_secret_bearing_fields_refused_without_echo(self):
        evidence = json.loads(FIXTURE.read_text())
        evidence['device_key'] = 'SECRET_SENTINEL'
        result = self.run_evidence(evidence)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['gaps'], ['INVALID_EVIDENCE'])
        self.assertNotIn('SECRET_SENTINEL', result.stdout + result.stderr)

    def test_duplicate_fields_and_malformed_input_refused_without_echo(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            path.write_text('{"intent":"SECRET_SENTINEL","intent":"same_identity_recovery"}')
            result = subprocess.run([sys.executable, str(TOOL), '--evidence', str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)['gaps'], ['INVALID_EVIDENCE'])
            self.assertNotIn('SECRET_SENTINEL', result.stdout + result.stderr)

    def test_self_asserted_complete_evidence_is_not_write_authority(self):
        evidence = json.loads(FIXTURE.read_text())
        evidence['evidence'] = dict.fromkeys(evidence['evidence'], True)
        result = self.run_evidence(evidence)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['gaps'], ['INDEPENDENT_REVIEW_AND_NATIVE_REHEARSAL_REQUIRED'])

    def test_world_readable_evidence_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            path.write_text(FIXTURE.read_text())
            path.chmod(0o644)
            result = subprocess.run([sys.executable, str(TOOL), '--evidence', str(path)],
                                    capture_output=True, text=True)
            self.assertEqual(json.loads(result.stdout)['gaps'], ['INVALID_EVIDENCE'])

    def test_no_enrollment_or_write_switch(self):
        result = subprocess.run([sys.executable, str(TOOL), '--enrollment-file', 'SECRET_SENTINEL'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('SECRET_SENTINEL', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
