// Node 22+. Run with --out <path-prefix> to create <prefix>.log and <prefix>.json.
// Supply CABINET_PLATFORM_URL, CABINET_ADMIN_USER, CABINET_ADMIN_PASSWORD and CABINET_CABINET_ID.
// Admin sign-in and write confirmations also require CABINET_ADMIN_TOTP_SECRET (base32).
// Use disposable targets for writes. Set CABINET_SWEEP_SERVICE, CABINET_SWEEP_SERVICE_ACTION
// (start, stop or restart), CABINET_SWEEP_START_TYPE (automatic, automatic_delayed, manual or disabled),
// CABINET_SWEEP_PROCESS_ID and CABINET_SWEEP_PROCESS_NAME. The writes can change the live cabinet.
// CABINET_SWEEP_DATABASE_PORT defaults to the standard SQL Server port (1433).
import { createHash, createHmac } from "node:crypto";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const env = process.env;
const checks = [
  "services.list", "processes.list", "eventlog.get", "drivers.list", "storage.volumes",
  "storage.physicalDisks", "network.adapters", "hardware.summary", "database.connectivity",
  "service.control", "service.setStartType", "process.end", "firewall.status", "updates.status", "boot.config",
];
const writes = new Set(["service.control", "service.setStartType", "process.end"]);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function setting(name) {
  if (!env[name]) throw new Error(`Set ${name}`);
  return env[name];
}

function integer(value, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`Set a valid ${name}`);
  return number;
}

function choice(name, allowed) {
  const value = setting(name);
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return value;
}

function authenticator() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const encoded = setting("CABINET_ADMIN_TOTP_SECRET").toUpperCase().replace(/\s/g, "").replace(/=+$/, "");
  if (!/^[A-Z2-7]+$/.test(encoded) || encoded.length < 16) throw new Error("Invalid base32 authenticator secret");
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of encoded) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  let lastStep = -1;
  return async () => {
    const stepMs = 30_000;
    if (Date.now() < (lastStep + 1) * stepMs) await delay((lastStep + 1) * stepMs - Date.now());
    lastStep = Math.floor(Date.now() / stepMs);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(lastStep));
    const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
    const offset = mac[mac.length - 1] & 15;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
  };
}

class ApiFailure extends Error {
  constructor(status, body) {
    // Keep arbitrary response bodies and cabinet data out of the log.
    const code = body?.error;
    super(`HTTP ${status}${typeof code === "string" && /^[a-z_]+$/.test(code) ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code;
    this.reason = body?.reason ?? body?.message;
  }
}

function consoleApi() {
  let origin;
  try {
    const url = new URL(setting("CABINET_PLATFORM_URL"));
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch {
    throw new Error("Set CABINET_PLATFORM_URL to the console's HTTPS origin");
  }
  const cookies = new Map();
  return async (path, body) => {
    const response = await fetch(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        cookie: [...cookies.values()].join("; "),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => { throw new Error("Console API request failed or timed out"); });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0];
      cookies.set(pair.split("=", 1)[0], pair);
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new ApiFailure(response.status, result);
    if (!result) throw new Error("Console API returned no JSON");
    return result;
  };
}

function verifyRefusal(operation, code, message, readOnly, params) {
  if (operation === "boot.config" && code === "unknown_operation") return "unknown operation was refused";
  if (!writes.has(operation)) return;
  if (readOnly && ["read_only_cabinet", "read_only_mode"].includes(code)
      && ["this cabinet was installed read-only", "This cabinet's agent is installed in read-only mode."].includes(message)) {
    return "refusal named the cabinet's read-only mode";
  }
  const listCode = operation === "process.end" ? "control_process_not_approved" : "control_entry_not_approved";
  if (code === listCode && typeof message === "string") {
    const target = operation === "process.end" ? "the program the cabinet reports under that process ID" : "that service";
    const list = "(?:cabinet|site|client|fleet)";
    const damaged = `(?:; the ${list}(?:, ${list})* list is damaged \\(it does not describe its own entries\\), so it approves nothing until an Admin saves it again under Admin > Approved programs)?`;
    const explanations = new RegExp(
      `^(?:${target} is not on the ${list} list that applies to this cabinet\\. An Admin adds it under Admin > Approved programs${damaged}|` +
      `the ${list} list that applies to this cabinet is empty, so it approves nothing\\. An Admin adds programs under Admin > Approved programs${damaged}|` +
      `${target} is not approved${damaged})$`,
    );
    if (message === "this cabinet has no approved-programs list: none is set for the cabinet, its site, its client or the fleet, so nothing can be controlled. An Admin sets one in the console under Admin > Approved programs"
        || (explanations.test(message) && message !== `${target} is not approved`)) {
      return "refusal named the cabinet's approved-programs list";
    }
  }
  if (code === "execution_failed") {
    const expected = operation === "process.end"
      ? `${params.name} (process ${params.processId}) is not on this cabinet's approved list, so the agent will not end it.`
      : `${params.name} is not on this cabinet's approved list, so the agent will not start, stop or restart it.`;
    const replacedProgram = `${params.name} does not run the program the approved list named, so the agent will not start, stop or restart it.`;
    if (message === expected || (operation !== "process.end" && message === replacedProgram)) {
      return "agent refusal named the cabinet's approved list";
    }
  }
}

async function connect() {
  const cabinetId = setting("CABINET_CABINET_ID").toLowerCase();
  if (!uuid.test(cabinetId)) throw new Error("Set CABINET_CABINET_ID to a cabinet UUID");
  const api = consoleApi();
  let login = await api("/api/auth/login", {
    username: setting("CABINET_ADMIN_USER"),
    password: setting("CABINET_ADMIN_PASSWORD"),
  });
  let nextCode;
  if (login.stage === "totp") {
    nextCode = authenticator();
    login = await api("/api/auth/totp", { code: await nextCode() });
  }
  if (login.stage !== "complete") throw new Error("Complete the Admin account setup in the console before running the sweep");
  const cabinet = await api(`/api/fleet/cabinets/${cabinetId}`);
  if (cabinet.demo) throw new Error("The selected cabinet is in the demo fleet");
  return { api, cabinetId, readOnly: cabinet.readOnly === true, nextCode };
}

async function runCommand(session, operation, params) {
  const { api, cabinetId, readOnly } = session;
  const path = `/api/cabinets/${cabinetId}/commands`;
  const body = { operation, params };
  if (writes.has(operation)) {
    session.nextCode ??= authenticator();
    // Write inputs are flat objects. The server binds confirmation to sorted JSON keys.
    const paramsHash = createHash("sha256").update(JSON.stringify(params, Object.keys(params).sort())).digest("hex");
    const confirmation = await api("/api/auth/step-up", {
      action: operation, target: cabinetId, paramsHash, code: await session.nextCode(),
    });
    if (typeof confirmation.token !== "string" || !confirmation.token) throw new Error("Console returned no step-up token");
    body.stepUpToken = confirmation.token;
  }

  let issued;
  session.pending = operation;
  try {
    issued = await api(path, body);
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    if (error.status < 500) session.pending = undefined;
    const assertion = verifyRefusal(operation, error.code, error.reason, readOnly, params);
    if (assertion && (operation === "boot.config" ? error.status === 400 : [403, 409].includes(error.status))) return { assertion };
    const detail = error.reason === undefined ? "no refusal message supplied" : "unexpected refusal message";
    throw new Error(`Command issue returned ${error.message} (${detail})`);
  }

  if (typeof issued.commandId !== "string" || !uuid.test(issued.commandId)) throw new Error("Console returned no valid command ID");
  const expiresAt = Date.parse(issued.expiresAt);
  const deadline = Math.max(Date.now() + 120_000, Number.isFinite(expiresAt) ? expiresAt + 30_000 : 0);
  while (Date.now() < deadline) {
    const record = await api(`/api/commands/${issued.commandId}`);
    if (record.operation !== operation) throw new Error("Command record names a different operation");
    if (["queued", "delivered"].includes(record.status)) {
      await delay(1_000);
      continue;
    }
    const result = record.result;
    if (!result) throw new Error(`Command ended without an agent result (${record.status})`);
    if (result.commandId?.toLowerCase() !== issued.commandId.toLowerCase() || result.status !== record.status) {
      throw new Error("Agent result does not match the command record");
    }
    session.pending = undefined;
    if (operation === "boot.config" && record.status === "succeeded") throw new Error("Agent ran a command that should be unknown");
    if (record.status === "succeeded" && result.output !== undefined) {
      if (writes.has(operation) && readOnly) throw new Error("Write succeeded on a read-only cabinet");
      return { output: result.output, assertion: "agent returned a successful, server-validated result" };
    }
    const assertion = verifyRefusal(operation, result.error?.code, result.error?.message, readOnly, params);
    if (assertion && ["failed", "rejected"].includes(record.status)) return { assertion };
    throw new Error(`Agent result was ${record.status} without the expected refusal`);
  }
  throw new Error("Timed out waiting for this command's agent result");
}

async function parameters(session, operation) {
  switch (operation) {
    case "eventlog.get": {
      const { output } = await runCommand(session, "eventlog.query", { log: "System", pageSize: 1 });
      const recordId = output?.entries?.[0]?.recordId;
      if (!Number.isSafeInteger(recordId) || recordId < 1) throw new Error("No System event record was available to open");
      return { log: "System", recordId };
    }
    case "database.connectivity":
      return { port: integer(env.CABINET_SWEEP_DATABASE_PORT ?? "1433", 65535, "CABINET_SWEEP_DATABASE_PORT") };
    case "service.control":
      return { name: setting("CABINET_SWEEP_SERVICE"), action: choice("CABINET_SWEEP_SERVICE_ACTION", ["start", "stop", "restart"]) };
    case "service.setStartType":
      return { name: setting("CABINET_SWEEP_SERVICE"), startType: choice("CABINET_SWEEP_START_TYPE", ["automatic", "automatic_delayed", "manual", "disabled"]) };
    case "process.end":
      return {
        processId: integer(setting("CABINET_SWEEP_PROCESS_ID"), 4294967295, "CABINET_SWEEP_PROCESS_ID"),
        name: setting("CABINET_SWEEP_PROCESS_NAME"),
      };
    default:
      return {};
  }
}

function checkOutput(operation, params, output, assertion) {
  if (output === undefined) return assertion;
  switch (operation) {
    case "eventlog.get":
      if (output.log === params.log && output.recordId === params.recordId) return "agent returned the requested event record";
      break;
    case "database.connectivity":
      if (output.port === params.port) return "agent reported connectivity for the requested port";
      break;
    case "service.control":
      if (output.name.toLowerCase() === params.name.toLowerCase() && output.action === params.action
          && output.after === (params.action === "stop" ? "stopped" : "running")) return "agent confirmed the requested service state";
      break;
    case "service.setStartType":
      if (output.name.toLowerCase() === params.name.toLowerCase() && output.after === params.startType) return "agent confirmed the requested start type";
      break;
    case "process.end":
      if (output.processId === params.processId && output.name.toLowerCase() === params.name.toLowerCase()
          && output.ended === true) return "agent confirmed the requested process ended";
      break;
    default:
      return assertion;
  }
  throw new Error("Agent output did not confirm the requested target and outcome");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out" || !args[1] || args[1].startsWith("-")) {
    throw new Error("Usage: node scripts/acceptance/live-cabinet-sweep.mjs --out <path-prefix>");
  }
  const prefix = args[1].replace(/\.(?:json|log)$/, "");
  if (!prefix) throw new Error("Set a nonempty --out path prefix");
  // Exclusive paths keep separate runs from overwriting earlier evidence.
  const log = await open(`${prefix}.log`, "wx", 0o600);
  try {
    const json = await open(`${prefix}.json`, "wx", 0o600);
    try {
      const print = async line => {
        console.log(line);
        await log.writeFile(`${line}\n`);
      };
      const verdicts = [];
      let session;
      let setupFailure;
      try {
        session = await connect();
      } catch (error) {
        setupFailure = error.message;
      }
      for (const operation of checks) {
        let verdict;
        try {
          if (!session) throw new Error(setupFailure);
          if (session.pending) throw new Error(`The outcome of ${session.pending} is still unconfirmed`);
          const params = await parameters(session, operation);
          const { output, assertion } = await runCommand(session, operation, params);
          verdict = { operation, verdict: "PASS", detail: checkOutput(operation, params, output, assertion) };
        } catch (error) {
          verdict = { operation, verdict: "FAIL", detail: error.message };
        }
        verdicts.push(verdict);
        await print(`${verdict.verdict} ${operation} ${verdict.detail}`);
      }
      const pass = verdicts.filter(check => check.verdict === "PASS").length;
      const fail = verdicts.length - pass;
      await json.writeFile(`${JSON.stringify(verdicts, null, 2)}\n`);
      await print(`# pass ${pass}`);
      await print(`# fail ${fail}`);
      process.exitCode = fail === 0 ? 0 : 1;
    } finally {
      await json.close();
    }
  } finally {
    await log.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
