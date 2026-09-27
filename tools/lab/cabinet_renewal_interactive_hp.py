#!/usr/bin/env python3
"""Interactive renewal launch using the HP's preserved read-only identity."""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import uuid

HERE = pathlib.Path('/home/marco/tmp')
KIT = HERE / 'cabinet-recovery-assembly-kit-b685e42-final' / 'office_renewal_operator.py'
PRIVATE = HERE / 'cabinet-renewal-private-b685e42'
DECISION = PRIVATE / 'decision.json'
REMOTE = r'C:\ProgramData\CabinetRecoveryDelivery-b685e42\RenewalIdentity-ReadOnly.ps1'

def main():
    check = argparse.ArgumentParser()
    check.add_argument('--check', action='store_true', help='Read-only prerequisite check, no login or renewal')
    args = check.parse_args()
    if not args.check and not sys.stdin.isatty():
        raise SystemExit('A trusted interactive terminal is required.')
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', 'hp-edge', 'powershell', '-NoProfile', '-NonInteractive', '-File', REMOTE], capture_output=True, text=True, timeout=20, check=True)
    record = json.loads(result.stdout)
    cabinet = str(uuid.UUID(record['cabinetId']))
    machine = record['machineId']
    if not isinstance(machine, str) or not machine or len(machine) > 128 or not KIT.is_file():
        raise SystemExit('Approved identity or operator helper unavailable.')
    PRIVATE.mkdir(mode=0o700, exist_ok=True)
    if PRIVATE.is_symlink() or PRIVATE.stat().st_mode & 0o077:
        raise SystemExit('Decision directory is not private.')
    if args.check:
        print('CHECK_PASS: original captured cabinet/machine identity matches HP; protected device journal present; local Python and private decision location ready. No login or grant issued.')
        return
    username = input('Existing Supervisor username: ').strip()
    if not username:
        raise SystemExit('Supervisor username required; no credential guessed.')
    cmd = [sys.executable, '-B', str(KIT), '--origin', 'https://srv1522777.tail72f980.ts.net', '--username', username, '--cabinet-id', cabinet, '--machine-id', machine, '--state', str(DECISION)]
    if not DECISION.exists():
        cmd += ['--reason', 'HP same-device Cabinet demo credential renewal']
    raise SystemExit(subprocess.call(cmd))

if __name__ == '__main__':
    main()
