"""Prevent the retired Windows operator shell from returning to release source."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class WebOnlyDeliverablesTests(unittest.TestCase):
    def test_wpf_operator_project_and_native_harness_are_absent(self):
        self.assertFalse((ROOT / "src/CabinetPlatform.Console").exists())
        self.assertFalse((ROOT / "tests/CabinetPlatform.Console.NativeTests").exists())
        solution = (ROOT / "CabinetPlatform.sln").read_text()
        self.assertNotIn('"CabinetPlatform.Console",', solution)
        self.assertNotIn('"CabinetPlatform.Console.NativeTests",', solution)

    def test_release_kit_cannot_emit_windows_console(self):
        source = (ROOT / "tools/build_independent_demo_kit.py").read_text()
        self.assertNotIn('cabinet-console.zip', source)
        self.assertNotIn('"console": "Console"', source)


if __name__ == "__main__":
    unittest.main()
