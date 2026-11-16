// Development branch only. Every cabinet action is driven by a checked-in script.
// --probe is read-only; the recorded acceptance requires database credentials.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 1800000 });
  if (result.error || result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.error?.message ?? ''}\nCommand: ${[command, ...args].map(arg => JSON.stringify(arg)).join(' ')}`);
}
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
if (branch.status !== 0 || branch.stdout.trim() !== 'feat/remote-access-tunnel') throw new Error('Requires feat/remote-access-tunnel');
if (process.argv.includes('--probe')) {
  const source = readFileSync(new URL('./session-shell-probe.ps1', import.meta.url), 'utf8');
  run('ssh', ['-F', process.env.HOME + '/.ssh/config', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', process.env.SHELL_CABINET_SSH ?? 'deviceb', 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]);
} else {
  if (!process.env.TEST_DATABASE_ADMIN_URL) throw new Error('Export TEST_DATABASE_ADMIN_URL before running recorded cabinet acceptance');
  process.env.PATH = process.env.HOME + '/.dotnet:' + process.env.PATH;
  run('npm', ['--prefix', 'server', 'run', 'build']);
  run('node', ['scripts/acceptance/session-shell-cabinet.mjs']);
}
