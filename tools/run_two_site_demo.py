#!/usr/bin/env python3
"""Run the disposable two-site SIMULATION; no live server or Windows APIs.

Requires the repository's .NET SDK and restored/cached dependencies. The real
Agent/Server/Console.Core integration test supplies the report only after its
assertions pass. Output is private, new-only and outside the repository.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import html
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]


def run(output, dotnet):
    output = output.absolute()
    if os.name != "posix":
        raise ValueError("Run this synthetic evidence harness on Linux; native Windows uses the separate acceptance checklist.")
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; choose a new directory to preserve evidence.")
    parent = output.parent.resolve(strict=True)
    if parent == ROOT or ROOT in parent.parents:
        raise ValueError("Evidence must be outside the source repository.")
    output = parent / output.name
    previous = os.umask(0o077)
    try:
        output.mkdir(mode=0o700)
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip())
        command = [dotnet, "test", "tests/CabinetPlatform.Agent.Tests", "-c", "Release", "-m:1", "--nologo",
                   "--filter", "FullyQualifiedName~TwoSiteOfficeDemoTests",
                   "--logger", "trx;LogFileName=scenario.trx", "--results-directory", str(output)]
        env = os.environ.copy()
        env["CABINET_TWO_SITE_REPORT"] = str(output / "scenario.json")
        with (output / "run.log").open("x") as log:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        evidence = {"sourceCommit": commit, "sourceDirty": dirty, "command": command, "exitCode": result.returncode,
                    "simulation": True, "nativeWindowsAcceptance": "NOT RUN",
                    "finishedMst": datetime.now(timezone(timedelta(hours=-7))).strftime("%Y-%m-%d %H:%M:%S MST")}
        trx = output / "scenario.trx"
        if trx.exists():
            counters = ET.parse(trx).find(".//{*}Counters")
            if counters is not None:
                evidence.update({key: int(counters.get(key, "0")) for key in ("total", "executed", "passed", "failed", "notExecuted")})
        passed = (result.returncode == 0 and evidence.get("executed") == 1 and evidence.get("passed") == 1
                  and evidence.get("failed") == 0 and evidence.get("notExecuted") == 0)
        evidence["gate"] = "PASS" if passed else "FAIL"
        (output / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        if not passed:
            raise RuntimeError(f"Scenario did not pass one executed case. See {output / 'run.log'}")
        report = json.loads((output / "scenario.json").read_text())
        if report.get("simulation") is not True or (report.get("siteCount"), report.get("cabinetCount")) != (2, 5):
            raise RuntimeError("Scenario report is missing the explicit two-site/five-cabinet simulation contract.")
        sections = "\n".join("<section><h2>" + html.escape(step["stage"]) + "</h2><pre>" +
                             html.escape(json.dumps(step, indent=2, ensure_ascii=False)) + "</pre></section>" for step in report["steps"])
        (output / "index.html").write_text("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<title>Two-site cabinet simulation evidence</title>"
            "<style>body{font:17px system-ui;background:#101820;color:#f1f5f9;max-width:1050px;margin:40px auto;padding:20px}"
            "h1,h2{color:#8ce5c4}section{border:1px solid #536574;padding:20px;margin:20px 0;border-radius:8px}"
            "pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px ui-monospace,monospace}.warning{color:#ffd38a}</style>"
            "<h1>Two-site cabinet prototype: SIMULATION</h1>"
            "<p class=\"warning\">Native Windows acceptance: NOT RUN. Private unsigned evidence, not a live cabinet dashboard.</p>"
            "<p>3 cabinets at Q site; 2 at Second site. Real one-use enrollment, supervisor approval, authenticated transport, "
            "durable outbox and Console.Core result projection. Native inputs and time are simulated.</p>"
            "<p>Source: " + html.escape(commit) + " · " + html.escape(report["generatedMst"]) + "</p>" + sections +
            "<section><h2>Teardown</h2><p>" + html.escape(report["teardown"]) + "</p></section>"
            "<p>No real database sync, firewall change, process mutation, sensor or door functionality is asserted.</p></html>")
        hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in output.iterdir() if p.is_file()}
        (output / "sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")
        print(f"PASS: 1 executed integration scenario, 5 simulated cabinets, 2 sites.\nReport: {output / 'index.html'}\nNative Windows: NOT RUN. No live service changed.")
    finally:
        for path in output.rglob("*"):
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
        os.umask(previous)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dotnet", default="dotnet")
    args = parser.parse_args()
    try:
        run(args.output, args.dotnet)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError, ET.ParseError, json.JSONDecodeError) as error:
        parser.exit(1, f"Demo refused or failed: {error}\n")


if __name__ == "__main__":
    main()
