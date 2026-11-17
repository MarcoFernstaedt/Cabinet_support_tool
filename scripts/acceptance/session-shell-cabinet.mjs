// Real cabinet acceptance. Requires exported TEST_DATABASE_ADMIN_URL and SSH to deviceb.
// Uses an isolated database, a new CNG identity, and a temporary Windows host running the production agent connection.
// Existing cabinet services, configuration and enrollment are not changed. No public endpoint is simulated.
import assert from 'node:assert/strict';
import { BlockList, isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { X509Certificate, randomUUID } from 'node:crypto';
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
const offNetwork = process.env.SHELL_OFF_NETWORK === '1';
const platformPort = Number(process.env.SHELL_PLATFORM_PORT ?? 18443);
// The alternate listener port applies only to the existing host-served mode.
const platformListenPort = Number(process.env.SHELL_PLATFORM_LISTEN_PORT ?? platformPort);
if (offNetwork) {
  assert.ok(process.env.SHELL_PLATFORM_HOST, 'SHELL_OFF_NETWORK requires SHELL_PLATFORM_HOST=<public address>');
  assert.equal(isIP(process.env.SHELL_PLATFORM_HOST), 4, 'SHELL_OFF_NETWORK requires a public IPv4 address');
  assert.equal(platformPort, 8443, 'SHELL_OFF_NETWORK requires SHELL_PLATFORM_PORT=8443');
}
const cabinetHost = process.env.SHELL_CABINET_SSH ?? 'deviceb';
const platformHost = process.env.SHELL_PLATFORM_HOST ?? Object.entries(networkInterfaces()).filter(([name]) => name.startsWith('tailscale')).flatMap(([, addresses]) => addresses ?? []).find(a => a.family === 'IPv4')?.address;
assert.ok(platformHost, 'No tailnet interface found; export SHELL_PLATFORM_HOST as this host’s cabinet-reachable tailnet address');
const work = mkdtempSync(join(tmpdir(), 'shell-cabinet-'));
const runId = 'shell-' + randomUUID();
let observer, db, api, notifier, feed, remote, agentProcess;
let fallbackRegistered = false, fallbackDeadline = 0, fallbackRunsAt = 0, containerStopped = false;
let tailnetDownAt, tailnetRestoredAt, peerAddress;
const taskName = 'cabinet-acceptance-tailscale-restore';
const tailscale = "C:\\Program Files\\Tailscale\\tailscale.exe";
const platformContainer = runId + '-platform';
const platformImage = 'cabinet-shell-acceptance:local';
let platformContainerCreated = false;
const signalHandlers = new Map();
if (offNetwork) for (const signal of ['SIGINT', 'SIGTERM']) {
  const handler = () => { interrupted = new Error(`Interrupted by ${signal}`); };
  signalHandlers.set(signal, handler); process.on(signal, handler);
}
function tailnetAddress(address) {
  const tailnet = new BlockList();
  tailnet.addSubnet('100.64.0.0', 10, 'ipv4');
  assert.ok(isIP(address), `Agent API returned an invalid peer address: ${address}`);
  return tailnet.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
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
async function ps(source, options = {}) { return await run('ssh', [...sshConfig, cabinetHost, 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + source, 'utf16le').toString('base64')], options); }
const shedReasons = new Map();
let sshAvailable = true, interrupted;
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
  if (!remote || !sshAvailable) return;
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
    if (interrupted) throw interrupted;
    if (sshAvailable && agentProcess && !expectExit) await requireAgent(label);
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
// This bootstrap runs inside the built server image. The control listener is
// loopback-only and never published; socket peers come directly from the agent API.
async function containerPlatform() {
  const { readFileSync } = await import('node:fs');
  const { createServer } = await import('node:http');
  const base = '/build/server/dist/src/';
  const { createPool } = await import(base + 'db/db.js');
  const { developmentIssuingKey } = await import(base + 'pki/issuing.js');
  const { buildAgentApi } = await import(base + 'agent-api/server.js');
  const { NotificationFeed } = await import(base + 'db/notifications.js');
  const { CommandNotifier } = await import(base + 'agent-api/notifier.js');
  const { SessionRelay } = await import(base + 'agent-api/session-relay.js');
  const { SessionLifecycle } = await import(base + 'services/session-lifecycle.js');
  const config = JSON.parse(readFileSync('/acceptance/platform.json', 'utf8'));
  const pkiDir = '/acceptance/' + (await import('node:fs')).readdirSync('/acceptance').find(n => n.startsWith('acceptance-pki-'));
  const issuingKey = await developmentIssuingKey(pkiDir);
  const pool = await createPool(config.databaseUrl);
  const feed = new NotificationFeed(pool, 50); await feed.start();
  const notifier = new CommandNotifier(feed); await notifier.start();
  let lifecycle;
  const relay = new SessionRelay((c, s, a) => lifecycle.authorize(c, s, a));
  lifecycle = new SessionLifecycle(pool, (c, s) => relay.close(c, s));
  const api = await buildAgentApi({ pool, issuingKey, notifier, sessionRelay: relay, tls: config.tls, longPollMs: 1000, logger: true });
  const sockets = new Set(), connections = new Map();
  let excluded = new Set();
  api.server.on('secureConnection', socket => {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); connections.delete(socket); });
  });
  // Authentication has run, even when the handler will hold a command poll open.
  api.addHook('preHandler', async request => {
    const socket = request.raw.socket;
    if (request.cabinet && !socket.destroyed && !excluded.has(socket))
      connections.set(socket, { cabinetId: request.cabinet.id, peerAddress: socket.remoteAddress });
  });
  await api.listen({ host: '0.0.0.0', port: 8443 });
  createServer((request, response) => {
    if (request.url === '/reset') {
      excluded = new Set(sockets);
      for (const socket of excluded) socket.destroy();
      connections.clear();
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: true, connections: [...connections].filter(([socket]) => !socket.destroyed).map(([, c]) => c) }));
  }).listen(18444, '127.0.0.1');
}
async function platformControl(action) {
  return JSON.parse(await run('docker', ['exec', platformContainer, 'node', '-e',
    `fetch('http://127.0.0.1:18444/${action}').then(r => r.text()).then(console.log).catch(() => process.exit(1))`], { timeout: 10000 }));
}
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
  if (offNetwork) {
    assert.equal(new X509Certificate(tls.certPem).checkIP(platformHost), platformHost, 'Platform certificate must cover the public IP');
    // Build this working tree, using the repository's server stage. No deployed image
    // or host listener participates in the public path.
    await run('docker', ['build', '-f', 'deploy/Dockerfile', '--target', 'server-build', '-t', platformImage, '.']);
    const sqlContainer = process.env.SHELL_DATABASE_CONTAINER ?? 'cab-test-mssql';
    const [sql] = JSON.parse(await run('docker', ['inspect', sqlContainer]));
    const [network, endpoint] = Object.entries(sql.NetworkSettings.Networks)[0];
    const databaseUrl = new URL(db.appUrl);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname), 'Container SQL mapping requires a local test database');
    const binding = sql.NetworkSettings.Ports['1433/tcp'] ?? [];
    assert.ok(binding.some(b => b.HostPort === (databaseUrl.port || '1433')), 'SQL container must publish the acceptance database port');
    databaseUrl.hostname = endpoint.IPAddress;
    databaseUrl.port = '1433';
    writeFileSync(join(work, 'platform.json'), JSON.stringify({ databaseUrl: databaseUrl.toString(), platformHost, tls }));
    writeFileSync(join(work, 'platform.mjs'), '(' + containerPlatform.toString() + ')().catch(error => { console.error(error); process.exit(1); });');
    const running = await run('docker', ['inspect', '--format', '{{.State.Running}}', 'cabinet-server-1']);
    if (running === 'true') {
      containerStopped = true;
      await run('docker', ['stop', 'cabinet-server-1']);
    }
    // Set before creation so cleanup also handles an interrupted/failed docker run.
    platformContainerCreated = true;
    await run('docker', ['run', '-d', '--name', platformContainer, '--network', network,
      '-p', '8443:8443', '--mount', `type=bind,src=${work},dst=/acceptance,readonly`,
      '--entrypoint', 'node', platformImage, '/acceptance/platform.mjs']);
    await until(async () => {
      try { return (await platformControl('status')).ready; } catch { return false; }
    }, 'container platform ready');
  } else {
    feed = new NotificationFeed(db.app, 50); await feed.start();
    notifier = new CommandNotifier(feed); await notifier.start();
    let lifecycle;
    const relay = new SessionRelay((c, s, a) => lifecycle.authorize(c, s, a));
    lifecycle = new SessionLifecycle(db.app, (c, s) => relay.close(c, s));
    api = await buildAgentApi({ pool: db.app, issuingKey: key, notifier, sessionRelay: relay,
      tls, longPollMs: 1000, logger: true,
      onAdmissionDiagnostics: read => { admissionDiagnostics = read; },
      onAdmissionShed: reason => shedReasons.set(reason, (shedReasons.get(reason) ?? 0) + 1) });
    await api.listen({ host: '0.0.0.0', port: platformListenPort });
  }
  const server = `https://${platformHost}:${platformPort}`;
  const operator = randomUUID();
  await observer.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'shell-acceptance', 'Shell acceptance operator', 'tier2')", [operator]);
  await observer.transaction(tx => grantPermission(tx, operator, operator, 'session.open', 'fleet', null));
  const bootstrap = await createBootstrapToken(observer, operator);
  writeFileSync(join(work, 'bootstrap-token'), bootstrap.token);
  await upload(join(work, 'bootstrap-token'), remote + '\\bootstrap-token');
  const config = { cabinetId: null, readOnlyMode: false, cabinetRole: null, scanner: { hardwareIds: [] }, syncCabinet: { address: null },
    platformServer: { host: platformHost, port: platformPort }, allowedTcpPorts: [], localHarness: false, sessionsEnabled: true };
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
  if (offNetwork) {
    await until(async () => (await platformControl('status')).connections.some(c => c.cabinetId === cabinetId), 'authenticated baseline agent connection');
    await ps(`$state=& ${quote(tailscale)} status --json | ConvertFrom-Json; if ($state.BackendState -ne 'Running') { throw 'Baseline requires Tailscale Running' }`);
    // `tailscale down` stops the node, not the service, so starting the service is a no-op
    // when only the node is down: restart it (the recovery measured on the lab cabinet) and
    // confirm the node is back before the safety net is allowed to remove itself.
    const tailscaleNodeRestore = `$ts=${quote(tailscale)}; & $ts up *> $null; Start-Sleep -Seconds 3; if (((& $ts status --json | ConvertFrom-Json).BackendState) -ne 'Running') { Restart-Service Tailscale -Force; Start-Sleep -Seconds 12 }; if (((& $ts status --json | ConvertFrom-Json).BackendState) -ne 'Running') { throw 'Tailscale node did not come back' }; if ((Get-Service Tailscale).Status -ne 'Running') { (Get-Service Tailscale).WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) }`;
    const recovery = `try { ${tailscaleNodeRestore} } finally { if (((& ${quote(tailscale)} status --json | ConvertFrom-Json).BackendState) -eq 'Running') { Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false } }`;
    // Set the flag before registration: even a lost SSH response must enter cleanup.
    fallbackRegistered = true;
    fallbackRunsAt = Date.now() + 6 * 60_000;
    fallbackDeadline = fallbackRunsAt + 60_000;
    await ps(`$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote('-NoProfile -NonInteractive -EncodedCommand ' + Buffer.from("$ErrorActionPreference='Stop';" + recovery, 'utf16le').toString('base64'))}; $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(6); Register-ScheduledTask -TaskName ${quote(taskName)} -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null`);
    // Hold off the cabinet's own tailscale-watchdog for the tailnet-off window. The hold
    // file carries a timestamp and expires on its own, so a run that dies here cannot
    // leave the watchdog disabled.
    await ps(`Set-Content -Path C:\\tailscale-watchdog.hold -Value ([int][double]::Parse((Get-Date -UFormat %s))) -Encoding ascii`);
    // Losing SSH here is expected. No SSH probes or diagnostics until shell restoration.
    sshAvailable = false;
    try { await ps(`& ${quote(tailscale)} down; if ($LASTEXITCODE -ne 0) { throw 'tailscale down failed' }`, { timeout: 15000 }); }
    catch (error) { console.error('tailscale down SSH result (shell must verify stopped state):', error.message); }
    tailnetDownAt = new Date().toISOString();
    // Evict every pre-drop TLS connection; a later successful authenticated request
    // must use a new socket. The API observes the socket peer, never forwarded headers.
    await platformControl('reset');
    const connection = await until(async () => (await platformControl('status')).connections.find(c => c.cabinetId === cabinetId), 'fresh public agent reconnect after tailscale down');
    peerAddress = connection.peerAddress;
    assert.ok(peerAddress && !tailnetAddress(peerAddress), `Agent API observed tailnet peer: ${peerAddress}`);
  }
  const greenToken = await issueStepUpToken(observer, operator, 'session.open', cabinetId);
  const { sessionId } = await openSession(observer, operator, cabinetId, { kind: 'shell', reason: offNetwork ? 'Recorded real-cabinet acceptance over public internet' : 'Recorded real-cabinet acceptance over tailnet', stepUpToken: greenToken });
  await until(async () => (await observer.query("SELECT id FROM commands WHERE cabinet_id = $1 AND operation = 'session.open' AND status = 'succeeded'", [cabinetId])).rows[0], 'agent session opening');
  const shell = new SessionShell(observer);
  await shell.exchange(cabinetId, sessionId, 'console', { kind: 'shell.resize', columns: 100, rows: 30 }, operator);
  if (offNetwork) {
    async function shellPowerShell(source, label) {
      const done = 'DONE_' + randomUUID().replaceAll('-', '');
      const failed = 'FAIL_' + randomUUID().replaceAll('-', '');
      const encoded = Buffer.from(`$ErrorActionPreference='Stop'; try { ${source}; Write-Output ('DONE_' + '${done.slice(5)}') } catch { Write-Output $_; Write-Output ('FAIL_' + '${failed.slice(5)}'); exit 1 }`, 'utf16le').toString('base64');
      // A Windows console drops input typed while the previous child is still tearing down:
      // its exit flushes the pending input buffer, so keystrokes sent the instant DONE_ prints
      // never reach the shell. Wait for the console to settle before typing the next command -
      // what an operator does when waiting for a prompt - so each check runs in its own child.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await shell.exchange(cabinetId, sessionId, 'console', { kind: 'shell.in', data: Buffer.from(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}\r`).toString('base64') }, operator);
      return await until(async () => {
        const rows = (await observer.query('SELECT frame FROM session_shell_frames WHERE session_id = $1 ORDER BY seq', [sessionId])).rows;
        const output = rows.map(r => typeof r.frame === 'string' ? JSON.parse(r.frame) : r.frame).filter(f => f.kind === 'shell.out').map(f => Buffer.from(f.data, 'base64').toString()).join('').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        assert.ok(!output.includes(failed), `${label} failed through operator shell: ${output}`);
        return output.includes(done) ? output : null;
      }, label);
    }
    // Completion tokens are assembled inside the child, so input echo/title cannot satisfy this check.
    const firstOutput = await shellPowerShell(`Write-Output ('CHILD_' + 'STDOUT'); [Console]::Error.WriteLine(('CHILD_' + 'STDERR'))`, 'first child process output');
    assert.ok(firstOutput.includes('CHILD_STDOUT'), 'First child stdout missing');
    assert.ok(firstOutput.includes('CHILD_STDERR'), 'First child stderr missing');
    await shellPowerShell(`$state=& ${quote(tailscale)} status --json | ConvertFrom-Json; if ($state.BackendState -ne 'Stopped') { throw 'Tailscale did not go down' }`, 'shell verifies Tailscale stopped');
    // Consecutive plain shell commands in the session's own cmd.exe, three of them, each
    // answering with a computed value the typed line does not contain, so input echo cannot
    // satisfy it. This is the instrument for the consecutive-command defect: the PowerShell
    // checks above complete, while the third command typed into one session has been observed
    // to be delivered, echoed in fragments, and never run. It runs before the whoami check
    // only while that defect is open; move it after when the defect is fixed.
    async function shellLine(line, expect, label) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await shell.exchange(cabinetId, sessionId, 'console', { kind: 'shell.in', data: Buffer.from(`${line}\r`).toString('base64') }, operator);
      return await until(async () => {
        const rows = (await observer.query('SELECT frame FROM session_shell_frames WHERE session_id = $1 ORDER BY seq', [sessionId])).rows;
        const output = rows.map(r => typeof r.frame === 'string' ? JSON.parse(r.frame) : r.frame).filter(f => f.kind === 'shell.out').map(f => Buffer.from(f.data, 'base64').toString()).join('').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        return output.includes(expect) ? output : null;
      }, label);
    }
    for (let n = 0; n < 3; n++) {
      const a = 100 + Math.floor(Math.random() * 800);
      const b = 100 + Math.floor(Math.random() * 800);
      await shellLine(`set /a ${a}+${b}`, String(a + b), `plain consecutive command ${n + 1} of 3`);
    }
    await shellPowerShell(`$identity=whoami; $identity; $machine=($identity -match '^NT AUTHORITY\\') -or ($identity -match ('^' + [regex]::Escape($env:COMPUTERNAME) + '\\')); if ($LASTEXITCODE -ne 0 -or -not $machine) { throw 'whoami did not name the cabinet machine context' }`, 'off-network whoami');
    await shellPowerShell(`$entries=@(Get-ChildItem $env:USERPROFILE/Desktop); $entries | Format-Table | Out-String | Write-Output; if ($entries.Count -eq 0) { throw 'Desktop listing empty' }`, 'off-network desktop listing');
    const desktopMarker = runId + '.txt';
    await shellPowerShell(`$path=Join-Path $env:USERPROFILE ${quote('Desktop/' + desktopMarker)}; $created=$false; try { $file=[System.IO.File]::Open($path, 'CreateNew', 'Write'); $created=$true; try { $file.WriteByte(65) } finally { $file.Dispose() }; if (-not (Test-Path -LiteralPath $path)) { throw 'Marker missing' } } finally { if ($created) { Remove-Item -LiteralPath $path } }; if (Test-Path -LiteralPath $path) { throw 'Marker cleanup failed' }`, 'off-network marker write and cleanup');
    assert.ok(Date.now() < fallbackRunsAt - 15000, 'Off-network proof exceeded fallback window');
    await shellPowerShell(`$state=& ${quote(tailscale)} status --json | ConvertFrom-Json; if ($state.BackendState -ne 'Stopped') { throw 'Tailscale restored before shell proof' }; ${tailscaleNodeRestore}`, 'Tailscale restoration through operator shell');
    assert.ok(Date.now() < fallbackRunsAt, 'Scheduled fallback may have restored Tailscale before shell completion');
    await until(async () => { try { return (await ps("'SSH_RESTORED'", { timeout: 12000 })) === 'SSH_RESTORED'; } catch { return false; } }, 'SSH returns after shell restoration');
    sshAvailable = true;
    tailnetRestoredAt = new Date().toISOString();
    await ps(`Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false; if (Get-ScheduledTask -TaskName ${quote(taskName)} -ErrorAction SilentlyContinue) { throw 'Fallback task still registered' }; Remove-Item C:\\tailscale-watchdog.hold -ErrorAction SilentlyContinue`);
    fallbackRegistered = false;
  }
  const marker = 'CABINET_SHELL_' + randomUUID().replaceAll('-', '');
  const command = `echo ${marker}\rwhoami\rhostname\rexit 7\r`;
  await shell.exchange(cabinetId, sessionId, 'console', { kind: 'shell.in', data: Buffer.from(command).toString('base64') }, operator);
  await until(async () => (await observer.query('SELECT closed_at FROM remote_sessions WHERE id = $1', [sessionId])).rows[0]?.closed_at, 'shell exit');
  const frames = (await observer.query('SELECT direction, frame FROM session_shell_frames WHERE session_id = $1 ORDER BY seq', [sessionId])).rows.map(r => ({ ...r, frame: typeof r.frame === 'string' ? JSON.parse(r.frame) : r.frame }));
  const output = frames.filter(f => f.frame.kind === 'shell.out').map(f => Buffer.from(f.frame.data, 'base64').toString()).join('');
  assert.ok(output.includes(marker), 'real command output missing');
  assert.ok(frames.some(f => f.frame.kind === 'shell.exit' && f.frame.code === 7));
  const commands = (await observer.query('SELECT input_data, complete FROM session_shell_commands WHERE session_id = $1 ORDER BY seq', [sessionId])).rows;
  assert.equal(commands.length, offNetwork ? 10 : 4); assert.ok(commands.every(c => c.complete));
  assert.equal(commands.slice(offNetwork ? -4 : 0).map(c => Buffer.from(c.input_data, 'base64').toString()).join(''), command);
  assert.equal((await verifyAuditChain(observer)).ok, true);
  console.log(`GREEN: real Windows process output, exit 7, ${offNetwork ? 'ten' : 'four'} durable commands, both directions and audit chain verified`);
  console.log(output);
  console.log(JSON.stringify({ database: db.name, cabinetId, sessionId, transport: offNetwork ? 'public' : 'tailnet', offNetworkTested: offNetwork, ...(offNetwork ? { platformHost, platformPort, peerAddress, tailnetDownAt, tailnetRestoredAt } : {}) }));
  await stopAgent(true);
} finally {
  let recoveryError;
  if (fallbackRegistered) {
    // Keep the API alive while recovery is pending. Do not remove the safety net
    // before it has restored connectivity on a failed off-network run.
    if (!sshAvailable) {
      console.error('Waiting for scheduled fallback before SSH cleanup after failed off-network proof');
      while (Date.now() < fallbackRunsAt) await new Promise(r => setTimeout(r, Math.min(1000, fallbackRunsAt - Date.now())));
    }
    while (true) {
      try {
        await ps(`if ((Get-Service Tailscale).Status -ne 'Running') { Start-Service Tailscale }; (Get-Service Tailscale).WaitForStatus('Running', [TimeSpan]::FromSeconds(30)); if (Get-ScheduledTask -TaskName ${quote(taskName)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false }; if (Get-ScheduledTask -TaskName ${quote(taskName)} -ErrorAction SilentlyContinue) { throw 'Fallback task still registered' }`, { timeout: 12000 });
        sshAvailable = true; fallbackRegistered = false; break;
      } catch (error) {
        if (Date.now() >= fallbackDeadline) { recoveryError = new Error(`Fallback cleanup could not reach cabinet: ${error.message}`); break; }
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  if (agentProcess && remote && sshAvailable) {
    try { await ps(`New-Item -ItemType File -Path ${quote(remote + '\\delete-key')} -Force | Out-Null; New-Item -ItemType File -Path ${quote(remote + '\\stop')} -Force | Out-Null`); } catch { /* primary failure remains non-zero */ }
  }
  // Container teardown and deployment restoration must run even if API close fails.
  try { await api?.close(); } catch (error) { recoveryError ??= error; }
  if (platformContainerCreated) {
    try { console.error(await run('docker', ['logs', platformContainer])); } catch { /* creation may have failed */ }
    try { await run('docker', ['rm', '-f', platformContainer]); } catch (error) { recoveryError ??= error; }
  }
  if (containerStopped) {
    try { await run('docker', ['start', 'cabinet-server-1']); } catch (error) { recoveryError ??= error; }
  }
  await notifier?.stop(); feed?.stop();
  // Keep the actual database session/audit record for review; do not erase the evidence.
  await observer?.end();
  await db?.app.end();
  rmSync(work, { recursive: true, force: true });
  if (db) console.log(`Acceptance records retained in ${db.name}${offNetwork ? '' : '; off-network acceptance still needs a public platform endpoint'}.`);
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  if (recoveryError) throw recoveryError;
  if (interrupted) throw interrupted;
}
