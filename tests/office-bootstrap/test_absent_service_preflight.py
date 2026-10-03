"""Fail-closed, nonsecret offline evidence triage for issue #35."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / 'tools/absent_service_recovery_preflight.py'
FIXTURE = Path(__file__).with_name('fixtures') / 'absent-service-evidence.json'
SPEC = importlib.util.spec_from_file_location('absent_service_preflight', TOOL)
assert SPEC is not None and SPEC.loader is not None
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)


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

    def test_mixed_case_equal_digests_do_not_disagree(self):
        evidence = json.loads(FIXTURE.read_text())
        evidence['backups']['original_copy']['device_sha256'] = 'ABCDEF' * 10 + 'abcd'
        evidence['backups']['original_installed']['device_sha256'] = 'abcdef' * 10 + 'ABCD'
        report = json.loads(self.run_evidence(evidence).stdout)
        self.assertNotIn('ORIGINAL_COPIES_DISAGREE', report['gaps'])
        self.assertEqual(report['decision'], 'NO_GO')

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

    def test_unknown_flag_with_evidence_does_not_echo_value(self):
        evidence = json.loads(FIXTURE.read_text())
        result = self.run_evidence(evidence, '--token=SECRET_SENTINEL')
        self.assertEqual(result.returncode, 2)
        self.assertNotIn('SECRET_SENTINEL', result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['gaps'], ['INVALID_EVIDENCE'])

    def test_help_cannot_bypass_no_go(self):
        result = subprocess.run([sys.executable, '-B', str(TOOL), '--help'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        report = json.loads(result.stdout)
        self.assertEqual(report['decision'], 'NO_GO')
        self.assertEqual(report['gaps'], ['INVALID_EVIDENCE'])

    def test_size_growth_after_fstat_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            path.write_text(FIXTURE.read_text())
            path.chmod(0o600)
            original_fstat = os.fstat

            def grow_after_fstat(fd):
                info = original_fstat(fd)
                with path.open('a') as stream:
                    stream.write(' ' * 8193)
                return info

            with patch.object(PREFLIGHT.os, 'fstat', grow_after_fstat):
                with self.assertRaises(PREFLIGHT.InvalidEvidence):
                    PREFLIGHT.read_evidence(path)

    def test_symlink_swapped_at_open_is_rejected(self):
        if not hasattr(os, 'O_NOFOLLOW'):
            self.skipTest('O_NOFOLLOW unavailable')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            target = Path(directory) / 'target.json'
            path.write_text(FIXTURE.read_text())
            target.write_text(FIXTURE.read_text())
            path.chmod(0o600)
            target.chmod(0o600)
            original_open = os.open

            def swap_before_open(candidate, flags, *args, **kwargs):
                path.unlink()
                path.symlink_to(target)
                return original_open(candidate, flags, *args, **kwargs)

            with patch.object(PREFLIGHT.os, 'open', swap_before_open):
                with self.assertRaises((PREFLIGHT.InvalidEvidence, OSError)):
                    PREFLIGHT.read_evidence(path)

    def test_symlink_is_rejected_without_nofollow_support(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'target.json'
            path = Path(directory) / 'evidence.json'
            target.write_text(FIXTURE.read_text())
            target.chmod(0o600)
            path.symlink_to(target)
            with patch.object(PREFLIGHT.os, 'O_NOFOLLOW', 0, create=True):
                with self.assertRaises(PREFLIGHT.InvalidEvidence):
                    PREFLIGHT.read_evidence(path)

    def test_no_enrollment_or_write_switch(self):
        result = subprocess.run([sys.executable, str(TOOL), '--enrollment-file', 'SECRET_SENTINEL'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('SECRET_SENTINEL', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
