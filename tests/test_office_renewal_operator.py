"""Synthetic transport checks for the local renewal client; no live credentials."""
import io
import json
import os
import pty
import subprocess
import tempfile
import unittest

from unittest.mock import patch
from urllib.error import HTTPError
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import office_renewal_operator as op


class Response:
    def __init__(self, obj, url):
        self.body = json.dumps(obj).encode()
        self.url = url
        self.status = 200
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, n=-1): return self.body[:n]
    def geturl(self): return self.url


class SyntheticTransport:
    def __init__(self):
        self.calls = []
        self.fail_post = False
        self.contact = '2026-01-01T00:00:00Z'
    def __call__(self, request, timeout):
        url = request.full_url
        body = json.loads(request.data) if request.data else None
        self.calls.append((url, body, dict(request.headers)))
        if url.endswith('/api/auth/login'):
            return Response({'accessToken': 'secret', 'userId': '11111111-1111-1111-1111-111111111111',
                             'role': 'Supervisor', 'mustChangePassword': False}, url)
        if url.endswith('/api/auth/me'):
            return Response({'id': '11111111-1111-1111-1111-111111111111', 'role': 'Supervisor',
                             'mustChangePassword': False, 'isActive': True}, url)
        if '/api/office/enroll/renew/' in url:
            if self.fail_post: raise HTTPError(url, 500, 'ambiguous', {}, io.BytesIO(b'never display'))
            return Response({'cabinetId': '22222222-2222-2222-2222-222222222222',
                             'machineId': 'device', 'requestId': body['requestId'],
                             'expiresUtc': '2099-01-02T00:00:00Z'}, url)
        if url.endswith('/heartbeats?page=1&pageSize=1'):
            return Response({'items': [{'id': 'old-history', 'cabinetId': '22222222-2222-2222-2222-222222222222'}], 'totalCount': 1}, url)
        if '/api/cabinets/' in url:
            return Response({'cabinet': {'id': '22222222-2222-2222-2222-222222222222',
                                         'machineId': 'device', 'isActive': True, 'lastCheckInUtc': self.contact},
                             'latestHeartbeat': {'id': 'old-history'}}, url)
        raise AssertionError(url)


class OperatorTests(unittest.TestCase):
    def test_unmasked_terminal_fallback_refuses_without_login(self):
        fake = SyntheticTransport()
        with tempfile.TemporaryDirectory() as root, \
                patch.object(op.password_prompt, 'getpass', side_effect=op.password_prompt.GetPassWarning('no terminal')), \
                patch.object(op, 'urlopen', fake):
            with self.assertRaisesRegex(ValueError, 'masked terminal') as error:
                op.run('https://example.test', 'supervisor', '22222222-2222-2222-2222-222222222222',
                       'device', Path(root) / 'decision.json', 'lab repeat')
            self.assertNotIn('no terminal', str(error.exception))
            self.assertEqual(fake.calls, [])

    def test_real_getpass_refuses_before_nonterminal_stdin_fallback(self):
        fake = SyntheticTransport()
        with tempfile.TemporaryDirectory() as root, \
                patch.object(op.password_prompt.os, 'open', side_effect=OSError('no tty')), \
                patch.object(op.password_prompt, 'input', create=True, side_effect=AssertionError('unmasked read')), \
                patch.object(op.password_prompt.sys, 'stdin', io.StringIO('synthetic-not-a-secret\n')), \
                patch.object(op.password_prompt.sys, 'stderr', io.StringIO()), \
                patch.object(op, 'urlopen', fake):
            with self.assertRaisesRegex(ValueError, 'masked terminal'):
                op.run('https://example.test', 'supervisor', '22222222-2222-2222-2222-222222222222',
                       'device', Path(root) / 'decision.json', 'lab repeat')
            self.assertEqual(fake.calls, [])

    @unittest.skipUnless(os.name == 'posix', 'PTY requires POSIX')
    def test_real_pty_masks_synthetic_input(self):
        import fcntl
        import select
        import termios
        master, slave = pty.openpty()
        proc = None
        try:
            proc = subprocess.Popen([sys.executable, '-c',
                'import sys; sys.path.insert(0, sys.argv[1]); import office_renewal_operator as op; '
                'op.getpass("Password: "); print("ACCEPTED")', str(Path(op.__file__).parent)],
                stdin=slave, stdout=slave, stderr=slave, close_fds=True,
                preexec_fn=lambda: (os.setsid(), fcntl.ioctl(slave, termios.TIOCSCTTY, 0)))
            os.close(slave)
            slave = -1
            output = bytearray()
            for _ in range(100):
                ready, _, _ = select.select([master], [], [], .05)
                if ready:
                    output.extend(os.read(master, 4096))
                    if b'Password: ' in output: break
            else:
                self.fail('PTY prompt missing')
            os.write(master, b'synthetic-not-a-secret\n')
            for _ in range(100):
                ready, _, _ = select.select([master], [], [], .05)
                if ready:
                    try: output.extend(os.read(master, 4096))
                    except OSError: break
                if proc.poll() is not None: break
            self.assertEqual(proc.wait(timeout=5), 0)
            self.assertIn(b'ACCEPTED', output)
            self.assertNotIn(b'synthetic-not-a-secret', output)
        finally:
            if slave != -1: os.close(slave)
            os.close(master)
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_rejects_nonexact_https_origin(self):
        for value in ('http://host', 'https://host/path', 'https://user@host', 'https://host/?x=1',
                      'https://host/#frag', 'https://host:0', 'https://host\\evil'):
            with self.subTest(value=value), self.assertRaises(ValueError): op.origin(value)
        self.assertEqual(op.origin('https://example.test:8443'), 'https://example.test:8443')

    def test_500_keeps_identical_request_for_fresh_session(self):
        fake = SyntheticTransport()
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'decision.json'
            with patch.object(op, 'getpass', return_value='private'), patch.object(op, 'input', side_effect=['device', 'YES']), patch.object(op, 'urlopen', fake):
                fake.fail_post = True
                with self.assertRaises(op.Ambiguous):
                    op.run('https://example.test', 'supervisor', '22222222-2222-2222-2222-222222222222', 'device', path, 'lab repeat')
                decision = json.loads(path.read_text())
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
                self.assertNotIn('private', path.read_text())
                self.assertNotIn('secret', path.read_text())
                self.assertEqual(len([c for c in fake.calls if '/renew/' in c[0]]), 1)
                fake.fail_post = False
                fake.contact = '2026-01-01T01:00:00Z'
                result = op.run('https://example.test', 'supervisor', '22222222-2222-2222-2222-222222222222', 'device', path, None)
                posts = [c[1] for c in fake.calls if '/renew/' in c[0]]
                self.assertEqual(posts, [posts[0], posts[0]])
                self.assertEqual(posts[0]['requestId'], decision['requestId'])
                self.assertEqual(result['expiresUtc'], '2099-01-02T00:00:00Z')

    def test_status_refusals_do_not_create_fresh_decision(self):
        fake = SyntheticTransport()
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'decision.json'
            for status, exception in ((401, ValueError), (403, ValueError), (409, ValueError), (500, op.Ambiguous)):
                with self.subTest(status=status), patch.object(op, 'getpass', return_value='private'), patch.object(op, 'input', side_effect=['device', 'YES']):
                    def respond(request, timeout):
                        if '/renew/' in request.full_url:
                            raise HTTPError(request.full_url, status, 'synthetic', {}, io.BytesIO(b'private body'))
                        return fake(request, timeout)
                    with patch.object(op, 'urlopen', respond):
                        with self.assertRaises(exception):
                            op.run('https://example.test', 'supervisor', '22222222-2222-2222-2222-222222222222', 'device', path, 'lab repeat' if not path.exists() else None)
                    self.assertTrue(path.exists())
                    self.assertNotIn('private body', path.read_text())

    def test_no_contact_keeps_decision_and_exact_retry_verifies_later_contact(self):
        fake = SyntheticTransport()
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'decision.json'
            with patch.object(op, 'getpass', return_value='private'), patch.object(op, 'input', side_effect=['device', 'YES']), patch.object(op, 'urlopen', fake):
                with self.assertRaisesRegex(op.Ambiguous, 'new device contact'):
                    op.run('https://example.test', 'supervisor', '22222222-2222-2222-2222-222222222222', 'device', path, 'lab repeat')
                original = json.loads(path.read_text())
                fake.contact = '2026-01-01T01:00:00Z'
                op.run('https://example.test', 'supervisor', '22222222-2222-2222-2222-222222222222', 'device', path, None)
                self.assertEqual(json.loads(path.read_text()), original)
                self.assertEqual(len([c for c in fake.calls if '/renew/' in c[0]]), 2)

    def test_password_change_blocks_before_post(self):
        fake = SyntheticTransport()
        with tempfile.TemporaryDirectory() as root:
            def respond(request, timeout):
                response = fake(request, timeout)
                if request.full_url.endswith('/api/auth/login'):
                    response = Response({'accessToken': 'secret', 'userId': '11111111-1111-1111-1111-111111111111',
                                         'role': 'Supervisor', 'mustChangePassword': True}, request.full_url)
                return response
            with patch.object(op, 'getpass', return_value='private'), patch.object(op, 'urlopen', respond):
                with self.assertRaisesRegex(ValueError, 'Password change required'):
                    op.run('https://example.test', 'supervisor', '22222222-2222-2222-2222-222222222222',
                           'device', Path(root) / 'decision.json', 'lab repeat')
            self.assertFalse(any('/renew/' in c[0] for c in fake.calls))

    def test_redirect_is_not_followed(self):
        self.assertIsNone(op.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.test'))

    def test_actor_mismatch_blocks_post(self):
        fake = SyntheticTransport()
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'decision.json'
            path.write_text(json.dumps({'origin': 'https://example.test', 'actorId': 'other',
                                        'cabinetId': '22222222-2222-2222-2222-222222222222',
                                        'machineId': 'device', 'requestId': '33333333-3333-3333-3333-333333333333', 'reason': 'lab'}))
            with patch.object(op, 'getpass', return_value='private'), patch.object(op, 'urlopen', fake):
                with self.assertRaises(ValueError):
                    op.run('https://example.test', 'supervisor', '22222222-2222-2222-2222-222222222222', 'device', path, None)
            self.assertFalse(any('/renew/' in c[0] for c in fake.calls))


if __name__ == '__main__': unittest.main()
