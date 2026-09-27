"""Black-box tests for the private two-site scenario runner."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "tools/run_two_site_demo.py"


class TwoSiteRunnerTests(unittest.TestCase):
    def test_existing_output_is_refused_without_changing_it(self):
        with tempfile.TemporaryDirectory(prefix="two-site-preserve-") as temp:
            output = Path(temp) / "existing"
            output.mkdir()
            marker = output / "keep.txt"
            marker.write_text("preserve")
            result = subprocess.run(["python3", str(RUNNER), "--output", str(output), "--dotnet", "/missing-sdk"],
                                    text=True, capture_output=True, timeout=10)
            self.assertNotEqual(0, result.returncode)
            self.assertIn("already exists", result.stderr)
            self.assertEqual("preserve", marker.read_text())
            self.assertEqual([marker], list(output.iterdir()))

    def test_source_tree_output_is_refused_before_creating_files(self):
        output = ROOT / "two-site-evidence-must-not-exist"
        self.assertFalse(output.exists())
        result = subprocess.run(["python3", str(RUNNER), "--output", str(output), "--dotnet", "/missing-sdk"],
                                text=True, capture_output=True, timeout=10)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("outside", result.stderr)
        self.assertFalse(output.exists())

    def test_executes_real_scenario_and_writes_private_honest_report(self):
        self.assertTrue(RUNNER.exists(), "The repeatable two-site scenario runner is missing")
        sdk = os.environ.get("CABINET_TEST_DOTNET", "dotnet")
        with tempfile.TemporaryDirectory(prefix="two-site-runner-test-") as temp:
            output = Path(temp) / "evidence"
            result = subprocess.run(["python3", str(RUNNER), "--output", str(output), "--dotnet", sdk],
                                    cwd=ROOT, text=True, capture_output=True, timeout=180)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            report = json.loads((output / "scenario.json").read_text())
            self.assertTrue(report["simulation"])
            self.assertEqual((2, 5), (report["siteCount"], report["cabinetCount"]))
            manifest = json.loads((output / "evidence.json").read_text())
            self.assertEqual(1, manifest["passed"])
            self.assertEqual(0, manifest["failed"])
            self.assertEqual(0, manifest["exitCode"])
            html = (output / "index.html").read_text()
            self.assertIn("SIMULATION", html)
            self.assertIn("Q site", html)
            self.assertIn("Second site", html)
            self.assertIn("MST", html)
            self.assertIn("NOT RUN", html)
            for path in output.rglob("*"):
                self.assertEqual(0, path.stat().st_mode & 0o077, str(path))


if __name__ == "__main__":
    unittest.main()
