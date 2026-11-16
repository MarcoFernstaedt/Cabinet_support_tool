// Real cabinet acceptance. Requires exported TEST_DATABASE_ADMIN_URL and SSH to deviceb.
// Uses an isolated database, a new CNG identity, and a temporary Windows host running the production agent connection.
// Existing cabinet services, configuration and enrollment are not changed. No public endpoint is simulated.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, networkInterfaces, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestDatabase } from '../../server/dist/test/database.js';
import { developmentPlatformPki } from '../../server/dist/src/pki/issuing.js';
import { buildAgentApi } from '../../server/dist/src/agent-api/server.js';
import { CommandNotifier } from '../../server/dist/src/agent-api/notifier.js';
import { NotificationFeed } from '../../server/dist/src/db/notifications.js';
import { SessionRelay } from '../../server/dist/src/agent-api/session-relay.js';
import { SessionLifecycle } from '../../server/dist/src/services/session-lifecycle.js';
import { SessionShell } from '../../server/dist/src/services/session-shell.js';
import { createBootstrapToken, approveEnrollment } from '../../server/dist/src/services/enrollment.js';
import { grantPermission } from '../../server/dist/src/services/user-permissions.js';
import { issueStepUpToken } from '../../server/dist/src/auth/stepup.js';
import { openSession } from '../../server/dist/src/services/session-opening.js';
import { opsMeter, splitKey } from '../../server/dist/src/services/ops-meter.js';
import { createPool, verifyAuditChain } from '../../server/dist/src/db/db.js';
const sshConfig = ['-F', join(homedir(), '.ssh/config'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const cabinetHost = process.env.SHELL_CABINET_SSH ?? 'deviceb';
const platformHost = process.env.SHELL_PLATFORM_HOST ?? Object.entries(networkInterfaces()).filter(([name]) => name.startsWith('tailscale')).flatMap(([, addresses]) => addresses ?? []).find(a => a.family === 'IPv4')?.address;
assert.ok(platformHost, 'No tailnet interface found; export SHELL_PLATFORM_HOST as this host’s cabinet-reachable tailnet address');
const work = mkdtempSync(join(tmpdir(), 'shell-cabinet-'));
const runId = 'shell-' + randomUUID();
let observer, db, api, notifier, feed, remote, agentProcess;
async function run(binary, args, options = {}) {
  // SSH must yield: this process also serves TLS, database callbacks and lag sampling.
  try {
    const result = await execFileAsync(binary, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024, ...options });
    return (result.stdout ?? '').trim();
  } catch (error) {
    throw new Error(`${binary} failed (${error.code}): ${error.message} ${error.stderr ?? ''}\nCommand: ${[binary, ...args].map(arg => JSON.stringify(arg)).join(' ')}`);
  }
}
const quote = text => "'" + text.replaceAll("'", "''") + "'";
async function ps(source) { return await run('ssh', [...sshConfig, cabinetHost, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + source, 'utf16le').toString('base64')]); }
const shedReasons = new Map();
let admissionDiagnostics = () => null;
function serverDiagnostics() {
  // No reporter drains this in-process acceptance server's meter. Restore after
  // reading so repeated failure diagnostics remain cumulative.
  const snapshot = opsMeter.drain();
  opsMeter.restore(snapshot);
  console.error('--- server diagnostics ---', JSON.stringify({
    counts: [...snapshot.counts].map(([key, count]) => { const [kind, code] = splitKey(key); return { kind, code, count }; })
      .filter(({ kind }) => ['shed', 'http_5xx', 'error_class'].includes(kind)),
    shedReasons: Object.fromEntries(shedReasons),
    admission: admissionDiagnostics(),
    observerPool: observer ? { waitMs: observer.waitMs, pending: observer.pending } : null,
    pool: db ? { waitMs: db.app.waitMs, pending: db.app.pending } : null,
  }));
}
async function agentDiagnostics() {
  serverDiagnostics();
  if (!remote) return;
  try {
    console.error(await ps(['agent.log', 'run.out', 'run.err'].map(name =>
      `$f=Join-Path ${quote(remote)} ${quote(name)}; Write-Output ${quote('--- ' + name + ' ---')}; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f } else { Write-Output '(missing)' }`).join(';')));
  } catch (error) { console.error('Could not read acceptance agent output:', error.message); }
}
async function agentState() {
  return JSON.parse(await ps(`$p=Get-Process -Id ${agentProcess} -ErrorAction SilentlyContinue; $record=$null; $f=Join-Path ${quote(remote)} 'process-state.json'; if (-not $p) { for ($i=0; $i -lt 20 -and -not (Test-Path -LiteralPath $f); $i++) { Start-Sleep -Milliseconds 50 } }; if (Test-Path -LiteralPath $f) { $record=Get-Content -Raw -LiteralPath $f | ConvertFrom-Json }; @{ pid=${agentProcess}; state=$(if ($p) { 'running' } else { 'exited' }); exitCode=$(if ($record) { $record.exitCode } else { $null }); recordedState=$record } | ConvertTo-Json -Compress -Depth 4`));
}
async function requireAgent(label) {
  const state = await agentState();
  if (state.state === 'running') return;
  await agentDiagnostics();
  throw new Error(`Acceptance agent process ${agentProcess} exited during: ${label}; exit code: ${state.exitCode ?? 'unavailable'}; process state: ${JSON.stringify(state)}`);
}
async function startAgent(server) {
  // Stage both code and data; neither PowerShell nor SSH carries the payload.
  const launcher = remote + '\\shell-agent-launch.ps1';
  const config = join(work, 'shell-agent-launch.json');
  writeFileSync(config, JSON.stringify({ exe: remote + '\\bin\\Cabinet.Agent.ShellCabinet.exe', args: `"${server}" "${remote}"` }));
  await upload(new URL('./shell-agent-launch.ps1', import.meta.url).pathname, launcher);
  await upload(config, remote + '\\shell-agent-launch.json');
  await run('ssh', [...sshConfig, cabinetHost, 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${launcher}"`]);
  // This delay and probe occur after the creating SSH session has ended.
  await new Promise(r => setTimeout(r, 1000));
  const pid = await ps(`$f=Join-Path ${quote(remote)} 'agent.pid'; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f }`);
  agentProcess = Number(pid);
  if (!Number.isSafeInteger(agentProcess) || agentProcess <= 0) {
    agentProcess = undefined;
    await agentDiagnostics();
    const state = await ps(`$f=Join-Path ${quote(remote)} 'process-state.json'; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f } else { 'supervisor has not reported an agent PID; exit code unavailable' }`);
    throw new Error(`Acceptance agent launch failed; process state: ${state}`);
  }
  await requireAgent('detached startup (one second after launch)');
}
async function until(read, label, { expectExit = false } = {}) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    if (agentProcess && !expectExit) await requireAgent(label);
    let value;
    try { value = await read(); }
    catch (error) { await agentDiagnostics(); throw error; }
    if (value) return value;
    await new Promise(r => setTimeout(r, 250));
  }
  await agentDiagnostics();
  throw new Error(`Timed out: ${label}`);
}
async function upload(local, target) { return await run('scp', [...sshConfig, local, `${cabinetHost}:${target.replaceAll('\\', '/')}`]); }
try {
  // This build is from the current working tree, including review changes.
  await run('dotnet', ['publish', 'agent/tests/Cabinet.Agent.ShellCabinet', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '--disable-build-servers', '-p:BuildInParallel=false', '-o', join(work, 'bin')], { stdio: 'inherit' });
  await run('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', join(work, 'agent'), join(work, 'bin')]);
  remote = await ps(`$d=Join-Path $env:TEMP ${quote(runId)}; New-Item -ItemType Directory -Path $d | Out-Null; $d`);
  await upload(join(work, 'agent.zip'), remote + '\\agent.zip');
  await ps(`Expand-Archive -LiteralPath ${quote(remote + '\\agent.zip')} -DestinationPath ${quote(remote + '\\bin')}`);
  db = await createTestDatabase();
  // Harness reads and service calls have their own connection and cannot queue
  // behind the API's held polls. Production pool sizes and admission gates stay intact.
  observer = await createPool(db.appUrl, 1);
  const { rootPem, issuingKey: key, tls } = await developmentPlatformPki(work, [platformHost]);
  writeFileSync(join(work, 'platform-ca.pem'), rootPem);
  await upload(join(work, 'platform-ca.pem'), remote + '\\platform-ca.pem');
  feed = new NotificationFeed(db.app, 50); await feed.start();
  notifier = new CommandNotifier(feed); await notifier.start();
  let lifecycle;
  const relay = new SessionRelay((c, s, a) => lifecycle.authorize(c, s, a));
  lifecycle = new SessionLifecycle(db.app, (c, s) => relay.close(c, s));
  api = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, sessionRelay: relay,
    tls, longPollMs: 1000, logger: true,
    onAdmissionDiagnostics: read => { admissionDiagnostics = read; },
    onAdmissionShed: reason => shedReasons.set(reason, (shedReasons.get(reason) ?? 0) + 1) });
  await api.listen({ host: '0.0.0.0', port: Number(process.env.SHELL_PLATFORM_PORT ?? 18443) });
  const server = `https://${platformHost}:${api.server.address().port}`;
  const operator = randomUUID();
  await observer.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'shell-acceptance', 'Shell acceptance operator', 'tier2')", [operator]);
  await observer.transaction(tx => grantPermission(tx, operator, operator, 'session.open', 'fleet', null));
  const bootstrap = await createBootstrapToken(observer, operator);
  writeFileSync(join(work, 'bootstrap-token'), bootstrap.token);
  await upload(join(work, 'bootstrap-token'), remote + '\\bootstrap-token');
  const config = { cabinetId: null, readOnlyMode: false, cabinetRole: null, scanner: { hardwareIds: [] }, syncCabinet: { address: null },
    platformServer: { host: platformHost, port: api.server.address().port }, allowedTcpPorts: [], localHarness: false, sessionsEnabled: true };
  async function stopAgent(removeKey = false) {
    if (!agentProcess) return;
    await ps(`${removeKey ? `New-Item -ItemType File -Path ${quote(remote + '\\delete-key')} -Force | Out-Null;` : ''} New-Item -ItemType File -Path ${quote(remote + '\\stop')} -Force | Out-Null`);
    await until(async () => await ps(`if (-not (Get-Process -Id ${agentProcess} -ErrorAction SilentlyContinue)) { 'stopped' }`), 'acceptance agent shutdown', { expectExit: true });
    agentProcess = undefined;
    await ps(`Remove-Item -LiteralPath ${quote(remote + '\\stop')}`);
  }
  writeFileSync(join(work, 'agent-config.json'), JSON.stringify(config)); await upload(join(work, 'agent-config.json'), remote + '\\agent-config.json');
  await startAgent(server);
  const request = await until(async () => (await observer.query("SELECT TOP (1) id FROM enrollment_requests WHERE status = 'pending' ORDER BY created_at DESC")).rows[0], 'cabinet enrollment');
  const enrolled = await approveEnrollment(observer, key, request.id, { clientName: runId, siteName: 'Tailnet lab', cabinetName: runId, role: 'standalone' }, operator);
  const cabinetId = enrolled.cabinetId;
  await until(async () => (await observer.query('SELECT id FROM cabinets WHERE id = $1 AND last_heartbeat_at IS NOT NULL', [cabinetId])).rows[0], 'first heartbeat');
  assert.equal((await observer.query('SELECT development_shell FROM cabinets WHERE id = $1', [cabinetId])).rows[0].development_shell, false);
  const token = await issueStepUpToken(observer, operator, 'session.open', cabinetId);
  await assert.rejects(openSession(observer, operator, cabinetId, { kind: 'shell', reason: 'Absent key must refuse', stepUpToken: token }), /not reported/);
  assert.equal((await observer.query("SELECT action FROM audit_log WHERE action = 'session.refused' AND target_id = $1", [cabinetId])).rows.length, 1);
  console.log('RED: key absent, capability absent, open refused and audited; no shell command queued');
  assert.equal((await observer.query('SELECT id FROM commands WHERE cabinet_id = $1', [cabinetId])).rows.length, 0);
  await stopAgent();
  config.developmentShellEnabled = true;
  writeFileSync(join(work, 'agent-config.json'), JSON.stringify(config)); await upload(join(work, 'agent-config.json'), remote + '\\agent-config.json');
  await startAgent(server);
  await until(async () => (await observer.query('SELECT id FROM cabinets WHERE id = $1 AND development_shell = 1', [cabinetId])).rows[0], 'opt-in capability');
  const greenToken = await issueStepUpToken(observer, operator, 'session.open', cabinetId);
  const { sessionId } = await openSession(observer, operator, cabinetId, { kind: 'shell', reason: 'Recorded real-cabinet acceptance over tailnet', stepUpToken: greenToken });
  await until(async () => (await observer.query("SELECT id FROM commands WHERE cabinet_id = $1 AND operation = 'session.open' AND status = 'succeeded'", [cabinetId])).rows[0], 'agent session opening');
  const shell = new SessionShell(observer);
  await shell.exchange(cabinetId, sessionId, 'console', { kind: 'shell.resize', columns: 100, rows: 30 }, operator);
  const marker = 'CABINET_SHELL_' + randomUUID().replaceAll('-', '');
  const command = `echo ${marker}\rwhoami\rhostname\rexit 7\r`;
  await shell.exchange(cabinetId, sessionId, 'console', { kind: 'shell.in', data: Buffer.from(command).toString('base64') }, operator);
  await until(async () => (await observer.query('SELECT closed_at FROM remote_sessions WHERE id = $1', [sessionId])).rows[0]?.closed_at, 'shell exit');
  const frames = (await observer.query('SELECT direction, frame FROM session_shell_frames WHERE session_id = $1 ORDER BY seq', [sessionId])).rows.map(r => ({ ...r, frame: typeof r.frame === 'string' ? JSON.parse(r.frame) : r.frame }));
  const output = frames.filter(f => f.frame.kind === 'shell.out').map(f => Buffer.from(f.frame.data, 'base64').toString()).join('');
  assert.ok(output.includes(marker), 'real command output missing');
  assert.ok(frames.some(f => f.frame.kind === 'shell.exit' && f.frame.code === 7));
  const commands = (await observer.query('SELECT input_data, complete FROM session_shell_commands WHERE session_id = $1 ORDER BY seq', [sessionId])).rows;
  assert.equal(commands.length, 4); assert.ok(commands.every(c => c.complete));
  assert.equal(commands.map(c => Buffer.from(c.input_data, 'base64').toString()).join(''), command);
  assert.equal((await verifyAuditChain(observer)).ok, true);
  console.log('GREEN: real Windows process output, exit 7, four durable commands, both directions and audit chain verified');
  console.log(output);
  console.log(JSON.stringify({ database: db.name, cabinetId, sessionId, transport: 'tailnet', offNetworkTested: false }));
  await stopAgent(true);
} finally {
  if (agentProcess && remote) {
    try { await ps(`New-Item -ItemType File -Path ${quote(remote + '\\delete-key')} -Force | Out-Null; New-Item -ItemType File -Path ${quote(remote + '\\stop')} -Force | Out-Null`); } catch { /* primary failure remains non-zero */ }
  }
  await api?.close(); await notifier?.stop(); feed?.stop();
  // Keep the actual database session/audit record for review; do not erase the evidence.
  await observer?.end();
  await db?.app.end();
  rmSync(work, { recursive: true, force: true });
  if (db) console.log(`Acceptance records retained in ${db.name}; off-network acceptance still needs a public platform endpoint.`);
}
