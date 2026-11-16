import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the actual harness wait and diagnostics without SSH, SQL or a cabinet.
const source = readFileSync(new URL('./session-shell-cabinet.mjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('const shedReasons ='), source.indexOf('async function upload('));
function harness({ running = true, expire = false } = {}) {
  const output = [];
  const calls = [];
  let now = 0;
  const { until, startAgent } = runInNewContext(functions.replaceAll('import.meta', 'importMeta') + '\nadmissionDiagnostics = () => ({ overloaded: false, reason: "below_all_load_thresholds", waitMs: 1234, pending: 2, lagSeconds: 0 });\nshedReasons.set("database_acquire_wait", 2);\n({ until, startAgent })', {
    observer: null,
    db: { app: { waitMs: 1234, pending: 2 } },
    opsMeter: { drain: () => ({ counts: new Map([['shed|agent:503', 2], ['error_class|agent:TimeoutError', 1]]) }), restore: () => {} },
    splitKey: key => key.split('|'),
    remote: 'C:\\Acceptance State', work: '/tmp/test', agentProcess: 123, quote: s => `'${s}'`, Buffer,
    URL, importMeta: { url: new URL('./session-shell-cabinet.mjs', import.meta.url).href },
    join: (...parts) => parts.join('/'),
    writeFileSync: (path, data) => calls.push('write ' + path + ' ' + data),
    upload: (path, target) => calls.push('upload ' + path + ' ' + target),
    run: (binary, args) => calls.push([binary, ...args].join(' ')),
    sshConfig: [], cabinetHost: 'deviceb',
    Number,
    Date: { now: () => { const value = now; if (expire) now += 120001; return value; } },
    setTimeout: callback => callback(),
    console: { error: (...args) => output.push(args.join(' ')) },
    ps: command => { calls.push(command); if (command.includes('Get-Process')) return JSON.stringify({ pid: 123, state: running ? 'running' : 'exited', exitCode: running ? null : 23 });
      if (command.includes("Get-Content -LiteralPath $f") && command.includes('agent.pid')) return '123';
      return 'agent failure details'; },
  });
  return { until, startAgent, output, calls };
}
test('timeout prints server admission state, shed counts and all three agent files before rejecting', async () => {
  const h = harness({ expire: true });
  await assert.rejects(h.until(() => false, 'cabinet enrollment'), /Timed out: cabinet enrollment/);
  assert.match(h.output.join('\n'), /agent failure details/);
  assert.match(h.output.join('\n'), /database_acquire_wait/);
  assert.match(h.output.join('\n'), /agent:503/);
  assert.match(h.output.join('\n'), /agent:TimeoutError/);
  assert.match(h.output.join('\n'), /server diagnostics/);
  assert.match(h.output.join('\n'), /below_all_load_thresholds/);
  assert.match(h.output.join('\n'), /"pool":{"waitMs":1234,"pending":2}/);
  for (const file of ['agent.log', 'run.out', 'run.err']) assert.ok(h.calls.some(c => c.includes(file)));
});
test('unexpected exit fails before polling the database and prints output', async () => {
  const h = harness({ running: false });
  let reads = 0;
  await assert.rejects(h.until(() => { reads++; return false; }, 'first heartbeat'), /process 123 exited during: first heartbeat; exit code: 23; process state:/);
  assert.equal(reads, 0);
  assert.match(h.output.join('\n'), /agent failure details/);
  assert.match(h.output.join('\n'), /database_acquire_wait/);
  assert.match(h.output.join('\n'), /agent:503/);
  assert.match(h.output.join('\n'), /agent:TimeoutError/);
});
test('successful waits return the result', async () => {
  const h = harness();
  assert.equal(await h.until(() => 'enrolled', 'enrollment'), 'enrolled');
  assert.equal(h.output.length, 0);
});
test('shutdown permits the expected process exit', async () => {
  const h = harness({ running: false });
  assert.equal(await h.until(() => 'stopped', 'shutdown', { expectExit: true }), 'stopped');
  assert.equal(h.output.length, 0);
});

test('startup uses WMI and checks survival through a separate SSH call', async () => {
  const h = harness();
  await h.startAgent('https://platform:18443');
  const launch = h.calls.findIndex(c => c.startsWith('ssh '));
  const probe = h.calls.findIndex(c => c.includes('Get-Process'));
  assert.ok(launch >= 0 && probe > launch);
  assert.match(h.calls[launch], /-ExecutionPolicy Bypass -File "C:\\Acceptance State\\shell-agent-launch.ps1"/);
  assert.ok(h.calls[launch].length < 1000);
  assert.ok(!h.calls[launch].includes('-EncodedCommand'));
  assert.ok(h.calls.slice(0, launch).some(c => c.startsWith('upload ') && c.includes('shell-agent-launch.ps1')));
  assert.ok(h.calls.slice(0, launch).some(c => c.startsWith('upload ') && c.includes('shell-agent-launch.json')));
  assert.ok(h.calls.some(c => c.startsWith('write ') && c.includes('https://platform:18443')));
  const supervisor = readFileSync(new URL('./shell-agent-launch.ps1', import.meta.url), 'utf8');
  assert.match(supervisor, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(supervisor, /\$handle = \$p.Handle/);
  assert.match(supervisor, /\$p.WaitForExit\(\)/);
  assert.match(supervisor, /exitCode = \$p.ExitCode/);
  for (const file of ['run.out', 'run.err']) assert.ok(supervisor.includes(file));
});
test('startup fails immediately with exit code and output when agent dies', async () => {
  const h = harness({ running: false });
  await assert.rejects(h.startAgent('https://platform:18443'), /detached startup.*exit code: 23/);
  assert.match(h.output.join('\n'), /agent failure details/);
  assert.match(h.output.join('\n'), /database_acquire_wait/);
  assert.match(h.output.join('\n'), /agent:503/);
  assert.match(h.output.join('\n'), /agent:TimeoutError/);
});

test('SSH failure includes every command argument', async () => {
  const runSource = source.slice(source.indexOf('async function run('), source.indexOf('const quote'));
  const { run } = runInNewContext(runSource + '\n({ run })', {
    execFileAsync: async () => { throw Object.assign(new Error('The command line is too long.'), { code: 1 }); },
  });
  await assert.rejects(() => run('ssh', ['deviceb', 'powershell.exe', '-File', 'C:\\Acceptance State\\launch.ps1']), error => {
    assert.match(error.message, /The command line is too long/);
    assert.ok(error.message.includes('Command: ' + ['ssh', 'deviceb', 'powershell.exe', '-File', 'C:\\Acceptance State\\launch.ps1'].map(a => JSON.stringify(a)).join(' ')));
    return true;
  });
});

test('database polling errors print server and agent diagnostics', async () => {
  const h = harness();
  await assert.rejects(h.until(() => { throw new Error('SQL unavailable'); }, 'first heartbeat'), /SQL unavailable/);
  assert.match(h.output.join('\n'), /server diagnostics/);
  assert.match(h.output.join('\n'), /agent failure details/);
});

test('server shed observer reports the gate while preserving command poll pacing', () => {
  const server = readFileSync(new URL('../../server/src/agent-api/server.ts', import.meta.url), 'utf8');
  const start = server.indexOf('    o.onAdmissionShed?.(opts.reason);');
  const end = server.indexOf('\n  };', start);
  const reasons = [];
  const shed = new Function('o', 'closeAfter', 'serverTime', 'request', 'reply', 'opts', server.slice(start, end));
  for (const [url, expected] of [['/agent/v1/enroll/id', 503], ['/agent/v1/commands', 200]]) {
    let status, body;
    const reply = { code: value => { status = value; return reply; }, header: () => reply, send: value => { body = value; return reply; } };
    shed({ onAdmissionShed: reason => reasons.push(reason) }, () => {}, () => 'now', { method: 'GET', url }, reply,
      { reason: 'database_acquire_wait', seconds: 30 });
    assert.equal(status, expected);
    if (expected === 200) assert.equal(body.reconnectAfterMs, 30000);
    else assert.equal(body.error, 'busy');
  }
  assert.deepEqual(reasons, ['database_acquire_wait', 'database_acquire_wait']);
});

test('child process waits leave the API event loop free', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runSource = source.slice(source.indexOf('async function run('), source.indexOf('const quote'));
  const { run } = runInNewContext(runSource + '\n({ run })', { execFileAsync: promisify(execFile) });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    await run(process.execPath, ['-e', 'setTimeout(() => {}, 150)']);
    assert.ok(ticks >= 3, `server timers stalled: ${ticks} ticks`);
  } finally { clearInterval(timer); }
});

test('admission snapshot reports the actual overload inputs and false reason', () => {
  const server = readFileSync(new URL('../../server/src/agent-api/server.ts', import.meta.url), 'utf8');
  const gate = server.slice(server.indexOf('  const loadReason ='), server.indexOf('  const connectionTokens =')).replaceAll(': string =>', ' =>').replaceAll(': boolean =>', ' =>');
  for (const [waitMs, pending, lagSeconds, expected] of [[0, 0, 0, 'below_all_load_thresholds'], [1001, 0, 0, 'database_acquire_wait'], [0, 101, 0, 'database_pending_acquires'], [0, 0, 3, 'event_loop_lag']]) {
    let read;
    new Function('o', 'admission', 'lagSeconds', 'lag', gate)({ pool: { waitMs, pending }, onAdmissionDiagnostics: callback => { read = callback; } },
      { maxAcquireWaitMs: 1000, maxPendingAcquires: 20, maxEventLoopLagMs: 250 }, lagSeconds, { percentile: () => 20e6 });
    const state = read();
    assert.equal(state.reason, expected);
    assert.equal(state.overloaded, expected !== 'below_all_load_thresholds');
    assert.equal(state.waitMs, waitMs);
    assert.equal(state.pending, pending);
    assert.equal(state.lagSeconds, lagSeconds);
  }
});
