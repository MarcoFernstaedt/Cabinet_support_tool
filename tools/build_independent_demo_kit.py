"""Build credential-free office ZIPs from an exact committed tree, never the working tree."""
import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

from prepare_office_demo import TRUSTED_ENDPOINT, REPOSITORY

COMPONENTS = {"agent": "Agent", "console": "Console"}


def assert_clean_source(status):
    if status.strip():
        raise ValueError("Source has uncommitted changes; commit and build the exact revision.")


def _safe_name(name):
    parts = name.split("/")
    return (bool(name) and len(name) <= 240 and not name.endswith("/") and
            all(part not in ("", ".", "..") and not part.endswith((".", " ")) and
                not re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", part.split(".")[0]) and
                not any(c in part for c in '\\:\0<>|"?*') for part in parts) and
            name == name.strip() and name.lower() not in ("office-enrollment.json", "kit-manifest.json"))


def _settings(component, source):
    if component == "console":
        return {"Api": {"BaseAddress": TRUSTED_ENDPOINT, "TimeoutSeconds": 30}}
    agent = json.loads((source / "src/CabinetPlatform.Agent/appsettings.json").read_text())
    options = agent["Agent"]
    options["ServerBaseUrl"] = TRUSTED_ENDPOINT
    options["OfficeEnrollmentFile"] = "office-enrollment.json"
    options["Actions"]["ExecutionMode"] = "DiagnosticOnly"
    install = "C:/Program Files/Mashura/CabinetAgent/"
    for field, suffix in (("StateDirectory", "state"), ("LogDirectory", "logs")):
        options[field] = install + suffix
    options["Buffer"]["Directory"] = install + "buffer"
    options["Actions"]["DiagnosticBundleDirectory"] = install + "bundles"
    for sink in agent["Serilog"]["WriteTo"]:
        if sink["Name"] == "File":
            sink["Args"]["path"] = install + "logs/agent-.log"
    return agent


def _valid_config(component, raw):
    try:
        data = json.loads(raw)
        if component == "console":
            return data == {"Api": {"BaseAddress": TRUSTED_ENDPOINT, "TimeoutSeconds": 30}}
        expected = _settings("agent", REPOSITORY)
        return data == expected
    except (ValueError, KeyError, TypeError):
        return False


def verify_package(path, component):
    if component not in COMPONENTS:
        raise ValueError("Unknown component")
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if (len(names) != len(set(n.lower() for n in names)) or not names or
                any(not _safe_name(n) and n != "kit-manifest.json" for n in names) or
                any(entry.is_dir() or (entry.external_attr >> 16) & 0o170000 not in (0, 0o100000) for entry in entries) or
                any(entry.file_size > 100 * 1024 * 1024 for entry in entries)):
                raise ValueError("Unsafe archive member")
            manifest = json.loads(archive.read("kit-manifest.json"))
            hashes = manifest["sha256"]
            if (set(manifest) != {"schema", "component", "endpoint", "sourceCommit", "signed", "sha256"} or
                manifest["schema"] != 1 or manifest["component"] != component or manifest["endpoint"] != TRUSTED_ENDPOINT or
                manifest["signed"] is not False or not re.fullmatch(r"[a-f0-9]{40}", manifest["sourceCommit"]) or
                not isinstance(hashes, dict) or set(names) != set(hashes) | {"kit-manifest.json"} or
                not all(isinstance(v, str) and re.fullmatch(r"[A-F0-9]{64}", v) for v in hashes.values()) or
                f"CabinetPlatform.{COMPONENTS[component]}.exe" not in hashes or "appsettings.json" not in hashes):
                raise ValueError("Incomplete package manifest")
            for name, expected in hashes.items():
                if hashlib.sha256(archive.read(name)).hexdigest().upper() != expected:
                    raise ValueError("Package hash mismatch")
            if not _valid_config(component, archive.read("appsettings.json")):
                raise ValueError("Package configuration mismatch")
            return manifest
    except (KeyError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        raise ValueError("Invalid package") from error


def package_component(component, publish, destination, commit, source=REPOSITORY):
    if component not in COMPONENTS or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid component or source revision")
    if destination.exists() or destination.is_symlink():
        raise FileExistsError(destination)
    files = {}
    for path in publish.rglob("*"):
        if path.is_symlink() or (path.is_file() and any(parent.is_symlink() for parent in path.parents if parent != publish)):
            raise ValueError("Linked publish member")
        if path.is_file():
            name = path.relative_to(publish).as_posix()
            if not _safe_name(name) or name.lower().startswith("appsettings") or name.lower() == "kit-manifest.json":
                if name.lower().startswith("appsettings") or name.lower() == "kit-manifest.json":
                    continue
                raise ValueError("Unsafe publish member")
            files[name] = path.read_bytes()
    files["appsettings.json"] = (json.dumps(_settings(component, source), indent=2) + "\n").encode()
    if f"CabinetPlatform.{COMPONENTS[component]}.exe" not in files:
        raise ValueError("Windows executable missing")
    manifest = {"schema": 1, "component": component, "endpoint": TRUSTED_ENDPOINT,
                "sourceCommit": commit, "signed": False,
                "sha256": {name: hashlib.sha256(data).hexdigest().upper() for name, data in sorted(files.items())}}
    with destination.open("xb") as output:
        os.chmod(destination, 0o600)
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                archive.writestr(name, data)
            archive.writestr("kit-manifest.json", json.dumps(manifest, indent=2) + "\n")
    verify_package(destination, component)


def build(output, dotnet):
    output = output.absolute()
    if output.exists() or output.is_symlink() or REPOSITORY in output.parents:
        raise ValueError("Output must be new and outside the repository")
    if not output.parent.is_dir() or output.parent.is_symlink():
        raise ValueError("Output parent must be an existing direct directory")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPOSITORY, text=True).strip()
    # Archive HEAD instead of a worktree whose solution file can show a CRLF filter anomaly.
    archive = subprocess.check_output(["git", "archive", "--format=tar", commit], cwd=REPOSITORY)
    with tempfile.TemporaryDirectory() as scratch:
        source = Path(scratch) / "source"
        source.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            for member in tar.getmembers():
                if member.issym() or member.islnk() or member.name.startswith("/") or ".." in Path(member.name).parts:
                    raise ValueError("Unexpected source archive member")
            tar.extractall(source, filter="data")
        output.mkdir(mode=0o700)
        for component, project in COMPONENTS.items():
            publish = Path(scratch) / component
            command = [dotnet, "publish", str(source / "src" / f"CabinetPlatform.{project}" / f"CabinetPlatform.{project}.csproj"),
                       "-c", "Release", "-r", "win-x64", "--self-contained", "true", "-m:1",
                       "-p:PublishSingleFile=false", "-p:DebugType=None", "-p:DebugSymbols=false", "-o", str(publish)]
            subprocess.run(command, cwd=source, check=True)
            package_component(component, publish, output / f"cabinet-{component}.zip", commit, source)
    print(f"Built unsigned credential-free packages from {commit} at {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dotnet", default="dotnet")
    args = parser.parse_args()
    try:
        build(args.output, args.dotnet)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Build refused: {error}\n")
