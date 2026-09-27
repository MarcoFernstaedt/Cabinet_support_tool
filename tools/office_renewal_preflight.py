#!/usr/bin/env python3
"""Read-only Office lab activation preflight. Requires a verified effective-config snapshot.

This does NOT produce the effective configuration or start the server. Run only
with the server stopped and all inputs held in a protected private directory.
"""
import argparse
import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path


class Refusal(Exception):
    pass


def unique(pairs):
    result = {}
    for key, value in pairs:
        if any(key.casefold() == prior.casefold() for prior in result):
            raise Refusal('Ambiguous JSON properties.')
        result[key] = value
    return result


def read(path):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise Refusal('Required input missing, linked or not a regular absolute file.')
    if os.name == 'posix' and (path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077):
        raise Refusal('Input must be owner private (0600).')
    if path.stat().st_size > 4 * 1024 * 1024:
        raise Refusal('Input exceeds the Office journal limit.')
    try:
        return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise Refusal('Invalid input JSON.') from exc


def hash_set(values):
    if not isinstance(values, list) or len(values) > 100 or any(
        not isinstance(value, str) or re.fullmatch(r'[a-fA-F0-9]{64}', value) is None for value in values
    ):
        raise Refusal('Invalid token inventory.')
    result = {value.upper() for value in values}
    if len(result) != len(values):
        raise Refusal('Duplicate token inventory entry.')
    return result


def utc(value):
    if not isinstance(value, str):
        raise Refusal('Invalid UTC instant.')
    try:
        instant = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if instant.utcoffset() != timedelta(0):
            raise ValueError()
        return instant
    except ValueError as exc:
        raise Refusal('Invalid UTC instant.') from exc


def options(document, journal):
    if not isinstance(document, dict) or not isinstance(document.get('OfficeEnrollment'), dict):
        raise Refusal('Office configuration absent.')
    value = document['OfficeEnrollment']
    if value.get('Enabled') is not True or value.get('StateFile') != str(journal):
        raise Refusal('Office mode or exact state path differs.')
    tokens = value.get('Tokens')
    if not isinstance(tokens, list) or len(tokens) > 100 or any(not isinstance(t, dict) for t in tokens):
        raise Refusal('Token list absent or invalid.')
    hashes = hash_set([t.get('TokenHash') for t in tokens])
    for token in tokens:
        issued, expires, device = (utc(token.get(k)) for k in ('IssuedUtc', 'ExpiresUtc', 'DeviceExpiresUtc'))
        if not issued < expires <= issued + timedelta(minutes=30) or not expires < device <= issued + timedelta(days=7):
            raise Refusal('Token time bounds invalid.')
    return hashes, {h: (utc(t['IssuedUtc']), utc(t['ExpiresUtc']), utc(t['DeviceExpiresUtc']))
                    for t in tokens for h in [t['TokenHash'].upper()]}


def check(manifest, effective, inventory, journal):
    """No writes or server construction. Raises Refusal on uncertain binding state."""
    journal = Path(journal)
    if not journal.is_absolute():
        raise Refusal('Exact absolute journal path required.')
    declared = read(manifest)
    actual = read(effective)
    intent = read(inventory)
    grants = read(journal)
    if not isinstance(intent, dict) or intent.get('StateFile') != str(journal):
        raise Refusal('Inventory state path differs.')
    configured, times = options(declared, journal)
    effective_hashes, effective_times = options(actual, journal)
    if configured != effective_hashes or times != effective_times:
        raise Refusal('Effective Office configuration differs from manifest.')
    intended = hash_set(intent.get('Tokens'))
    revoked = hash_set(intent.get('Revoked'))
    if not intended:
        raise Refusal('Empty inventory cannot establish intended bindings.')
    if intended != configured | revoked or configured & revoked:
        raise Refusal('Inventory is incomplete or revocation is still configured.')
    if not isinstance(grants, list) or len(grants) > 100 or any(not isinstance(g, dict) for g in grants):
        raise Refusal('Journal missing or invalid.')
    seen = set()
    machines = set()
    requests = set()
    for grant in grants:
        token = hash_set([grant.get('TokenHash')]).pop()
        if token not in intended or token in seen:
            raise Refusal('Unknown or duplicate consumed token binding.')
        seen.add(token)
        if not isinstance(grant.get('KeyHash'), str) or not re.fullmatch(r'[a-fA-F0-9]{64}', grant['KeyHash']):
            raise Refusal('Invalid key hash.')
        machine = grant.get('MachineId')
        if not isinstance(machine, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', machine) or machine in machines:
            raise Refusal('Invalid or duplicate machine identity.')
        machines.add(machine)
        if grant.get('Revoked', False) not in (False, True) or grant.get('KeyDestroyed', False) not in (False, True):
            raise Refusal('Invalid tombstone flags.')
        if grant.get('KeyDestroyed', False) and not grant.get('Revoked', False):
            raise Refusal('Inconsistent tombstone flags.')
        if token in configured and grant.get('Revoked', False) and not grant.get('KeyDestroyed', False):
            # An older tombstone needs key shredding, but not silently reactivation.
            raise Refusal('Old tombstone must be reviewed before migration.')
        renewals = grant.get('Renewals', [])
        if not isinstance(renewals, list) or len(renewals) > 30:
            raise Refusal('Invalid renewal history.')
        for renewal in renewals:
            if not isinstance(renewal, dict) or not renewal.get('ActorId') or not renewal.get('Reason'):
                raise Refusal('Invalid renewal attribution.')
            import uuid
            try:
                rid = uuid.UUID(renewal['RequestId'])
                if rid.int == 0 or rid in requests:
                    raise ValueError()
                requests.add(rid)
            except (KeyError, TypeError, ValueError) as exc:
                raise Refusal('Invalid renewal request identity.') from exc
            if utc(renewal.get('ExpiresUtc')) != utc(renewal.get('IssuedUtc')) + timedelta(days=1):
                raise Refusal('Invalid renewal duration.')
        if token not in configured and token not in revoked:
            raise Refusal('Removal without explicit revocation.')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('manifest', 'effective', 'inventory', 'journal'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    try:
        check(args.manifest, args.effective, args.inventory, args.journal)
    except (Refusal, OSError, TypeError, KeyError, OverflowError):
        parser.exit(1, 'REFUSED: Office preflight incomplete or inconsistent. Keep server stopped; review private inputs and intentional revocations.\n')
    print('PASS: read-only Office binding comparison. Verify stopped service and effective snapshot provenance before activation.')


if __name__ == '__main__':
    main()
