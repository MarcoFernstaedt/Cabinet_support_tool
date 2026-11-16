#!/usr/bin/env python3
"""Sign and package one Windows publish folder using the production pinned trust.

Requires Python 3, OpenSSL and osslsigncode 2.9. On a fresh Debian host, without
root: `apt-get download osslsigncode && dpkg-deb -x osslsigncode_*.deb ~/.local`.
Pass --osslsigncode ~/.local/usr/bin/osslsigncode or put it on PATH.
No timestamp authority is contacted. Private keys are supplied only by path.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

REPO = Path(__file__).resolve().parents[2]
TRUST = REPO / 'contracts/trust/upgrade'
# The operator's trust folders live outside the checkout. Override these on a host that keeps them elsewhere, or point
# --signing-dir and --release-key at a staged copy.
KEY_HOME = Path(os.environ.get('CABINET_SIGNING_DIR', Path.home() / 'cabinet-signing'))
RELEASE_KEY = Path(os.environ.get('CABINET_RELEASE_KEY', Path.home() / '.cabinet-release' / 'release-key.pem'))
BINARY_EXTENSIONS = {'.exe', '.dll', '.sys', '.ocx', '.cpl', '.scr', '.drv', '.efi', '.mui', '.winmd'}


def run(*args):
    # Do not echo signing command arguments or private material on failure.
    result = subprocess.run([str(a) for a in args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} {args[1]} failed (exit {result.returncode}): '
                           + result.stderr.decode(errors='replace'))
    return result.stdout


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def version_order(left, right):
    def parts(value):
        core, _, pre = value.partition('-')
        return tuple(map(int, core.split('.'))), pre
    lc, lp = parts(left)
    rc, rp = parts(right)
    if lc != rc:
        return (lc > rc) - (lc < rc)
    if lp == rp:
        return 0
    if not lp or not rp:
        return 1 if not lp else -1
    for l, r in zip(lp.split('.'), rp.split('.')):
        if l == r:
            continue
        ln, rn = l.isdigit(), r.isdigit()
        if ln and rn:
            if int(l) == int(r):
                continue
            return 1 if int(l) > int(r) else -1
        if ln != rn:
            return -1 if ln else 1
        return 1 if l > r else -1
    return (len(lp.split('.')) > len(rp.split('.'))) - (len(lp.split('.')) < len(rp.split('.')))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--publish-dir', type=Path, required=True)
    p.add_argument('--architecture', choices=['win-x64', 'win-x86'], required=True)
    p.add_argument('--version', required=True)
    p.add_argument('--minimum-version', required=True)
    p.add_argument('--out-dir', type=Path, required=True)
    p.add_argument('--notes')
    p.add_argument('--signing-dir', type=Path, default=KEY_HOME)
    p.add_argument('--release-key', type=Path, default=RELEASE_KEY)
    p.add_argument('--osslsigncode', default='osslsigncode')
    a = p.parse_args()
    pattern = r'(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(-[0-9A-Za-z.-]{1,32})?'
    for v in (a.version, a.minimum_version):
        if not re.fullmatch(pattern, v) or any(not part for part in v.split('-', 1)[-1].split('.')):
            p.error('Versions must be major.minor.patch with an optional nonempty prerelease.')
    if version_order(a.minimum_version, a.version) >= 0:
        p.error('The minimum version must be older than the release.')
    source = a.publish_dir.resolve(strict=True)
    output = a.out_dir.resolve()
    if output == source or source in output.parents:
        p.error('The output directory must be outside the publish directory.')
    pins = json.loads((TRUST / 'upgrade-keys.json').read_text())
    publisher, = pins['publishers']
    root = a.signing_dir / 'publisher-root.cert.pem'
    cert = a.signing_dir / 'publisher-issuing.cert.pem'
    key = a.signing_dir / 'publisher-issuing.key.pem'
    if hashlib.sha256(run('openssl', 'x509', '-in', root, '-outform', 'DER')).hexdigest() != publisher['root']:
        raise RuntimeError('The signing root is not the pinned publisher root.')
    subject = run('openssl', 'x509', '-in', cert, '-noout', '-subject', '-nameopt', 'RFC2253').decode().strip()
    if subject != f"subject=CN={publisher['commonName']},O={publisher['organization']}":
        raise RuntimeError('The signing certificate is not the pinned publisher.')
    run('openssl', 'verify', '-purpose', 'any', '-CAfile', root, cert)
    spki = run('openssl', 'pkey', '-in', a.release_key, '-pubout', '-outform', 'DER')
    key_id = hashlib.sha256(spki).hexdigest()
    if not any(k['keyId'] == key_id and base64.b64decode(k['publicKey']) == spki for k in pins['keys']):
        raise RuntimeError('The release key is not pinned in the agent.')
    files = sorted(source.rglob('*'))
    if any(f.is_symlink() for f in files):
        raise RuntimeError('Publish folders must not contain symlinks.')
    empty_dirs = [f for f in files if f.is_dir() and not any(f.iterdir())]
    files = [f for f in files if f.is_file()]
    for program in ('Broker', 'Network', 'Updater', 'Harness'):
        executable = 'cabinet-harness.exe' if program == 'Harness' else f'Cabinet.Agent.{program}.exe'
        required = source / f'Cabinet.Agent.{program}' / executable
        if required not in files:
            raise RuntimeError(f'The publish folder has no {required.relative_to(source)}.')
    binaries = []
    for f in files:
        with f.open('rb') as stream:
            mz = stream.read(2) == b'MZ'
        if f.suffix.lower() in BINARY_EXTENSIONS or mz:
            binaries.append(f)
        if f.suffix.lower() == '.exe':
            with f.open('rb') as stream:
                stream.seek(0x3c)
                offset = int.from_bytes(stream.read(4), 'little')
                stream.seek(offset)
                pe = stream.read(6)
            expected = 0x8664 if a.architecture == 'win-x64' else 0x14c
            if not mz or pe[:4] != b'PE\0\0' or int.from_bytes(pe[4:], 'little') != expected:
                raise RuntimeError(f'{f.name} is not a {a.architecture} program.')
    output.parent.mkdir(parents=True, exist_ok=True)
    # Stage signatures first so a signing or per-file verification failure leaves the publish folder intact.
    with tempfile.TemporaryDirectory(prefix='sign-', dir=output.parent) as temp:
        temp = Path(temp)
        chain = temp / 'chain.pem'
        chain.write_bytes(cert.read_bytes() + b'\n' + root.read_bytes())
        for i, f in enumerate(binaries):
            signed = temp / f'{i}.signed'
            run(a.osslsigncode, 'sign', '-certs', chain, '-key', key, '-h', 'sha256', '-in', f, '-out', signed)
            run(a.osslsigncode, 'verify', '-CAfile', root, '-in', signed)
        for i, f in enumerate(binaries):
            os.replace(temp / f'{i}.signed', f)
        output.mkdir(parents=True, exist_ok=True)
        archive = temp / f'agent-{a.version}.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
            for directory in empty_dirs:
                z.write(directory, directory.relative_to(source).as_posix() + '/')
            for f in files:
                z.write(f, f.relative_to(source).as_posix())
        data = archive.read_bytes()
        manifest = dict(product='mashura-cabinet-agent', version=a.version, minimumVersion=a.minimum_version,
                        sha256=hashlib.sha256(data).hexdigest(), sizeBytes=len(data),
                        releasedAt=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
        if a.notes:
            manifest['notes'] = a.notes
        manifest_bytes = compact(manifest)
        if len(manifest_bytes) > 4096:
            raise RuntimeError('Manifest exceeds the server 4 KB limit.')
        manifest_file = temp / 'manifest.json'
        manifest_file.write_bytes(manifest_bytes)
        signature = run('openssl', 'dgst', '-sha256', '-sign', a.release_key, manifest_file)
        (temp / 'signature.der').write_bytes(signature)
        (temp / 'public.der').write_bytes(spki)
        public = run('openssl', 'pkey', '-pubin', '-inform', 'DER', '-in', temp / 'public.der', '-pubout')
        (temp / 'public.pem').write_bytes(public)
        run('openssl', 'dgst', '-sha256', '-verify', temp / 'public.pem', '-signature', temp / 'signature.der', manifest_file)
        (temp / 'signature.json').write_bytes(compact(dict(keyId=key_id, algorithm='ecdsa-p256-sha256', signature=base64.b64encode(signature).decode())))
        for f in (archive, manifest_file, temp / 'signature.json'):
            os.replace(f, output / f.name)
    print(f'Release {a.version} ({a.architecture}): {len(binaries)} signed and verified binaries; {output}')


if __name__ == '__main__':
    main()
