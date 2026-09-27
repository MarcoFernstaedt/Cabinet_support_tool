"""Compile and execute the recovery reader's restricted-token contract offline."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
DOTNET = shutil.which("dotnet") or "/home/marco/tmp/cabinet-audit-dotnet/dotnet"


class RecoveryReaderPortableTests(unittest.TestCase):
    def test_reader_does_not_attempt_to_enable_inspector_privileges(self):
        # Compile the actual sidecar, not a Python copy of its declarations. Linux
        # cannot accept a Windows OpenProcess call, but can inspect compiled imports
        # and execute the refusal path without touching any Windows host.
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            shutil.copyfile(ROOT / "tools/RecoveryProcess.cs", folder / "RecoveryProcess.cs")
            (folder / "Probe.csproj").write_text(
                '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>'
                '<OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework>'
                '</PropertyGroup></Project>')
            (folder / "Program.cs").write_text(r'''
using System;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
var reader = typeof(CabinetRecoveryProcess);
var methods = reader.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
var imports = methods.Where(m => m.GetCustomAttribute<DllImportAttribute>() != null)
    .Select(m => m.Name).ToArray();
if (imports.Contains("AdjustTokenPrivileges") || imports.Contains("LookupPrivilegeValue") ||
    imports.Contains("GetCurrentProcess"))
    throw new Exception("Reader still imports inspector privilege mutation APIs");
if (!imports.Contains("OpenProcess") || !imports.Contains("OpenProcessToken"))
    throw new Exception("Reader must still open the target and query its SID");
if (!OperatingSystem.IsWindows()) {
    try { CabinetRecoveryProcess.Read(-1); throw new Exception("Unexpected native read success"); }
    catch (DllNotFoundException) { Console.WriteLine("PASS: native read refused, no privilege API imported"); }
}
''')
            result = subprocess.run([DOTNET, "run", "--project", str(folder / "Probe.csproj"),
                                     "-c", "Release", "--nologo"], cwd=folder,
                                    capture_output=True, text=True, timeout=90,
                                    env={**os.environ, "DOTNET_CLI_TELEMETRY_OPTOUT": "1"})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("PASS: native read refused", result.stdout)


if __name__ == "__main__":
    unittest.main()
