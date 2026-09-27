#!/usr/bin/env python3
"""Local Supervisor renewal for an existing Office lab credential. Python stdlib only."""
import argparse
from builtins import input
import getpass as password_prompt
import json
import os
import ssl
import stat
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener


class Ambiguous(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
            parsed.path or parsed.query or parsed.fragment or parsed.netloc.endswith(':') or
            '\\' in value or value != f'https://{parsed.netloc}' or
            any(c.isspace() for c in value)):
        raise ValueError('Expected an exact HTTPS origin with no path, user info or redirects.')
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError('Invalid HTTPS port.') from exc
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('Invalid HTTPS port.')
    return value


def getpass(prompt):
    return password_prompt.getpass(prompt)


def urlopen(request, timeout):
    return build_opener(HTTPSHandler(context=ssl.create_default_context()), NoRedirect()).open(request, timeout=timeout)


def api(base, path, token=None, payload=None):
    address = base + path
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = None
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    request = Request(address, data=data, headers=headers, method='POST' if data is not None else 'GET')
    try:
        with urlopen(request, timeout=15) as response:
            if response.geturl() != address or response.status != 200:
                raise Ambiguous('Unexpected response origin or status; do not issue a new decision.')
            raw = response.read(1048577)
            if len(raw) > 1048576:
                raise Ambiguous('Oversized response; keep the existing request ID.')
            return json.loads(raw)
    except HTTPError as exc:
        if exc.code in (301, 302, 303, 307, 308):
            raise ValueError('Redirect refused; check the exact HTTPS origin.') from None
        if exc.code == 401:
            raise ValueError('401: sign in again with the same Supervisor user; keep the request ID.') from None
        if exc.code == 403:
            raise ValueError('403: Supervisor authority or password change required; do not renew.') from None
        if exc.code == 409:
            raise ValueError('409: identity retired, revoked, missing, decision cap reached or request collision. Do not reset history or create a new ID to bypass refusal.') from None
        if exc.code >= 500:
            raise Ambiguous('Server error: result unknown. Retry the identical saved decision with the same user.') from None
        raise ValueError(f'HTTP {exc.code}: refused; retain the saved decision.') from None
    except (URLError, TimeoutError, OSError) as exc:
        raise Ambiguous('Transport failed: result unknown. Retry the identical saved decision.') from None


def secure_parent(path):
    path = Path(path).absolute()
    if not path.parent.is_dir() or path.parent.is_symlink() or (path.parent.stat().st_mode & 0o077):
        raise ValueError('Decision directory must exist, be private (0700) and not be a symlink.')
    return path


def decision_file(path, new=None):
    path = secure_parent(path)
    if new is not None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(new, stream)
                stream.flush()
                os.fsync(stream.fileno())
            directory = os.open(path.parent, os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)
        except BaseException:
            # An uncertain write must not lead to a new UUID without inspection.
            raise
        return new
    if path.is_symlink() or not path.is_file() or (path.stat().st_mode & 0o077):
        raise ValueError('Existing decision must be a private regular file (0600), not a link.')
    return json.loads(path.read_text())


def identity(detail, cabinet_id, machine_id):
    cabinet = detail['cabinet']
    if (cabinet['id'] != cabinet_id or cabinet['machineId'] != machine_id or
            cabinet['isActive'] is not True):
        raise ValueError('Cabinet identity or active state changed; stop.')
    return cabinet


def parse_utc(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.utcoffset() != timezone.utc.utcoffset(None):
        raise ValueError('Expected a UTC timestamp.')
    return parsed


def run(base, username, cabinet_id, machine_id, path, reason):
    base = origin(base)
    cabinet_id = str(uuid.UUID(cabinet_id))
    if not machine_id or len(machine_id) > 128:
        raise ValueError('Exact machine ID required.')
    path = secure_parent(path)
    existing = path.exists() or path.is_symlink()
    if existing and reason is not None:
        raise ValueError('Existing decision: omit --reason and reconcile it first.')
    if not existing and (reason is None or not reason.strip() or len(reason.strip()) > 500):
        raise ValueError('New decision requires a specific reason of at most 500 characters.')
    # No refresh token is persisted. A fresh login from the same user can retry.
    password = getpass('Supervisor password: ')
    try:
        login = api(base, '/api/auth/login', payload={'username': username, 'password': password})
    finally:
        password = None
    if login.get('mustChangePassword') or login.get('role') not in ('Supervisor', 3):
        raise ValueError('Password change required or account not Supervisor; stop.')
    token = login['accessToken']
    me = api(base, '/api/auth/me', token)
    if me.get('mustChangePassword') or me.get('isActive') is not True or me.get('role') not in ('Supervisor', 3):
        raise ValueError('Current Supervisor authority unavailable; stop.')
    actor = str(uuid.UUID(me['id']))
    if actor != str(uuid.UUID(login['userId'])):
        raise ValueError('Login identity mismatch; stop.')
    if existing:
        decision = decision_file(path)
        if any(decision.get(k) != v for k, v in [('origin', base), ('actorId', actor),
                 ('cabinetId', cabinet_id), ('machineId', machine_id)]) or not decision.get('reason'):
            raise ValueError('Saved decision identity differs; do not post.')
        uuid.UUID(decision['requestId'])
    else:
        decision = {'origin': base, 'actorId': actor, 'cabinetId': cabinet_id,
                    'machineId': machine_id, 'requestId': str(uuid.uuid4()), 'reason': reason.strip()}
    detail_path = '/api/cabinets/' + cabinet_id
    history_path = detail_path + '/heartbeats?page=1&pageSize=1'
    before = identity(api(base, detail_path, token), cabinet_id, machine_id)
    history = api(base, history_path, token)
    if history.get('totalCount', 0) < 1 or not history.get('items'):
        raise ValueError('Nonempty cabinet history not established; stop.')
    if not existing:
        decision['priorContactUtc'] = before.get('lastCheckInUtc')
        decision['priorHistoryCount'] = history['totalCount']
        decision['priorHistoryId'] = history['items'][0].get('id')
        print(f"Cabinet {cabinet_id}, machine {machine_id}, actor {actor}; last contact {before.get('lastCheckInUtc')}; history rows {history['totalCount']}.")
        if input('Type the exact machine ID: ') != machine_id or input('Type YES only after checking approval, the original local protected device journal, and no suspected compromise: ') != 'YES':
            raise ValueError('Confirmation refused; no decision posted.')
        decision_file(path, decision)
    result = api(base, '/api/office/enroll/renew/' + cabinet_id, token,
                 {'requestId': decision['requestId'], 'reason': decision['reason']})
    if any(result.get(k) != decision[k] for k in ('cabinetId', 'machineId', 'requestId')):
        raise Ambiguous('Response identity mismatch; retain the saved decision.')
    expiry = parse_utc(result['expiresUtc'])
    if expiry <= datetime.now(timezone.utc):
        raise Ambiguous('Expiry is not in the future; check the trusted server clock and keep the decision.')
    after = identity(api(base, detail_path, token), cabinet_id, machine_id)
    after_history = api(base, history_path, token)
    if (after_history.get('totalCount', 0) < decision['priorHistoryCount'] or not after_history.get('items')):
        raise Ambiguous('History continuity unverified; retain the decision.')
    prior_page = after_history['totalCount'] - decision['priorHistoryCount'] + 1
    historical = api(base, detail_path + f'/heartbeats?page={prior_page}&pageSize=1', token)
    if not historical.get('items') or historical['items'][0].get('id') != decision['priorHistoryId']:
        raise Ambiguous('Previous heartbeat identity not found under this cabinet; retain the decision.')
    old_contact = decision['priorContactUtc']
    new_contact = after.get('lastCheckInUtc')
    if not new_contact or (old_contact and parse_utc(new_contact) <= parse_utc(old_contact)):
        raise Ambiguous('Renewal recorded, but a new device contact is not yet verified. Retain the saved decision and retry readback later.')
    if after_history['items'][0].get('cabinetId') not in (None, cabinet_id):
        raise Ambiguous('History cabinet identity mismatch; retain the saved decision.')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True, help='Exact HTTPS origin')
    parser.add_argument('--username', required=True)
    parser.add_argument('--cabinet-id', required=True)
    parser.add_argument('--machine-id', required=True)
    parser.add_argument('--state', type=Path, required=True, help='Private decision file in a 0700 directory')
    parser.add_argument('--reason', help='New decision only; omit to retry the saved decision')
    args = parser.parse_args()
    try:
        result = run(args.origin, args.username, args.cabinet_id, args.machine_id, args.state, args.reason)
        print(f"Verified cabinet {result['cabinetId']} machine {result['machineId']} request {result['requestId']} expiry {result['expiresUtc']} and newer contact with history. Keep decision file for audit.")
    except (ValueError, Ambiguous, KeyError, TypeError, json.JSONDecodeError) as exc:
        print(f'Refused: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__': sys.exit(main())
