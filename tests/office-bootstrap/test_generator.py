"""Black-box tests for the staging generator; never contacts a server."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "prepare_office_demo.py"
ENDPOINT = "https://srv1522777.tail72f980.ts.net/"


class OfficeGeneratorTests(unittest.TestCase):
    def test_runtime_paths_stay_inside_fixed_protected_installation(self):
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / "new"
            result = subprocess.run([sys.executable, str(SCRIPT), "--config-only", "--output", str(out)], capture_output=True, text=True)
            self.assertEqual(0, result.returncode, result.stderr)
            settings = json.loads((out / "agent/appsettings.json").read_text())
            base = "C:/Program Files/Mashura/CabinetAgent/"
            self.assertEqual(base + "state", settings["Agent"]["StateDirectory"])
            self.assertEqual(base + "logs", settings["Agent"]["LogDirectory"])
            self.assertEqual(base + "buffer", settings["Agent"]["Buffer"]["Directory"])
            self.assertEqual(base + "bundles", settings["Agent"]["Actions"]["DiagnosticBundleDirectory"])
            file_sink = next(s for s in settings["Serilog"]["WriteTo"] if s["Name"] == "File")
            self.assertEqual(base + "logs/agent-.log", file_sink["Args"]["path"])

    def test_configs_share_endpoint_and_each_token_is_unique_and_server_hashed(self):
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / "new"
            result = subprocess.run([sys.executable, str(SCRIPT), "--config-only", "--output", str(out), "--devices", "2"], capture_output=True, text=True)
            self.assertEqual(0, result.returncode, result.stderr)
            agent = json.loads((out / "agent/appsettings.json").read_text())
            console = json.loads((out / "console/appsettings.json").read_text())
            server = json.loads((out / "server/office-enrollment.json").read_text())["OfficeEnrollment"]
            self.assertEqual(ENDPOINT, agent["Agent"]["ServerBaseUrl"])
            self.assertEqual(ENDPOINT, console["Api"]["BaseAddress"])
            self.assertEqual("office-enrollment.json", agent["Agent"]["OfficeEnrollmentFile"])
            tokens = [json.loads(p.read_text())["Token"] for p in sorted((out / "enrollment").glob("*.json"))]
            self.assertEqual(2, len(set(tokens)))
            self.assertEqual({hashlib.sha256(t.encode()).hexdigest().upper() for t in tokens}, {t["TokenHash"] for t in server["Tokens"]})
            for token in tokens:
                self.assertNotIn(token, result.stdout + result.stderr)
                self.assertNotIn(token, json.dumps(agent) + json.dumps(console) + json.dumps(server))
            self.assertEqual([], json.loads((out / "server/grants.json").read_text()))
            self.assertEqual(str(out / "server/grants.json"), server["StateFile"])
            manifest = json.loads((out / "manifest.json").read_text())
            self.assertEqual("BLOCKED", manifest["distribution"])
            self.assertFalse(manifest["signed"])
            self.assertFalse(manifest["binariesBuilt"])
            self.assertEqual(0o700, out.stat().st_mode & 0o777)
            self.assertTrue(all(p.stat().st_mode & 0o077 == 0 for p in out.rglob("*") if p.is_file()))
            repeated = subprocess.run([sys.executable, str(SCRIPT), "--config-only", "--output", str(out)], capture_output=True, text=True)
            self.assertNotEqual(0, repeated.returncode)
            self.assertEqual(tokens, [json.loads(p.read_text())["Token"] for p in sorted((out / "enrollment").glob("*.json"))])

    def test_bad_endpoint_or_count_produces_no_output(self):
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / "new"
            bad = ["http://srv1522777.tail72f980.ts.net/", "https://evil.example/", "https://user@srv1522777.tail72f980.ts.net/", ENDPOINT + "api", ENDPOINT + "?query=1", ENDPOINT + "#fragment"]
            for endpoint in bad:
                with self.subTest(endpoint=endpoint):
                    result = subprocess.run([sys.executable, str(SCRIPT), "--config-only", "--output", str(out), "--endpoint", endpoint], capture_output=True, text=True)
                    self.assertNotEqual(0, result.returncode)
                    self.assertFalse(out.exists())
            for count in ["0", "-1", "11"]:
                result = subprocess.run([sys.executable, str(SCRIPT), "--config-only", "--output", str(out), "--devices", count], capture_output=True, text=True)
                self.assertNotEqual(0, result.returncode)
                self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
