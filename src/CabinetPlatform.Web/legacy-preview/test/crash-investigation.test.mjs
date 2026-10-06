import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewServer } from "../server.mjs";

const cabinet = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const werAction = "66666666-6666-4666-8666-666666666666";
const wer = {
  cabinetId: cabinet, actionId: werAction, state: "complete", requestedAtUtc: "2026-09-01T00:00:00Z",
  completedAtUtc: "2026-09-01T00:02:00Z", metadata: {
    version: 1, observedUtc: "2026-09-01T00:01:30Z",
    stores: [{ store: "MachineQueue", status: "Partial", truncated: true }, { store: "MachineArchive", status: "Denied", truncated: false }],
    reports: [{ reportId: "77777777-7777-4777-8777-777777777777", createdUtc: "2026-09-01T00:01:00Z", eventType: "APPCRASH", store: "MachineQueue" }],
  },
};
const processAction = "88888888-8888-4888-8888-888888888888";
const processEvidence = {
  cabinetId: cabinet, actionId: processAction, state: "complete", requestedAtUtc: "2026-09-01T00:00:00Z",
  completedAtUtc: "2026-09-01T00:02:00Z", evidence: {
    version: 1, observedUtc: "2026-09-01T00:01:30Z", windowStartUtc: "2026-08-31T00:01:30Z",
    status: "Partial", auditCoverageVerified: false, truncated: true,
    events: [{ occurredUtc: "2026-09-01T00:01:00Z", kind: "Start", processId: 421, recordId: 21 },
      { occurredUtc: "2026-09-01T00:01:20Z", kind: "Exit", processId: 421, recordId: null }],
  },
};
const result = {
  cabinetId: cabinet, actionId: "33333333-3333-4333-8333-333333333333", viewId: "44444444-4444-4444-8444-444444444444",
  state: "complete", viewDisplayName: "Application evidence", requestedAtUtc: "2026-09-01T00:00:00Z",
  completedAtUtc: "2026-09-01T00:02:00Z", requestedChannels: ["Application", "System"],
  requestedProviders: [], truncated: false,
  channelReads: [
    { channelName: "Application", outcome: "readable", recordsRead: 2, truncated: false },
    { channelName: "System", outcome: "readable", recordsRead: 1, truncated: false },
  ],
  entries: [
    { channel: "Application", provider: "Application Error", level: "error", eventId: 1000, occurredAt: "2026-09-01T00:01:00Z", message: "Patient <script>alert(1)</script>" },
    { channel: "Application", provider: "Windows Error Reporting", level: "information", eventId: 1001, occurredAt: "2026-09-01T00:01:10Z", message: "private path" },
    { channel: "System", provider: "Application Error", level: "error", eventId: 1000, occurredAt: "2026-09-01T00:01:11Z", message: "Unrelated" },
  ],
};
async function fixture(data = result, status = 200, werData = null, werStatus = werData ? 200 : 404, processData = null, processStatus = processData ? 200 : 404) {
  let active = true;
  let latest = data;
  const calls = [];
  const upstreamFetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path === "/api/auth/login") return Response.json({ accessToken: "server-only-token", expiresAtUtc: new Date(Date.now() + 60000).toISOString() });
    if (path === "/api/auth/me") return active ? Response.json({ displayName: "Test rep", role: "Tier2", isActive: true }) : new Response("", { status: 401 });
    if (path === `/api/cabinets/${cabinet}/event-log-results/latest`) return status === 200 ? Response.json(latest) : new Response("", { status });
    if (path === `/api/cabinets/${cabinet}/event-log-results/${data.actionId}`) return Response.json(data);
    if (path === `/api/cabinets/${cabinet}/wer-metadata/latest` || path === `/api/cabinets/${cabinet}/wer-metadata/${werAction}`)
      return werStatus === 200 ? Response.json(werData) : new Response("private upstream error", { status: werStatus });
    if (path === `/api/cabinets/${cabinet}/historical-process-evidence/latest` || path === `/api/cabinets/${cabinet}/historical-process-evidence/${processAction}`)
      return processStatus === 200 ? Response.json(processData) : new Response("private process error", { status: processStatus });
    return new Response("", { status: 404 });
  };
  const server = createPreviewServer("127.0.0.1", { enabled: true, upstreamUrl: "https://127.0.0.1:8443/", upstreamFetch });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, cookie) => fetch(`${origin}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const login = await fetch(`${origin}/signin`, { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: "username=synthetic&password=synthetic" });
  assert.equal(login.status, 303);
  return { request, cookie: login.headers.get("set-cookie"), calls, newer: value => { latest = value; }, revoke: () => { active = false; }, close: () => new Promise(resolve => server.close(resolve)) };
}

test("crash clues link exact saved Application records without leaking messages or claiming cause", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes`)).status, 303);
    const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Application Error/);
    assert.match(html, /Windows Error Reporting event/);
    assert.match(html, /cause unknown/i);
    assert.match(html, /WER metadata not collected/);
    assert.match(html, /Historical process evidence unavailable/);
    assert.match(html, new RegExp(`/cabinet/${cabinet}/events/${result.actionId}\\?entry=0`));
    assert.match(html, new RegExp(`/cabinet/${cabinet}/events/${result.actionId}\\?entry=1`));
    assert.doesNotMatch(html, /events\\?entry=2|Patient|private path|Unrelated|server-only-token|<script>/);
    assert.equal(f.calls.find(c => c.path.endsWith("/latest")).options.headers.Authorization, "Bearer server-only-token");
    assert.equal((await f.request(`/cabinet/${other}/crashes`, f.cookie)).status, 404);
    f.revoke();
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes`, f.cookie)).status, 303);
  } finally { await f.close(); }
});

test("a newer collection cannot change the exact event opened from a crash clue", async () => {
  const f = await fixture();
  try {
    const list = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
    assert.equal(list.status, 200);
    assert.match(await list.text(), new RegExp(`/cabinet/${cabinet}/events/${result.actionId}\\?entry=0`));
    const newer = { ...result, actionId: "55555555-5555-4555-8555-555555555555", entries: [{ ...result.entries[0], provider: "Different later event", eventId: 7, message: "Different message" }] };
    f.newer(newer);
    const pinned = await f.request(`/cabinet/${cabinet}/events/${result.actionId}?entry=0`, f.cookie);
    assert.equal(pinned.status, 200);
    const html = await pinned.text();
    assert.match(html, /Application Error · 1000/);
    assert.doesNotMatch(html, /Different later event|Different message/);
    const call = f.calls.find(c => c.path === `/api/cabinets/${cabinet}/event-log-results/${result.actionId}`);
    assert.equal(call.options.headers.Authorization, "Bearer server-only-token");
    assert.equal((await f.request(`/cabinet/${cabinet}/events/${newer.actionId}?entry=0`, f.cookie)).status, 404);
  } finally { await f.close(); }
});

test("unknown coverage does not become a clean bill of health", async () => {
  for (const data of [
    { ...result, state: "pending", entries: [], channelReads: [], completedAtUtc: null },
    { ...result, state: "failed", entries: [], channelReads: [] },
    { ...result, requestedChannels: ["System"], channelReads: [result.channelReads[1]], entries: [result.entries[2]] },
    { ...result, channelReads: [{ ...result.channelReads[0], outcome: "accessDenied", recordsRead: 0 }, result.channelReads[1]], entries: [result.entries[2]], state: "partial" },
  ]) {
    const f = await fixture(data);
    try {
      const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /coverage unavailable|pending|failed|accessDenied/i);
    } finally { await f.close(); }
  }
});

test("WER is separately dated machine-store evidence without joining event clues", async () => {
  const f = await fixture(result, 200, wer);
  try {
    const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Machine queue.*partial/i);
    assert.match(html, /Machine archive.*denied/i);
    assert.match(html, /truncated/i);
    assert.match(html, /Report created.*2026-09-01T00:01:00Z/i);
    assert.match(html, /APPCRASH/);
    assert.match(html, new RegExp(`/cabinet/${cabinet}/crashes/${werAction}`));
    assert.match(html, /cause unknown/i);
    assert.match(html, new RegExp(`/cabinet/${cabinet}/events/${result.actionId}\\?entry=0`));
    assert.doesNotMatch(html, /77777777|private upstream error|same crash|crash occurred at/i);
    assert.equal(f.calls.find(c => c.path.endsWith("wer-metadata/latest")).options.headers.Authorization, "Bearer server-only-token");
  } finally { await f.close(); }
});

test("WER absence and upstream failure do not hide event evidence", async () => {
  for (const status of [404, 500]) {
    const f = await fixture(result, 200, null, status);
    try {
      const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Application Error event/);
      assert.match(html, status === 404 ? /WER.*not collected/i : /WER.*unavailable/i);
      assert.doesNotMatch(html, /private upstream error/);
    } finally { await f.close(); }
  }
});

test("malformed WER is unsafe rather than rendered or silently treated as absent", async () => {
  for (const bad of [
    { ...wer, cabinetId: other }, { ...wer, metadata: { ...wer.metadata, reports: [{ ...wer.metadata.reports[0], eventType: "<script>secret</script>" }] } },
    { ...wer, metadata: { ...wer.metadata, stores: [{ ...wer.metadata.stores[0], status: 2 }, wer.metadata.stores[1]] } },
    { ...wer, metadata: { ...wer.metadata, reports: Array(41).fill(wer.metadata.reports[0]) } },
    { ...wer, rawOutput: "sensitive path" },
  ]) {
    const f = await fixture(result, 200, bad);
    try {
      const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /WER.*unsafe/i);
      assert.match(html, /Application Error event/);
      assert.doesNotMatch(html, /sensitive path|<script>secret/);
    } finally { await f.close(); }
  }
});

test("pinned WER route refuses substituted identity and query parameters", async () => {
  const f = await fixture(result, 200, wer);
  try {
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes?entry=0`, f.cookie)).status, 400);
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes/${werAction}?entry=0`, f.cookie)).status, 400);
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes/not-a-guid`, f.cookie)).status, 404);
    const pinned = await f.request(`/cabinet/${cabinet}/crashes/${werAction}`, f.cookie);
    assert.equal(pinned.status, 200);
    assert.match(await pinned.text(), /APPCRASH/);
    assert.ok(f.calls.some(c => c.path === `/api/cabinets/${cabinet}/wer-metadata/${werAction}`));
  } finally { await f.close(); }
  const swapped = await fixture(result, 200, { ...wer, actionId: result.actionId });
  try {
    const response = await swapped.request(`/cabinet/${cabinet}/crashes/${werAction}`, swapped.cookie);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /WER.*unsafe/i);
  } finally { await swapped.close(); }
});

test("WER pending, failed, and store-unavailable states retain unknown coverage", async () => {
  for (const value of [
    { ...wer, state: "pending", completedAtUtc: null, metadata: null },
    { ...wer, state: "failed", metadata: null },
    { ...wer, metadata: { ...wer.metadata, stores: [{ store: "MachineQueue", status: "Read", truncated: false }, { store: "MachineArchive", status: "Unavailable", truncated: false }] } },
  ]) {
    const f = await fixture(result, 200, value);
    try {
      const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /WER.*(?:pending|failed|unavailable)|Machine archive: unavailable/i);
      assert.match(html, /coverage unknown|leave gaps/i);
    } finally { await f.close(); }
  }
});

test("pinned WER result removed upstream is not replaced with latest", async () => {
  const f = await fixture(result, 200, null, 404);
  try {
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes/${werAction}`, f.cookie)).status, 404);
  } finally { await f.close(); }
});

test("WER read does not depend on an existing saved Event Viewer action", async () => {
  const f = await fixture(result, 404, wer);
  try {
    const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /APPCRASH/);
    assert.match(html, /Event Viewer.*not collected/i);
  } finally { await f.close(); }
});

test("WER gateway rejects implausible observation time and oversized response", async () => {
  for (const bad of [
    { ...wer, metadata: { ...wer.metadata, observedUtc: "2030-09-01T00:01:30Z" } },
    { ...wer, metadata: { ...wer.metadata, observedUtc: "2026-08-01T00:01:30Z", reports: [] } },
    { ...wer, padding: "x".repeat(13000) },
  ]) {
    const f = await fixture(result, 200, bad);
    try {
      const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /WER.*unsafe/i);
    } finally { await f.close(); }
  }
});

test("valid native report GUID shapes are accepted without displaying their identifiers", async () => {
  const reportId = "77777777-7777-0777-0777-777777777777";
  const data = { ...wer, metadata: { ...wer.metadata, reports: [{ ...wer.metadata.reports[0], reportId }] } };
  const f = await fixture(result, 200, data);
  try {
    const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /APPCRASH/);
    assert.doesNotMatch(html, /77777777/);
  } finally { await f.close(); }
});

test("historical starts and exits are separate bounded clues with pinned action and unknown continuity", async () => {
  const f = await fixture(result, 200, wer, 200, processEvidence);
  try {
    const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Historical process lifecycle/);
    assert.match(body, /Start.*PID 421.*2026-09-01T00:01:00Z/);
    assert.match(body, /Exit.*PID 421.*2026-09-01T00:01:20Z/);
    assert.match(body, /truncated.*partial|partial.*truncated/i);
    assert.match(body, /audit continuity.*unknown/i);
    assert.match(body, /presence at crash.*unknown/i);
    assert.match(body, new RegExp(`/cabinet/${cabinet}/crashes/process/${processAction}`));
    assert.match(body, /APPCRASH|Application Error event/);
    assert.doesNotMatch(body, /private path|Patient|server-only-token|caused the crash/i);
    const pinned = await f.request(`/cabinet/${cabinet}/crashes/process/${processAction}`, f.cookie);
    assert.equal(pinned.status, 200);
    assert.match(await pinned.text(), /PID 421/);
    assert.ok(f.calls.some(c => c.path === `/api/cabinets/${cabinet}/historical-process-evidence/${processAction}`));
    assert.equal(f.calls.find(c => c.path.endsWith("historical-process-evidence/latest")).options.headers.Authorization, "Bearer server-only-token");
  } finally { await f.close(); }
});

test("process absence denial and invalid upstream do not hide Event Viewer or WER", async () => {
  for (const [status, expected] of [[404, /not collected/i], [403, /access denied/i], [502, /unsafe|unavailable/i], [401, /Session expired|Sign in/i]]) {
    const f = await fixture(result, 200, wer, 200, null, status);
    try {
      const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
      if (status === 401) { assert.equal(response.status, 303); continue; }
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, expected);
      assert.match(body, /Application Error event/);
      assert.match(body, /APPCRASH/);
      assert.doesNotMatch(body, /private process error/);
    } finally { await f.close(); }
  }
});

test("zero-row Read does not certify auditing or no processes", async () => {
  const empty = { ...processEvidence, evidence: { ...processEvidence.evidence, status: "Read", truncated: false, events: [] } };
  const f = await fixture(result, 404, wer, 200, empty);
  try {
    const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Event Viewer result not collected/);
    assert.match(body, /APPCRASH/);
    assert.match(body, /audit continuity.*unknown/i);
    assert.match(body, /No recorded starts or exits.*does not establish/i);
  } finally { await f.close(); }
});

test("process schema, timestamps, counts and identity fail closed without losing other clues", async () => {
  const evidence = processEvidence.evidence;
  const row = evidence.events[0];
  for (const bad of [
    { ...processEvidence, cabinetId: other },
    { ...processEvidence, rawOutput: "<script>secret</script>" },
    { ...processEvidence, evidence: { ...evidence, commandLine: "private path" } },
    { ...processEvidence, evidence: { ...evidence, auditCoverageVerified: true } },
    { ...processEvidence, evidence: { ...evidence, version: 2 } },
    { ...processEvidence, evidence: { ...evidence, status: "Read", truncated: true } },
    { ...processEvidence, evidence: { ...evidence, status: "Denied", events: [row], truncated: false } },
    { ...processEvidence, evidence: { ...evidence, events: Array(65).fill(row) } },
    { ...processEvidence, evidence: { ...evidence, events: [{ ...row, processId: 0 }] } },
    { ...processEvidence, evidence: { ...evidence, events: [{ ...row, processId: 4294967296 }] } },
    { ...processEvidence, evidence: { ...evidence, events: [{ ...row, kind: "<script>secret</script>" }] } },
    { ...processEvidence, evidence: { ...evidence, events: [{ ...row, recordId: -1 }] } },
    { ...processEvidence, evidence: { ...evidence, events: [row, { ...row }] } },
    { ...processEvidence, evidence: { ...evidence, windowStartUtc: "2026-08-30T00:01:30Z" } },
    { ...processEvidence, evidence: { ...evidence, observedUtc: "2030-09-01T00:01:30Z" } },
    { ...processEvidence, evidence: { ...evidence, events: [{ ...row, occurredUtc: "2026-08-29T00:00:00Z" }] } },
    { ...processEvidence, evidence: { ...evidence, windowStartUtc: "2026-08-31T00:01:30.0000001Z" } },
    { ...processEvidence, evidence: { ...evidence, events: [{ ...row, occurredUtc: "2026-09-01T00:01:30.0000001Z" }] } },
    { ...processEvidence, requestedAtUtc: "2026-09-01T00:02:00.0000001Z" },
    { ...processEvidence, state: "pending" },
    { ...processEvidence, padding: "x".repeat(21000) },
  ]) {
    const f = await fixture(result, 200, wer, 200, bad);
    try {
      const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /Historical process.*unsafe/i);
      assert.match(body, /Application Error event/);
      assert.match(body, /APPCRASH/);
      assert.doesNotMatch(body, /private path|<script>secret|PID 421/);
    } finally { await f.close(); }
  }
});

test("pinned process query, substituted identity and missing saved action are refused", async () => {
  const f = await fixture(result, 200, wer, 200, processEvidence);
  try {
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes/process/not-a-guid`, f.cookie)).status, 404);
    assert.equal((await f.request(`/cabinet/${cabinet}/crashes/process/${processAction}?entry=0`, f.cookie)).status, 400);
    assert.equal((await f.request(`/cabinet/${other}/crashes/process/${processAction}`, f.cookie)).status, 404);
  } finally { await f.close(); }
  const missing = await fixture(result, 200, wer, 200, null, 404);
  try { assert.equal((await missing.request(`/cabinet/${cabinet}/crashes/process/${processAction}`, missing.cookie)).status, 404); }
  finally { await missing.close(); }
  const swapped = await fixture(result, 200, wer, 200, { ...processEvidence, actionId: other });
  try { assert.equal((await swapped.request(`/cabinet/${cabinet}/crashes/process/${processAction}`, swapped.cookie)).status, 200);
    assert.match(await (await swapped.request(`/cabinet/${cabinet}/crashes/process/${processAction}`, swapped.cookie)).text(), /Historical process.*unsafe/i); }
  finally { await swapped.close(); }
});

test("process only and pending, failed, denied, unavailable statuses keep coverage unknown", async () => {
  for (const value of [
    { ...processEvidence, state: "pending", completedAtUtc: null, evidence: null },
    { ...processEvidence, state: "failed", evidence: null },
    { ...processEvidence, evidence: { ...processEvidence.evidence, status: "Denied", truncated: false, events: [] } },
    { ...processEvidence, evidence: { ...processEvidence.evidence, status: "Unavailable", truncated: false, events: [] } },
  ]) {
    const f = await fixture(result, 404, null, 404, value);
    try {
      const response = await f.request(`/cabinet/${cabinet}/crashes`, f.cookie);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /Event Viewer result not collected/);
      assert.match(body, /audit continuity.*unknown/i);
      assert.match(body, /pending|failed|denied|unavailable/i);
    } finally { await f.close(); }
  }
});

test("cross cabinet evidence and upstream denials fail closed", async () => {
  for (const [data, status, expected] of [[result, 403, 403], [result, 401, 303], [result, 404, 404], [{ ...result, cabinetId: other }, 200, 502], [{ ...result, entries: [{ ...result.entries[0], channel: "Other" }] }, 200, 502]]) {
    const f = await fixture(data, status);
    try { assert.equal((await f.request(`/cabinet/${cabinet}/crashes`, f.cookie)).status, expected); }
    finally { await f.close(); }
  }
});
