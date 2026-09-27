"""Portable PowerShell subprocess contract; inert dependencies, never native SCM.

Requires PWSH=/absolute/path/to/a verified PowerShell 7 binary. This does not
replace the Windows PowerShell 5.1 disposable guest acceptance fixture.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class NativeProtocol(unittest.TestCase):
    pwsh: str

    @classmethod
    def setUpClass(cls):
        candidate = os.environ.get('PWSH') or shutil.which('pwsh')
        if not candidate or not Path(candidate).is_file():
            raise unittest.SkipTest('BLOCKED: verified pwsh executable unavailable; no runtime proof')
        cls.pwsh = str(Path(candidate).resolve())

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.install = self.root / 'Synthetic'
        self.install.mkdir()
        kit = self.root / 'Kit'
        kit.mkdir()
        self.manual = kit / 'Manual-Reinstall-CabinetDemoAgent.ps1'
        self.guard = self.root / 'DisposableServiceFixture.ps1'
        self.child = self.root / 'Test-ManualReinstallNativeChild.ps1'
        self.child.write_text((ROOT / self.child.name).read_text())
        (self.root / 'fixture-target.json').write_text(json.dumps({'Service': 'InertProbe', 'Root': str(self.root)}))
        # The real child resolves a Windows PowerShell path. Redirect only that
        # executable in a disposable tree, without editing its control flow.
        system = self.root / 'System32/WindowsPowerShell/v1.0'
        system.mkdir(parents=True)
        (system / 'powershell.exe').symlink_to(self.pwsh)
        self.guard.write_text("if($env:GUARD_MODE -eq 'fail'){Write-Output 'NO';exit 9}\n"
                              "if($env:GUARD_MODE -eq 'missing'){exit 0}\n"
                              "if($env:GUARD_MODE -eq 'wrong'){Write-Output 'WRONG';exit 0}\n"
                              "Write-Output 'EXACT_FIXTURE_GATE_PASS'\n"
                              "if($env:GUARD_MODE -eq 'extra'){Write-Output 'EXTRA'}\n")
        self.manual.write_text("param([switch]$Prepare,[switch]$ConfirmSameMachine,[string]$BackupRoot)\n"
                               "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'manual-invoked'), 'yes')\n"
                               "if($env:MANUAL_MODE -eq 'return'){return}\n"
                               "if($env:MANUAL_MODE -eq 'duplicate'){Write-Output 'EXPECTED_METADATA_REFUSAL'}\n"
                               "if($env:MANUAL_MODE -eq 'unrelated'){throw 'Unrelated failure'}\n"
                               "if($env:MANUAL_MODE -eq 'wrong-exit'){[Environment]::Exit(7)}\n"
                               "throw 'Recovery refused: Unsupported original service security metadata.'\n")
        source = (ROOT / 'Test-ManualReinstallNative.ps1').read_text()
        # Execute the actual parent child capture, exit assignment, and metadata
        # acceptance block, not a Python reimplementation of its predicate.
        begin = ' $prepareEvidence=@(& $powershell '
        end = ' $prepareEvidence | Write-Output\n'
        self.assertEqual(1, source.count(begin), 'Parent protocol start is ambiguous')
        self.assertEqual(1, source.count(end), 'Parent protocol end is ambiguous')
        block = begin + source.split(begin, 1)[1].split(end, 1)[0]
        self.assertIn(" Write-Output \"PASS unsupported $Scenario refused before stop\"\n  return\n }\n", block)
        self.parent = self.root / 'ParentProtocol.ps1'
        self.parent.write_text("$ErrorActionPreference='Stop';Set-StrictMode -Version Latest\n"
                               "$powershell='" + str(system / 'powershell.exe').replace("'", "''") + "'\n"
                               "$child='" + str(self.child).replace("'", "''") + "'\n"
                               "$root='" + str(self.root).replace("'", "''") + "'\n"
                               "$install='" + str(self.install).replace("'", "''") + "'\n"
                               "$serviceName='InertProbe';$backup='unused';$zip='unused';$digest='unused';$commit='unused'\n"
                               "$Scenario='owner';$ApprovedGuestIdentity='inert';$ApprovedSnapshot='inert'\n"
                               "function Get-CimInstance { [pscustomobject]@{State=$env:STATE_MODE;StartMode=$env:START_MODE} }\n"
                               + block)
        self.syntax = self.root / 'Assert-Syntax.ps1'
        self.syntax.write_text("param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Paths)\n"
                          "foreach($path in $Paths){\n"
                          " $tokens=$null;$errors=$null\n"
                          " $null=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)\n"
                          " if($errors.Count){throw \"Invalid PowerShell syntax in $path : $($errors -join '; ')\"}\n"
                          " Write-Output \"PARSED=$path\"\n"
                          "}\n")
        parsed = subprocess.run([self.pwsh, '-NoProfile', '-NonInteractive', '-File',
                                 str(self.syntax), str(self.parent), str(self.child)],
                                text=True, capture_output=True, timeout=30)
        self.assertEqual(0, parsed.returncode, parsed.stderr)
        self.assertEqual('', parsed.stderr)
        self.assertEqual([f'PARSED={path}' for path in (self.parent, self.child)],
                         parsed.stdout.splitlines())

    def run_case(self, guard='ok', manual='refuse', state='Running', start='Auto'):
        env = dict(os.environ, SystemRoot=str(self.root), GUARD_MODE=guard,
                   MANUAL_MODE=manual, STATE_MODE=state, START_MODE=start)
        return subprocess.run([self.pwsh, '-NoProfile', '-NonInteractive', '-File', str(self.parent)],
                              env=env, text=True, capture_output=True, timeout=30)

    def test_syntax_gate_rejects_broken_child(self):
        self.child.write_text(self.child.read_text() + '\nif ($true) {\n')
        result = subprocess.run([self.pwsh, '-NoProfile', '-NonInteractive', '-File',
                                 str(self.syntax), str(self.parent), str(self.child)],
                                text=True, capture_output=True, timeout=30)
        self.assertNotEqual(0, result.returncode)
        self.assertEqual([f'PARSED={self.parent}'], result.stdout.splitlines())
        self.assertIn('Invalid PowerShell syntax', result.stderr)
        self.assertIn(self.child.name, result.stderr)

    def test_two_successful_nested_gates_leave_one_exact_marker(self):
        result = self.run_case()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(['PREPARE_EXIT=42', 'PASS unsupported owner refused before stop'],
                         result.stdout.splitlines())
        self.assertEqual('', result.stderr)

    def test_guard_failure_or_extra_banner_is_fatal(self):
        for mode in ('fail', 'extra', 'missing', 'wrong'):
            with self.subTest(mode=mode):
                (self.manual.parent / 'manual-invoked').unlink(missing_ok=True)
                result = self.run_case(guard=mode)
                self.assertNotEqual(0, result.returncode)
                self.assertNotIn('PASS unsupported', result.stdout)
                self.assertIn('Child fixture isolation gate refused.', result.stderr)
                self.assertFalse((self.manual.parent / 'manual-invoked').exists(), result.stderr)
                self.assertIn('PREPARE_EXIT=1', result.stdout)

    def test_unrelated_return_and_duplicate_marker_are_not_refusal(self):
        diagnostics = {'unrelated': 'Unrelated failure',
                       'return': 'Expected production metadata refusal did not occur.',
                       'duplicate': 'Expected production metadata refusal evidence missing',
                       'wrong-exit': 'Expected production metadata refusal evidence missing'}
        for mode, diagnostic in diagnostics.items():
            with self.subTest(mode=mode):
                result = self.run_case(manual=mode)
                self.assertNotEqual(0, result.returncode)
                self.assertNotIn('PASS unsupported', result.stdout)
                self.assertIn(diagnostic, result.stderr)
                self.assertTrue((self.manual.parent / 'manual-invoked').exists(), result.stderr)
                self.assertIn('PREPARE_EXIT=' + ('7' if mode == 'wrong-exit' else '42' if mode == 'duplicate' else '1'), result.stdout)

    def test_state_and_installation_are_independent(self):
        for state, start in (('Stopped', 'Auto'), ('Running', 'Manual')):
            with self.subTest(state=state, start=start):
                result = self.run_case(state=state, start=start)
                self.assertNotEqual(0, result.returncode)
                self.assertNotIn('PASS unsupported', result.stdout)
                self.assertIn('Unsupported metadata interrupted original Running Auto service', result.stderr)
        self.install.rmdir()
        result = self.run_case()
        self.assertNotEqual(0, result.returncode)
        self.assertNotIn('PASS unsupported', result.stdout)
        self.assertIn('Unsupported metadata interrupted original Running Auto service', result.stderr)


if __name__ == '__main__':
    unittest.main()
