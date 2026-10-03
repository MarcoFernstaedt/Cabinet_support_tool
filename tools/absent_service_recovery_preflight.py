#!/usr/bin/env python3
"""Offline, read-only triage of nonsecret *claims* for the exact #35 absence case.

Never reads a device journal or executes a service command. Always returns NO_GO;
operator claims are not independent provenance, native ACL or SCM evidence.
"""
import argparse
import json
import os
import re
import stat
from pathlib import Path


class InvalidEvidence(Exception):
    pass


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default error includes unrecognized argument values.
        raise InvalidEvidence()


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidEvidence()
        result[key] = value
    return result


def exact_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise InvalidEvidence()


def read_evidence(path):
    path = Path(path)
    if not path.is_absolute():
        raise InvalidEvidence()
    nofollow = getattr(os, 'O_NOFOLLOW', 0)
    if not nofollow and path.is_symlink():
        raise InvalidEvidence()
    flags = os.O_RDONLY | nofollow
    with os.fdopen(os.open(path, flags), 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 8192 or info.st_size == 0:
            raise InvalidEvidence()
        if os.name == 'posix' and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise InvalidEvidence()
        # The file is an operator-authored nonsecret inventory, not the backup itself.
        content = source.read(8193)
        if not content or len(content) > 8192:
            raise InvalidEvidence()
    return json.loads(content.decode('utf-8'), object_pairs_hook=unique_pairs)


def assess(value):
    exact_keys(value, ('intent', 'service', 'install', 'backups', 'evidence'))
    if value['intent'] != 'same_identity_recovery' or value['service'] != 'absent_1060' or value['install'] != 'absent':
        return ['SCENARIO_REFUSED']
    exact_keys(value['backups'], ('original_copy', 'original_installed', 'incident_copy'))
    for copy in value['backups'].values():
        exact_keys(copy, ('device_sha256', 'state_sha256'))
        if any(not isinstance(digest, str) or re.fullmatch('[a-fA-F0-9]{64}', digest) is None
               for digest in copy.values()):
            raise InvalidEvidence()
    checks = value['evidence']
    exact_keys(checks, ('independent_provenance', 'protected_backup_acl', 'original_scm_definition',
                        'original_identity_match', 'secure_rollback_boundary', 'journal_not_advanced',
                        'server_compatibility'))
    if any(type(flag) is not bool for flag in checks.values()):
        raise InvalidEvidence()
    gaps = []
    original = value['backups']
    if {key: digest.lower() for key, digest in original['original_copy'].items()} != \
            {key: digest.lower() for key, digest in original['original_installed'].items()}:
        gaps.append('ORIGINAL_COPIES_DISAGREE')
    for field, code in (('independent_provenance', 'PROVENANCE_UNVERIFIED'),
                        ('protected_backup_acl', 'ACL_UNVERIFIED'),
                        ('original_scm_definition', 'SCM_DEFINITION_MISSING'),
                        ('original_identity_match', 'IDENTITY_MATCH_UNVERIFIED'),
                        ('secure_rollback_boundary', 'ROLLBACK_BOUNDARY_UNVERIFIED'),
                        ('journal_not_advanced', 'JOURNAL_ADVANCEMENT_UNKNOWN'),
                        ('server_compatibility', 'SERVER_COMPATIBILITY_UNVERIFIED')):
        if not checks[field]:
            gaps.append(code)
    # An assertion of complete evidence is not independent verification or a write permit.
    gaps.append('INDEPENDENT_REVIEW_AND_NATIVE_REHEARSAL_REQUIRED')
    return gaps


def main():
    parser = SafeArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--evidence', required=True)
    try:
        args = parser.parse_args()
        gaps = assess(read_evidence(args.evidence))
    except (InvalidEvidence, OSError, UnicodeError, ValueError, TypeError, RecursionError):
        gaps = ['INVALID_EVIDENCE']
    print(json.dumps({'decision': 'NO_GO', 'scenario': 'ABSENT_SERVICE_ABSENT_INSTALL_ORIGINAL_BACKUP',
                      'gaps': gaps}, sort_keys=True))
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
