// Real cabinet enrollment and development SSH transport acceptance.
// Off-network mode also requires a cabinet SSH user and an authorized key.
// Uses an isolated database, a new CNG identity, and a temporary Windows host running the production agent connection.
// Existing cabinet services, configuration and enrollment are not changed. No public endpoint is simulated.
import assert from 'node:assert/strict';
import { BlockList, isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { X509Certificate, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestDatabase } from '../../server/dist/test/database.js';
import { developmentPlatformPki } from '../../server/dist/src/pki/issuing.js';
import { buildAgentApi } from '../../server/dist/src/agent-api/server.js';
import { CommandNotifier } from '../../server/dist/src/agent-api/notifier.js';
import { NotificationFeed } from '../../server/dist/src/db/notifications.js';
import { createBootstrapToken, approveEnrollment } from '../../server/dist/src/services/enrollment.js';
import { opsMeter, splitKey } from '../../server/dist/src/services/ops-meter.js';
import { createPool, transaction, verifyAuditChain } from '../../server/dist/src/db/db.js';
import { createSession, COOKIE } from '../../server/dist/src/auth/sessions.js';
import { issueStepUpToken } from '../../server/dist/src/auth/stepup.js';
import { grantPermission, sshTransportPermission } from '../../server/dist/src/services/user-permissions.js';
const sshConfig = ['-F', join(homedir(), '.ssh/config'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const offNetwork = process.env.SHELL_OFF_NETWORK === '1';
const sshUser = process.env.SHELL_SSH_USER;
const sshIdentity = process.env.SHELL_SSH_IDENTITY;
if (offNetwork) {
  assert.ok(sshUser?.trim(), 'Set SHELL_SSH_USER to the cabinet account');
  assert.ok(sshIdentity, 'Set SHELL_SSH_IDENTITY to an authorized SSH identity file');
}
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
let cabinetId, tailnetDownAt, tailnetEvidencePath, peerAddress;
let enrollmentVerified = false, sshProof;
const evidenceFile = 'ssh-transport-evidence.json';
const taskName = 'cabinet-acceptance-tailscale-restore';
const tailscale = "C:\\Program Files\\Tailscale\\tailscale.exe";
const platformContainer = runId + '-platform';
const platformImage = 'cabinet-shell-acceptance:local';
const sshPortMin = 19000;
const sshPortMax = 19099;
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
async function run(binary, args, { stage, ...options } = {}) {
  if (stage) console.log(`stage: ${stage}`);
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
      `$f=Join-Path ${quote(remote)} ${quote(name)}; Write-Output ${quote('--- ' + name + ' ---')}; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f } else { Write-Output '(missing)' }`).join(';'), { stage: 'read cabinet agent diagnostics' }));
  } catch (error) { console.error('Could not read acceptance agent output:', error.message); }
}
async function agentState() {
  return JSON.parse(await ps(`$p=Get-Process -Id ${agentProcess} -ErrorAction SilentlyContinue; $record=$null; $f=Join-Path ${quote(remote)} 'process-state.json'; if (-not $p) { for ($i=0; $i -lt 20 -and -not (Test-Path -LiteralPath $f); $i++) { Start-Sleep -Milliseconds 50 } }; if (Test-Path -LiteralPath $f) { $record=Get-Content -Raw -LiteralPath $f | ConvertFrom-Json }; @{ pid=${agentProcess}; state=$(if ($p) { 'running' } else { 'exited' }); exitCode=$(if ($record) { $record.exitCode } else { $null }); recordedState=$record } | ConvertTo-Json -Compress -Depth 4`, { stage: 'check cabinet agent process' }));
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
  await run('ssh', [...sshConfig, cabinetHost, 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${launcher}"`], { stage: 'launch acceptance agent' });
  // This delay and probe occur after the creating SSH session has ended.
  await new Promise(r => setTimeout(r, 1000));
  const pid = await ps(`$f=Join-Path ${quote(remote)} 'agent.pid'; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f }`, { stage: 'read cabinet agent PID' });
  agentProcess = Number(pid);
  if (!Number.isSafeInteger(agentProcess) || agentProcess <= 0) {
    agentProcess = undefined;
    await agentDiagnostics();
    const state = await ps(`$f=Join-Path ${quote(remote)} 'process-state.json'; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f } else { 'supervisor has not reported an agent PID; exit code unavailable' }`, { stage: 'read cabinet agent launch failure' });
    throw new Error(`Acceptance agent launch failed; process state: ${state}`);
  }
  await requireAgent('detached startup (one second after launch)');
}
async function until(read, label, { expectExit = false, deadlineError = () => new Error(`Timed out: ${label}`) } = {}) {
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
  throw deadlineError();
}
async function upload(local, target) { return await run('scp', [...sshConfig, local, `${cabinetHost}:${target.replaceAll('\\', '/')}`], { stage: `upload ${target.split('\\').at(-1)}` }); }
async function uploadScript(name, body) {
  const local = join(work, name);
  const target = remote + '\\' + name;
  // Windows PowerShell uses the BOM to recognize UTF-8 script files.
  writeFileSync(local, "\uFEFF$ErrorActionPreference='Stop'\r\n" + body);
  await upload(local, target);
  return target;
}
async function requirePlatformReachable() {
  const target = `${platformHost}:${platformPort}`;
  try {
    await ps(`$client=[Net.Sockets.TcpClient]::new(); try { $connect=$client.ConnectAsync(${quote(platformHost)}, ${platformPort}); if (-not $connect.Wait(5000)) { throw 'TCP connect timed out' }; $connect.GetAwaiter().GetResult() } finally { $client.Dispose() }`, { stage: 'platform reachability preflight', timeout: 20000 });
  } catch (error) {
    const failure = new Error(`Platform reachability preflight failed from cabinet ${cabinetHost} to ${target}: ${error.message}`, { cause: error });
    console.error(failure.message);
    throw failure;
  }
  console.log(`Platform reachability preflight passed from cabinet ${cabinetHost} to ${target}`);
}
// This bootstrap runs inside the built server image. Docker forwards published
// ports to the bridge interface, so relay only the assigned SSH port to loopback.
async function containerPlatform() {
  const { readFileSync } = await import('node:fs');
  const { createServer } = await import('node:http');
  const { createConnection, createServer: createTcpServer } = await import('node:net');
  const { networkInterfaces } = await import('node:os');
  const { randomBytes } = await import('node:crypto');
  const base = '/build/server/dist/src/';
  const { createPool } = await import(base + 'db/db.js');
  const { developmentIssuingKey } = await import(base + 'pki/issuing.js');
  const { buildAgentApi } = await import(base + 'agent-api/server.js');
  const { NotificationFeed } = await import(base + 'db/notifications.js');
  const { CommandNotifier } = await import(base + 'agent-api/notifier.js');
  const { buildConsoleApi } = await import(base + 'console-api/server.js');
  const { SecretBox } = await import(base + 'auth/secrets.js');
  const { SshTransport } = await import(base + 'services/ssh-transport.js');
  const config = JSON.parse(readFileSync('/acceptance/platform.json', 'utf8'));
  const bridgeAddress = Object.values(networkInterfaces()).flat().find(address => !address.internal && address.family === 'IPv4')?.address;
  if (!bridgeAddress) throw new Error('Acceptance platform has no IPv4 bridge address');
  const pkiDir = '/acceptance/' + (await import('node:fs')).readdirSync('/acceptance').find(n => n.startsWith('acceptance-pki-'));
  const issuingKey = await developmentIssuingKey(pkiDir);
  const pool = await createPool(config.databaseUrl);
  const feed = new NotificationFeed(pool, 50); await feed.start();
  const notifier = new CommandNotifier(feed); await notifier.start();
  const sshTransport = new SshTransport(pool);
  const consoleApi = await buildConsoleApi({ pool, issuingKey, sshTransport,
    origin: 'https://acceptance.invalid', secrets: new SecretBox(randomBytes(32).toString('base64')) });
  const api = await buildAgentApi({ pool, issuingKey, notifier, sshTransport, tls: config.tls, longPollMs: 1000, logger: true });
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
  createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/ssh-open') {
      try {
        const options = JSON.parse(readFileSync('/acceptance/ssh-request.json', 'utf8'));
        const malformed = await consoleApi.inject({ ...options, payload: { ...options.payload, host: '127.0.0.2', port: 23 } });
        if (malformed.statusCode !== 400) throw new Error('Console accepted a caller-supplied SSH destination');
        const opened = await consoleApi.inject(options);
        const body = opened.json();
        if (opened.statusCode === 200) {
          const { host, port } = body.endpoint;
          if (host !== '127.0.0.1' || !Number.isInteger(port) || port < config.sshPortMin || port > config.sshPortMax)
            throw new Error(`SSH transport endpoint is outside the published loopback range: ${host}:${port}`);
          const relay = createTcpServer(client => {
            if (client.remoteAddress !== config.bridgeGateway) {
              client.destroy();
              return;
            }
            clearTimeout(expiry);
            relay.close();
            const transport = createConnection({ host, port });
            client.on('error', () => transport.destroy());
            transport.on('error', () => client.destroy());
            client.pipe(transport).pipe(client);
          });
          await new Promise((resolve, reject) => {
            relay.once('error', reject);
            relay.listen({ host: bridgeAddress, port }, resolve);
          });
          const expiry = setTimeout(() => relay.close(), 60_000);
        }
        response.end(JSON.stringify({ status: opened.statusCode, body }));
      } catch (error) {
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (request.url === '/reset') {
      excluded = new Set(sockets);
      for (const socket of excluded) socket.destroy();
      connections.clear();
    }
    response.end(JSON.stringify({ ready: true, connections: [...connections].filter(([socket]) => !socket.destroyed).map(([, c]) => c) }));
  }).listen('/tmp/acceptance-control.sock');
}
async function platformControl(action, stage) {
  return JSON.parse(await run('docker', ['exec', platformContainer, 'node', '-e',
    `require('node:http').get({ socketPath: '/tmp/acceptance-control.sock', path: '/${action}' }, response => response.pipe(process.stdout)).on('error', () => process.exit(1))`], { stage, timeout: 10000 }));
}
let primaryFailed = false;
function reportPrimaryFailure(error) {
  primaryFailed = true;
  process.exitCode = 1;
  console.error('Acceptance failed:', error);
}
try {
  // This build is from the current working tree, including review changes.
  await run('dotnet', ['publish', 'agent/tests/Cabinet.Agent.ShellCabinet', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '--disable-build-servers', '-p:BuildInParallel=false', `-p:DevelopmentSshTransport=${offNetwork}`, '-o', join(work, 'bin')], { stdio: 'inherit' });
  await run('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', join(work, 'agent'), join(work, 'bin')]);
  remote = await ps(`$d=Join-Path $env:TEMP ${quote(runId)}; New-Item -ItemType Directory -Path $d | Out-Null; $d`, { stage: 'create cabinet acceptance directory' });
  await upload(join(work, 'agent.zip'), remote + '\\agent.zip');
  await ps(`Expand-Archive -LiteralPath ${quote(remote + '\\agent.zip')} -DestinationPath ${quote(remote + '\\bin')}`, { stage: 'extract acceptance agent' });
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
    const [network, endpoint] = Object.entries(sql.NetworkSettings.Networks)[0] ?? [];
    assert.ok(endpoint?.IPAddress && endpoint.Gateway, 'SQL container must have an IPv4 bridge endpoint');
    assert.equal(await run('docker', ['network', 'inspect', '--format', '{{.Driver}}', network]), 'bridge');
    const databaseUrl = new URL(db.appUrl);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname), 'Container SQL mapping requires a local test database');
    const binding = sql.NetworkSettings.Ports['1433/tcp'] ?? [];
    assert.ok(binding.some(b => b.HostPort === (databaseUrl.port || '1433')), 'SQL container must publish the acceptance database port');
    databaseUrl.hostname = endpoint.IPAddress;
    databaseUrl.port = '1433';
    writeFileSync(join(work, 'platform.json'), JSON.stringify({
      databaseUrl: databaseUrl.toString(), tls, bridgeGateway: endpoint.Gateway, sshPortMin, sshPortMax,
    }));
    writeFileSync(join(work, 'platform.mjs'), '(' + containerPlatform.toString() + ')().catch(error => { console.error(error); process.exit(1); });');
    const running = await run('docker', ['inspect', '--format', '{{.State.Running}}', 'cabinet-server-1']);
    if (running === 'true') {
      containerStopped = true;
      await run('docker', ['stop', 'cabinet-server-1']);
    }
    // Set before creation so cleanup also handles an interrupted/failed docker run.
    platformContainerCreated = true;
    const sshPorts = `${sshPortMin}-${sshPortMax}`;
    await run('docker', ['run', '-d', '--name', platformContainer, '--network', network,
      '--sysctl', `net.ipv4.ip_local_port_range=${sshPortMin} ${sshPortMax}`,
      '-p', '8443:8443', '-p', `127.0.0.1:${sshPorts}:${sshPorts}`,
      '--mount', `type=bind,src=${work},dst=/acceptance,readonly`,
      '--entrypoint', 'node', platformImage, '/acceptance/platform.mjs']);
    await until(async () => {
      try { return (await platformControl('status')).ready; } catch { return false; }
    }, 'container platform ready');
  } else {
    feed = new NotificationFeed(db.app, 50); await feed.start();
    notifier = new CommandNotifier(feed); await notifier.start();
    api = await buildAgentApi({ pool: db.app, issuingKey: key, notifier,
      tls, longPollMs: 1000, logger: true,
      onAdmissionDiagnostics: read => { admissionDiagnostics = read; },
      onAdmissionShed: reason => shedReasons.set(reason, (shedReasons.get(reason) ?? 0) + 1) });
    await api.listen({ host: '0.0.0.0', port: platformListenPort });
  }
  const server = `https://${platformHost}:${platformPort}`;
  await requirePlatformReachable();
  const operator = randomUUID();
  await observer.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'shell-acceptance', 'Shell acceptance operator', 'tier2')", [operator]);
  const bootstrap = await createBootstrapToken(observer, operator);
  writeFileSync(join(work, 'bootstrap-token'), bootstrap.token);
  await upload(join(work, 'bootstrap-token'), remote + '\\bootstrap-token');
  const config = { cabinetId: null, readOnlyMode: false, cabinetRole: null, scanner: { hardwareIds: [] }, syncCabinet: { address: null },
    platformServer: { host: platformHost, port: platformPort }, allowedTcpPorts: [], localHarness: false, developmentSshTransportEnabled: offNetwork };
  async function stopAgent(removeKey = false) {
    if (!agentProcess) return;
    await ps(`${removeKey ? `New-Item -ItemType File -Path ${quote(remote + '\\delete-key')} -Force | Out-Null;` : ''} New-Item -ItemType File -Path ${quote(remote + '\\stop')} -Force | Out-Null`, { stage: 'request cabinet agent shutdown' });
    await until(async () => await ps(`if (-not (Get-Process -Id ${agentProcess} -ErrorAction SilentlyContinue)) { 'stopped' }`, { stage: 'wait for cabinet agent shutdown' }), 'acceptance agent shutdown', { expectExit: true });
    agentProcess = undefined;
    await ps(`Remove-Item -LiteralPath ${quote(remote + '\\stop')}`, { stage: 'clear cabinet agent stop marker' });
  }
  writeFileSync(join(work, 'agent-config.json'), JSON.stringify(config)); await upload(join(work, 'agent-config.json'), remote + '\\agent-config.json');
  await startAgent(server);
  const request = await until(async () => (await observer.query("SELECT TOP (1) id FROM enrollment_requests WHERE status = 'pending' ORDER BY created_at DESC")).rows[0], 'cabinet enrollment');
  const enrolled = await approveEnrollment(observer, key, request.id, { clientName: runId, siteName: 'Tailnet lab', cabinetName: runId, role: 'standalone' }, operator);
  cabinetId = enrolled.cabinetId;
  await until(async () => (await observer.query('SELECT id FROM cabinets WHERE id = $1 AND last_heartbeat_at IS NOT NULL', [cabinetId])).rows[0], 'first heartbeat');
  if (offNetwork) {
    console.log('stage: wait for authenticated baseline agent connection');
    await until(async () => (await platformControl('status')).connections.some(c =>
      c.cabinetId === cabinetId && c.peerAddress && !tailnetAddress(c.peerAddress)), 'authenticated public baseline agent connection');
    const hostKey = (await ps("(Get-Content -LiteralPath 'C:\\ProgramData\\ssh\\ssh_host_ed25519_key.pub').Trim()", { stage: 'read cabinet SSH host key' })).split(/\s+/).slice(0, 2).join(' ');
    assert.match(hostKey, /^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
    const cabinetPrincipal = (await ps('whoami.exe', { stage: 'read cabinet SSH principal' })).toLowerCase();
    await ps(`$state=& ${quote(tailscale)} status --json | ConvertFrom-Json; if ($state.BackendState -ne 'Running') { throw 'Baseline requires Tailscale Running' }`, { stage: 'check Tailscale baseline' });
    // `tailscale down` stops the node, not the service, so starting the service is a no-op
    // when only the node is down: restart it (the recovery measured on the lab cabinet) and
    // confirm the node is back before the safety net is allowed to remove itself.
    const tailscaleNodeRestore = `$ts=${quote(tailscale)}; & $ts up *> $null; Start-Sleep -Seconds 3; if (((& $ts status --json | ConvertFrom-Json).BackendState) -ne 'Running') { Restart-Service Tailscale -Force; Start-Sleep -Seconds 12 }; if (((& $ts status --json | ConvertFrom-Json).BackendState) -ne 'Running') { throw 'Tailscale node did not come back' }; if ((Get-Service Tailscale).Status -ne 'Running') { (Get-Service Tailscale).WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) }`;
    tailnetEvidencePath = remote + '\\tailnet-before-recovery.txt';
    const recovery = `try { ${tailscaleNodeRestore} } finally { if (((& ${quote(tailscale)} status --json | ConvertFrom-Json).BackendState) -eq 'Running') { Unregister-ScheduledTask -TaskName ${quote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue } }`;
    const downPath = await uploadScript('tailscale-down.ps1', `
      & ${quote(tailscale)} down;
      if ($LASTEXITCODE -ne 0) { throw "tailscale down failed with exit code $LASTEXITCODE" }
      $status = & ${quote(tailscale)} status --json;
      if ($LASTEXITCODE -ne 0) { throw "tailscale status failed with exit code $LASTEXITCODE" }
      $state = ($status | ConvertFrom-Json).BackendState;
      [IO.File]::WriteAllText(${quote(tailnetEvidencePath)}, $state);
      if ($state -ne 'Stopped') { throw "Expected Tailscale Stopped, observed $state" }`);
    const recoveryPath = await uploadScript('tailscale-restore.ps1', recovery);
    const evidenceScript = `
      $connections=@(Get-NetTCPConnection -OwningProcess ${agentProcess} | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,@{n='State';e={$_.State.ToString()}});
      $state=(& ${quote(tailscale)} status --json | ConvertFrom-Json).BackendState;
      $principal=(whoami.exe).Trim();
      $evidence=@{result=${quote(runId)}; principal=$principal; agentPid=${agentProcess}; tailnetState=$state; connections=$connections};
      [IO.File]::WriteAllText(${quote(remote + '\\' + evidenceFile)}, ($evidence | ConvertTo-Json -Compress -Depth 4));`;
    const evidencePath = await uploadScript('ssh-transport-evidence.ps1', evidenceScript);
    // Set the flag before registration: even a lost SSH response must enter cleanup.
    fallbackRegistered = true;
    fallbackRunsAt = Date.now() + 6 * 60_000;
    fallbackDeadline = fallbackRunsAt + 60_000;
    const recoveryArgs = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${recoveryPath}"`;
    await ps(`$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(recoveryArgs)}; $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(6); Register-ScheduledTask -TaskName ${quote(taskName)} -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null`, { stage: 'register Tailscale fallback' });
    // Hold off the cabinet's own tailscale-watchdog for the tailnet-off window. The hold
    // file carries a timestamp and expires on its own, so a run that dies here cannot
    // leave the watchdog disabled.
    await ps(`Set-Content -Path C:\\tailscale-watchdog.hold -Value ([int][double]::Parse((Get-Date -UFormat %s))) -Encoding ascii`, { stage: 'hold Tailscale watchdog' });
    await transaction(observer, tx => grantPermission(tx, operator, operator, sshTransportPermission, 'cabinet', cabinetId, true));
    const cookie = await createSession(observer, operator, 'complete', '127.0.0.1');
    async function openTransport(stage) {
      const stepUpToken = await issueStepUpToken(observer, operator, sshTransportPermission, cabinetId);
      const requestFile = join(work, 'ssh-request.json');
      writeFileSync(requestFile, JSON.stringify({ method: 'POST', url: `/api/cabinets/${cabinetId}/ssh-transport`,
        headers: { origin: 'https://acceptance.invalid', cookie: `${COOKIE}=${cookie}`, 'content-type': 'application/json' },
        payload: { stepUpToken } }), { mode: 0o600 });
      let opened;
      try { opened = await platformControl('ssh-open', stage); }
      finally { rmSync(requestFile); }
      assert.equal(opened.status, 200, JSON.stringify(opened));
      const { transportId, endpoint } = opened.body;
      assert.equal(endpoint.host, '127.0.0.1');
      assert.ok(Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535);
      return { transportId, endpoint };
    }
    async function runTransportScript(endpoint, scriptPath, stage) {
      const knownHosts = join(work, 'known_hosts');
      writeFileSync(knownHosts, `[127.0.0.1]:${endpoint.port} ${hostKey}\n`);
      await run('ssh', ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'IdentitiesOnly=yes',
        '-o', 'PreferredAuthentications=publickey', '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
        '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', `UserKnownHostsFile=${knownHosts}`, '-i', resolve(sshIdentity),
        '-p', String(endpoint.port), '-l', sshUser, '127.0.0.1', 'powershell.exe', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-File', `"${scriptPath}"`], { stage, timeout: 45_000 });
    }
    async function verifyTransport({ transportId, endpoint }) {
      const auditRows = await until(async () => {
        const rows = (await observer.query(`SELECT action, actor_id, target_id, details FROM audit_log
          WHERE action IN ('ssh.transport.open', 'ssh.transport.close') ORDER BY seq`)).rows;
        const matching = rows.filter(row => {
          const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
          return details.transportId === transportId;
        });
        return matching.length >= 2 ? matching : null;
      }, 'SSH open and close audit');
      assert.deepEqual(auditRows.map(row => row.action), ['ssh.transport.open', 'ssh.transport.close']);
      for (const row of auditRows) {
        assert.equal(row.actor_id, operator);
        assert.equal(row.target_id, cabinetId);
        const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
        assert.deepEqual(details.endpoint, endpoint);
      }
      const { rows: [session] } = await observer.query(
        'SELECT cabinet_id, operator_id, kind, closed_at FROM remote_sessions WHERE id = $1', [transportId]);
      assert.ok(session?.closed_at, 'SSH transport must retain a closed session record');
      assert.equal(session.cabinet_id, cabinetId);
      assert.equal(session.operator_id, operator);
      assert.equal(session.kind, 'ssh');
      return { session, auditEvents: auditRows };
    }

    const downTransport = await openTransport('open SSH transport for Tailscale down');
    sshAvailable = false;
    await runTransportScript(downTransport.endpoint, downPath, 'take Tailscale down');
    tailnetDownAt = new Date().toISOString();
    // Evict every pre-drop TLS connection; a later successful authenticated request
    // must use a new socket. The API observes the socket peer, never forwarded headers.
    await platformControl('reset', 'reset pre-drop platform connections');
    console.log('stage: wait for public agent reconnect');
    const connection = await until(async () => (await platformControl('status')).connections.find(c => c.cabinetId === cabinetId), 'fresh public agent reconnect after tailscale down');
    assert.ok(Date.now() < fallbackRunsAt, "Scheduled recovery preceded the public reconnect");
    peerAddress = connection.peerAddress;
    assert.ok(peerAddress && !tailnetAddress(peerAddress), `Agent API observed tailnet peer: ${peerAddress}`);
    await verifyTransport(downTransport);
    const transport = await openTransport('open SSH transport');
    const { transportId, endpoint } = transport;
    await runTransportScript(endpoint, evidencePath, 'run command through SSH transport');
    assert.ok(Date.now() < fallbackRunsAt, 'Scheduled recovery preceded the SSH command');
    console.log('stage: verify SSH audit events and closed session');
    const { session, auditEvents } = await verifyTransport(transport);
    // Docker may accept on the published host port even after the transport
    // closes. Probe the actual listener in its own network namespace.
    assert.equal(await run('docker', ['exec', platformContainer, 'node', '-e',
      `const socket = require('node:net').createConnection(${JSON.stringify(endpoint)});
      socket.once('error', error => console.log(error.code));
      socket.once('connect', () => { socket.destroy(); console.log('connected'); });`], { stage: 'verify SSH transport listener closed', timeout: 10000 }), 'ECONNREFUSED');
    sshProof = { transportId, endpoint, cabinetPrincipal, session, auditEvents };
  }
  assert.equal((await verifyAuditChain(observer)).ok, true);
  enrollmentVerified = true;
  if (!offNetwork) console.log(JSON.stringify({ database: db.name, cabinetId, enrollmentVerified: true }));
  if (sshAvailable) await stopAgent(true);
  if (interrupted) throw interrupted;
} catch (error) {
  reportPrimaryFailure(error);
} finally {
  const cleanupErrors = [];
  async function cleanup(action) {
    try { await action(); } catch (error) { cleanupErrors.push(error); }
  }
  if (fallbackRegistered) {
    // Keep the API alive while recovery is pending. Do not remove the safety net
    // before it has restored connectivity on a failed off-network run.
    if (!sshAvailable) {
      console.error('Waiting for scheduled fallback before SSH cleanup after off-network acceptance');
      while (Date.now() < fallbackRunsAt) await new Promise(r => setTimeout(r, Math.min(1000, fallbackRunsAt - Date.now())));
    }
    while (true) {
      try {
        await ps(`
          if ((Get-Service Tailscale).Status -ne 'Running') { Start-Service Tailscale }
          (Get-Service Tailscale).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
          if (((& ${quote(tailscale)} status --json | ConvertFrom-Json).BackendState) -ne 'Running') { throw 'Tailscale node is not running' }
          function Read-FallbackTask {
            Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq ${quote(taskName)} -and $_.TaskPath -eq '\\' }
          }
          $task = Read-FallbackTask
          if ($task) { $task | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue }
          $hold = 'C:\\tailscale-watchdog.hold'
          if (Test-Path -LiteralPath $hold) { Remove-Item -LiteralPath $hold -Force -ErrorAction SilentlyContinue }
          $fallbackTask = @(Read-FallbackTask).Count
          $holdExists = Test-Path -LiteralPath $hold
          if ($fallbackTask -ne 0 -or $holdExists) { throw "Fallback cleanup incomplete (fallbackTask=$fallbackTask, hold=$holdExists)" }
        `, { stage: 'verify fallback cleanup', timeout: 12000 });
        sshAvailable = true; fallbackRegistered = false; break;
      } catch (error) {
        if (Date.now() >= fallbackDeadline) { cleanupErrors.push(new Error('Fallback cleanup failed', { cause: error })); break; }
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  if (offNetwork && enrollmentVerified && sshAvailable && !primaryFailed) {
    try {
      const state = await ps(`[IO.File]::ReadAllText(${quote(tailnetEvidencePath)})`, { stage: 'read pre-recovery Tailscale state', timeout: 12000 });
      assert.equal(state, 'Stopped', 'Cabinet file must record Tailscale stopped before recovery');
      assert.ok(sshProof, 'SSH transport must complete before recovery');
      const localEvidence = join(work, evidenceFile);
      await run('scp', [...sshConfig, `${cabinetHost}:${remote.replaceAll('\\', '/')}/${evidenceFile}`, localEvidence], { stage: 'download SSH transport evidence', timeout: 12_000 });
      const evidence = JSON.parse(readFileSync(localEvidence, 'utf8'));
      assert.equal(evidence.result, runId);
      assert.equal(evidence.agentPid, agentProcess);
      assert.equal(evidence.principal.toLowerCase(), sshProof.cabinetPrincipal);
      assert.equal(evidence.tailnetState, 'Stopped');
      assert.ok(evidence.connections.every(c => c.State !== 'Listen'), 'The acceptance agent must have no listener');
      assert.ok(evidence.connections.some(c => c.State === 'Established' && c.RemoteAddress === '127.0.0.1' && c.RemotePort === 22),
        'The agent must dial the cabinet loopback SSH server');
      assert.ok(evidence.connections.some(c => c.State === 'Established' && [platformHost, '::ffff:' + platformHost].includes(c.RemoteAddress) && c.RemotePort === platformPort),
        'The agent must dial the public mTLS platform port');

      console.log(JSON.stringify({ database: db.name, cabinetId, enrollmentVerified: true, platformHost,
        platformPort, peerAddress, tailnetDownAt, tailnetStateBeforeRecovery: state,
        sshTransport: { transportId: sshProof.transportId, endpoint: sshProof.endpoint,
          session: sshProof.session, auditEvents: sshProof.auditEvents, evidence } }));
    } catch (error) {
      reportPrimaryFailure(error);
    }
  }
  if (agentProcess && remote && sshAvailable) {
    await cleanup(() => ps(`New-Item -ItemType File -Path ${quote(remote + '\\delete-key')} -Force | Out-Null; New-Item -ItemType File -Path ${quote(remote + '\\stop')} -Force | Out-Null`, { stage: 'request cabinet agent cleanup' }));
  }
  await cleanup(() => api?.close());
  if (platformContainerCreated) {
    try { console.error(await run('docker', ['logs', platformContainer])); } catch { /* creation may have failed */ }
    await cleanup(() => run('docker', ['rm', '-f', platformContainer]));
  }
  if (containerStopped) await cleanup(() => run('docker', ['start', 'cabinet-server-1']));
  await cleanup(() => notifier?.stop());
  await cleanup(() => feed?.stop());
  // Keep the database enrollment and audit records for review.
  await cleanup(() => observer?.end());
  await cleanup(() => db?.app.end());
  await cleanup(() => rmSync(work, { recursive: true, force: true }));
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  if (interrupted && !primaryFailed) reportPrimaryFailure(interrupted);
  if (!primaryFailed) {
    console.log(offNetwork && !sshAvailable
      ? 'Acceptance transport checks passed. Evidence readback requires cabinet recovery.'
      : 'Acceptance checks passed.');
  }
  if (cleanupErrors.length) {
    process.exitCode = 1;
    for (const error of cleanupErrors) console.error('Acceptance cleanup failed:', error);
  } else {
    console.log('Acceptance cleanup passed.');
  }
  if (db) console.log(`Acceptance records retained in ${db.name}${offNetwork ? '' : '; off-network acceptance still needs a public platform endpoint'}.`);
}
