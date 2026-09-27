"""Append one short-lived office grant without resetting enrollment history.

Run on the test server as its owner. Transfer the output privately to exactly
one device, then restart only the reviewed test service to load the new hash.
This tool never restarts a service or prints a credential.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ENDPOINT = "https://srv1522777.tail72f980.ts.net/"


def write_private(path, value):
    with path.open("x", encoding="utf-8") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def require_private(path, directory=False):
    if not path.is_absolute() or path.resolve() != path or path.is_symlink():
        raise ValueError("Linked or relative paths are not supported")
    metadata = path.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError("Paths must be owned and private to the operator")
    if (directory and not path.is_dir()) or (not directory and not path.is_file()):
        raise ValueError("Unexpected path type")


def validate_inventory(tokens, grants):
    for rows in (tokens, grants):
        if not isinstance(rows, list) or len(rows) >= 100:
            raise ValueError("Inventory is invalid or full")
        hashes = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("TokenHash"), str) or not re.fullmatch(r"[A-Fa-f0-9]{64}", row["TokenHash"]):
                raise ValueError("Invalid token hash")
            hashes.append(row["TokenHash"].upper())
        if len(set(hashes)) != len(hashes):
            raise ValueError("Duplicate token hash")
    for token in tokens:
        issued, expires, device = [datetime.fromisoformat(token[key]) for key in ("IssuedUtc", "ExpiresUtc", "DeviceExpiresUtc")]
        if any(value.tzinfo is None for value in (issued, expires, device)) or not issued < expires <= issued + timedelta(minutes=30) or not expires < device <= issued + timedelta(days=7):
            raise ValueError("Invalid token lifetime")
    machines = []
    for grant in grants:
        if not isinstance(grant.get("KeyHash"), str) or not re.fullmatch(r"[A-Fa-f0-9]{64}", grant["KeyHash"]) or not isinstance(grant.get("MachineId"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", grant["MachineId"]):
            raise ValueError("Invalid consumed grant")
        machines.append(grant["MachineId"])
    if len(set(machines)) != len(machines):
        raise ValueError("Duplicate machine identity")


def unique_properties(pairs):
    result = {}
    seen = set()
    for key, value in pairs:
        if key.casefold() in seen:
            raise ValueError("Ambiguous JSON properties")
        result[key] = value
        seen.add(key.casefold())
    return result


def issue(manifest, output):
    manifest = manifest.absolute()
    output = output.absolute()
    require_private(manifest)
    require_private(manifest.parent, directory=True)
    require_private(output.parent, directory=True)
    repository = Path(__file__).resolve().parents[1]
    for path in (manifest, output):
        if repository in path.parents or any((parent / ".git").exists() for parent in path.parents):
            raise ValueError("Keep enrollment material outside source control")
    if output.exists() or output.is_symlink():
        raise ValueError("Never overwrite a device file")
    old_umask = os.umask(0o077)
    try:
        with (manifest.parent / ".office-provision.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            document = json.loads(manifest.read_text(), object_pairs_hook=unique_properties)
            options = document["OfficeEnrollment"]
            if options.get("Enabled") is not True:
                raise ValueError("Office mode must already be enabled")
            # The consumed journal belongs exclusively to the server. Never write it.
            state = Path(options["StateFile"])
            require_private(state)
            require_private(state.parent, directory=True)
            validate_inventory(options["Tokens"], json.loads(state.read_text(), object_pairs_hook=unique_properties))
            now = datetime.now(timezone.utc)
            token = secrets.token_hex(32).upper()
            write_private(output, {"ServerBaseUrl": ENDPOINT, "Token": token})
            suffix = uuid.uuid4().hex
            write_private(manifest.with_name(manifest.name + "." + suffix + ".bak"), document)
            options["Tokens"].append({"TokenHash": hashlib.sha256(token.encode()).hexdigest().upper(),
                                      "IssuedUtc": now.isoformat(),
                                      "ExpiresUtc": (now + timedelta(minutes=20)).isoformat(),
                                      "DeviceExpiresUtc": (now + timedelta(days=1)).isoformat()})
            temporary = manifest.with_name(manifest.name + "." + suffix + ".tmp")
            write_private(temporary, document)
            os.replace(temporary, manifest)
            directory = os.open(manifest.parent, os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        print("Private device file created. Restart the reviewed test service before use. Unused token expires in 20 minutes; device credential expires in 24 hours.")
    finally:
        os.umask(old_umask)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        issue(args.manifest, args.output)
    except (OSError, ValueError, KeyError, TypeError):
        parser.exit(1, "Issuance refused. Check private paths, manifest and journal; do not reset history.\n")


if __name__ == "__main__":
    main()
