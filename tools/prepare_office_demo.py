#!/usr/bin/env python3
"""Prepare unsigned, non-distributable office staging, never install or contact a server.

Generate on Linux under the authorized operator account. Token files are secrets;
all output is private, new-only and outside the source checkout. No shared key,
operator password, identity image or TLS bypass is generated.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

REPOSITORY = Path(__file__).resolve().parents[1]
TRUSTED_ENDPOINT = "https://srv1522777.tail72f980.ts.net/"


def private_json(path, value):
    """Write once with private POSIX permissions, including before content arrives."""
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, indent=2)
        stream.write("\n")


def prepare(output, devices, endpoint, dotnet, config_only):
    if os.name != "posix":
        raise ValueError("Generate on Linux; Windows token-directory ACL provisioning is not implemented here.")
    if endpoint not in (TRUSTED_ENDPOINT, TRUSTED_ENDPOINT.rstrip("/")):
        raise ValueError("Endpoint must match the reviewed office HTTPS origin exactly.")
    if not 1 <= devices <= 10:
        raise ValueError("Office staging is limited to 1 through 10 devices per bundle.")
    endpoint = TRUSTED_ENDPOINT
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists. Never overwrite credentials or a consumed enrollment journal.")
    if not output.parent.exists() or output.parent.resolve() == REPOSITORY or REPOSITORY in output.parent.resolve().parents:
        raise ValueError("Output needs an existing parent outside the repository.")
    # Resolve ancestors once before mkdir: a symlinked ancestor must not hide an
    # in-repository secret path. The operator must control this parent directory.
    output = output.parent.resolve() / output.name
    old_umask = os.umask(0o077)
    try:
        output.mkdir(mode=0o700)
        for name in ("agent", "console", "server", "enrollment", "build-logs"):
            (output / name).mkdir(mode=0o700)
        if not config_only:
            for component in ("Agent", "Console"):
                destination = output / component.lower()
                command = [dotnet, "publish", str(REPOSITORY / "src" / f"CabinetPlatform.{component}" / f"CabinetPlatform.{component}.csproj"),
                           "-c", "Release", "-r", "win-x64", "--self-contained", "true", "-m:1",
                           "-p:PublishSingleFile=false", "-p:DebugType=None", "-p:DebugSymbols=false", "-o", str(destination)]
                with (output / "build-logs" / f"{component.lower()}.log").open("x") as log:
                    result = subprocess.run(command, cwd=REPOSITORY, stdout=log, stderr=subprocess.STDOUT, check=False)
                if result.returncode:
                    raise RuntimeError(f"{component} Release publish failed; see private build-logs. No enrollment tokens were generated.")
                if not (destination / f"CabinetPlatform.{component}.exe").is_file():
                    raise RuntimeError("Publish returned success without a Windows executable.")
                for settings in destination.glob("appsettings*.json"):
                    settings.unlink()  # Only fresh publisher output, never an installed directory.

        agent = json.loads((REPOSITORY / "src/CabinetPlatform.Agent/appsettings.json").read_text())
        agent["Agent"]["ServerBaseUrl"] = endpoint
        agent["Agent"]["OfficeEnrollmentFile"] = "office-enrollment.json"
        agent["Agent"]["Actions"]["ExecutionMode"] = "DiagnosticOnly"
        private_json(output / "agent/appsettings.json", agent)
        private_json(output / "console/appsettings.json", {"Api": {"BaseAddress": endpoint, "TimeoutSeconds": 30}})
        now = datetime.now(timezone.utc)
        iso = lambda value: value.isoformat()
        token_records = []
        for device in range(1, devices + 1):
            token = secrets.token_hex(32).upper()
            private_json(output / "enrollment" / f"device-{device:03d}.json", {"ServerBaseUrl": endpoint, "Token": token})
            token_records.append({"TokenHash": hashlib.sha256(token.encode("ascii")).hexdigest().upper(),
                                  "IssuedUtc": iso(now), "ExpiresUtc": iso(now + timedelta(minutes=20)),
                                  "DeviceExpiresUtc": iso(now + timedelta(days=1))})
        private_json(output / "server/grants.json", [])
        private_json(output / "server/office-enrollment.json", {"OfficeEnrollment": {
            "Enabled": True, "StateFile": str(output / "server/grants.json"), "Tokens": token_records}})
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPOSITORY, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=REPOSITORY, text=True).strip())
        artifact_hashes = {}
        for component in ("agent", "console"):
            for artifact in sorted((output / component).rglob("*")):
                if artifact.is_file():
                    artifact_hashes[str(artifact.relative_to(output))] = hashlib.sha256(artifact.read_bytes()).hexdigest()
        private_json(output / "manifest.json", {
            "purpose": "Authorized disposable office lab staging only; not an installer",
            "endpoint": endpoint, "createdUtc": iso(now), "sourceCommit": commit, "sourceDirty": dirty,
            "devices": devices, "binariesBuilt": not config_only, "configuration": "Release",
            "signed": False, "distribution": "BLOCKED",
            "blockers": ["Deploy and independently verify the matching office server before enrollment",
                         "Native Windows 10/11 execution and SYSTEM/Administrators-only directory ACL verification",
                         "Independent review and QA", "Artifact signing and verified installation/uninstallation",
                         "Mutual TLS and production fleet security are not implemented by this office flow"],
            "sha256": artifact_hashes})
        # Publish may inherit readable modes from NuGet. Tighten all artifacts,
        # not only credentials; none of this directory is a public download.
        for path in output.rglob("*"):
            os.chmod(path, 0o700 if path.is_dir() else 0o600)
        print(f"Prepared private staging: {output}\nEndpoint: {endpoint}\nDevice token files: {devices}\nDistribution: BLOCKED; unsigned; no service changed.")
    finally:
        os.umask(old_umask)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--devices", type=int, default=1)
    parser.add_argument("--endpoint", default=TRUSTED_ENDPOINT)
    parser.add_argument("--dotnet", default="dotnet", help="SDK executable; publishes Release only")
    parser.add_argument("--config-only", action="store_true", help="Generate configuration without binaries; remains non-distributable")
    args = parser.parse_args()
    try:
        prepare(args.output, args.devices, args.endpoint, args.dotnet, args.config_only)
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Staging refused: {error}\n")


if __name__ == "__main__":
    main()
