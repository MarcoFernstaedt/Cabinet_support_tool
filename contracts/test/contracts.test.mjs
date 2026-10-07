// Contract tests: every schema compiles strictly, every valid example passes,
// every hostile example fails, and the catalog agrees with the schemas.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createAjv, readSchemas, readCatalog, ref, SCHEMA_DIR } from "../load.mjs";

const EXAMPLES = join(SCHEMA_DIR, "..", "examples");
const ajv = createAjv();
const catalog = readCatalog();
const opNames = catalog.operations.map(o => o.name);

/** examples/<dir>/{valid,invalid}/*.json → { target, kind, name, text } */
function examples() {
  const out = [];
  const walk = rel => {
    const dir = join(EXAMPLES, rel);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === "valid" || e.name === "invalid")
        for (const f of readdirSync(join(dir, e.name)).filter(f => f.endsWith(".json")).sort())
          out.push({ target: rel, kind: e.name, name: f, text: readFileSync(join(dir, e.name, f), "utf8") });
      else walk(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk("");
  return out;
}

// "operations/files.list/params" → operations/files.list.schema.json#/$defs/params
function schemaFor(target) {
  const parts = target.split("/");
  if (parts[0] === "operations") return ref(`operations/${parts[1]}.schema.json`, parts[2]);
  return ref(`${parts[0]}/${parts[1]}.schema.json`);
}

const all = examples();

test("every schema compiles under strict mode", () => {
  for (const { file } of readSchemas()) {
    if (file === "common.schema.json") continue;
    const defs = file.startsWith("operations/") ? ["params", "output"] : [undefined];
    for (const def of defs) assert.ok(ajv.getSchema(ref(file, def)), `${file} ${def ?? ""}`);
  }
});

for (const ex of all) {
  test(`${ex.target} ${ex.kind}/${ex.name}`, () => {
    const validate = ajv.getSchema(schemaFor(ex.target));
    assert.ok(validate, `no schema for ${ex.target}`);
    const ok = validate(JSON.parse(ex.text));
    if (ex.kind === "valid") assert.equal(ok, true, JSON.stringify(validate.errors, null, 1));
    else assert.equal(ok, false, "a hostile or malformed example was accepted");
  });
}

test("every envelope and every operation has a valid example, and every operation's params a hostile one", () => {
  const has = (target, kind) => all.some(e => e.target === target && e.kind === kind);
  for (const name of opNames) {
    for (const def of ["params", "output"]) assert.ok(has(`operations/${name}/${def}`, "valid"), `${name} ${def} needs a valid example`);
    assert.ok(has(`operations/${name}/params`, "invalid"), `${name} params needs a hostile example`);
  }
  for (const { file } of readSchemas().filter(s => s.file.startsWith("envelopes/") || s.file.startsWith("agent/") || s.file.startsWith("console/"))) {
    assert.ok(has(file.slice(0, -12), "valid"), `${file} needs a valid example`);
    assert.ok(has(file.slice(0, -12), "invalid"), `${file} needs a hostile example`);
  }
});

test("the broker accepts only catalog operations, every write goes through it, and each is routed to its parameter schema", () => {
  const request = JSON.parse(readFileSync(join(SCHEMA_DIR, "agent", "broker-request.schema.json"), "utf8"));
  const brokerOps = request.properties.operation.enum;
  for (const op of brokerOps) assert.ok(opNames.includes(op), `${op} must be in the catalog`);
  for (const w of catalog.operations.filter(o => o.kind === "write")) assert.ok(brokerOps.includes(w.name), `${w.name} needs administrator rights, so it runs in the broker`);
  const routed = request.allOf.filter(c => c.if?.properties?.operation?.const).map(c => c.if.properties.operation.const);
  assert.deepEqual([...routed].sort(), [...brokerOps].sort(), "every broker operation's params are checked");
  assert.ok(!JSON.stringify(request).includes('"path"'), "a broker request never carries a file path");
});

test("the trusted publisher list is valid, short, and pins roots whose files match their hashes", async () => {
  const { createHash, X509Certificate } = await import("node:crypto");
  const trustDir = join(SCHEMA_DIR, "..", "trust");
  const list = JSON.parse(readFileSync(join(trustDir, "trusted-publishers.json"), "utf8"));
  const validate = ajv.getSchema(ref("agent/trusted-publishers.schema.json"));
  assert.equal(validate(list), true, JSON.stringify(validate.errors));
  for (const root of list.roots) {
    const cert = new X509Certificate(readFileSync(join(trustDir, root.file)));
    assert.equal(createHash("sha256").update(cert.raw).digest("hex"), root.sha256, `${root.name}: file and pin agree`);
    assert.ok(cert.ca && cert.checkIssued(cert), `${root.name} is a self-signed CA`);
  }
  for (const p of list.publishers) {
    assert.ok(list.roots.some(r => r.sha256 === p.root), `${p.name}: its root is listed`);
    assert.ok(!/[*?]/.test(p.commonName + p.organization), `${p.name}: names are exact, never wildcards`);
  }
  assert.ok(list.publishers.length <= 10, "shorter is safer (docs/spec/09-open-decisions.md)");
});

test("the catalog, the operation name list and the operation files agree", () => {
  const common = JSON.parse(readFileSync(join(SCHEMA_DIR, "common.schema.json"), "utf8"));
  assert.deepEqual([...common.$defs.operationName.enum].sort(), [...opNames].sort());
  const files = readdirSync(join(SCHEMA_DIR, "operations")).filter(f => f.endsWith(".schema.json")).map(f => f.slice(0, -12));
  assert.deepEqual(files.sort(), [...opNames].sort());
  assert.equal(new Set(opNames).size, opNames.length, "duplicate operation names");
  const command = JSON.parse(readFileSync(join(SCHEMA_DIR, "envelopes", "command.schema.json"), "utf8"));
  const routed = command.allOf.map(c => c.if.properties.operation.const);
  assert.deepEqual(routed.sort(), [...opNames].sort(), "the command envelope must check params for every operation");
});

test("catalog rules follow the security model", () => {
  for (const op of catalog.operations) {
    assert.ok(["read", "write"].includes(op.kind), op.name);
    if (op.kind === "read") {
      assert.equal(op.expirySeconds, 300, `${op.name}: reads expire after 5 minutes`);
      assert.equal(op.stepUp, false, op.name);
      assert.equal(op.minimumRole, "tier1", op.name);
    } else {
      assert.equal(op.expirySeconds, 120, `${op.name}: writes expire after 2 minutes`);
      assert.equal(op.stepUp, true, `${op.name}: writes need step-up`);
      assert.equal(op.minimumRole, "tier2", op.name);
      assert.equal(op.rateClass, "write", op.name);
    }
  }
  const safetyNet = catalog.operations.filter(o => o.safetyNet).map(o => o.name).sort();
  assert.deepEqual(safetyNet, ["firewall.restore", "firewall.setProfile", "firewall.setRule", "network.setDns", "network.setIp"]);
});

test("no schema allows the Security log or a generic command", () => {
  const text = readSchemas().map(s => JSON.stringify(s.schema)).join("\n");
  const logs = JSON.parse(readFileSync(join(SCHEMA_DIR, "common.schema.json"), "utf8")).$defs.allowedLog.enum;
  assert.ok(!logs.some(l => /^security$/i.test(l)), "Security log must never be readable");
  for (const forbidden of ["shell", "exec", "script", "powershell", "cmd.exe", "run.command"])
    assert.ok(!opNames.some(n => n.toLowerCase().includes(forbidden)), `no operation may be a ${forbidden}`);
  assert.ok(!/"commandLine"|"arguments"|"script"/.test(text), "no schema may carry command lines, installer arguments or scripts");
});

test("logs that record sign-ins, credentials, sessions, typed commands or document names are never readable", () => {
  const logs = JSON.parse(readFileSync(join(SCHEMA_DIR, "common.schema.json"), "utf8")).$defs.allowedLog.enum.map(l => l.toLowerCase());
  assert.equal(new Set(logs).size, logs.length, "no duplicate log names");
  // Substring checks, so a channel added later under any of these providers fails too.
  const forbidden = [
    "powershell", "sysmon", "terminalservices", "remotedesktop", "winlogon", "user profile", "authentication",
    "ntlm", "kerberos", "capi2", "aad", "printservice/operational", "wmi-activity", "forwardedevents", "shell-core", "bitlocker",
    "credential", "logon", "crypto",
  ];
  for (const word of forbidden)
    assert.ok(!logs.some(l => l.includes(word)), `no allowed log may contain "${word}"`);
  // "Security" appears inside the firewall channel's name ("With Advanced Security"), so check providers, not substrings.
  assert.ok(!logs.some(l => l === "security" || l.startsWith("microsoft-windows-security")), "no Security log of any kind");
});

test("hostile size and shape inputs are rejected quickly", () => {
  const validate = ajv.getSchema(ref("envelopes/command.schema.json"));
  const base = JSON.parse(readFileSync(join(EXAMPLES, "envelopes/command/valid/eventlog-query.json"), "utf8"));
  const started = Date.now();
  assert.equal(validate({ ...base, params: { log: "System", source: "x".repeat(1_000_000) } }), false);
  let deep = {}; for (let i = 0; i < 5000; i++) deep = { a: deep };
  assert.equal(validate({ ...base, params: deep }), false);
  assert.equal(validate(null), false);
  assert.equal(validate([]), false);
  assert.equal(validate("command"), false);
  assert.ok(Date.now() - started < 2000, "validation must stay fast on hostile input");
});

test("generated TypeScript types are up to date", async () => {
  assert.ok(existsSync(join(SCHEMA_DIR, "..", "generated", "ts", "contracts.d.ts")), "run npm run generate");
  const { generate } = await import("../scripts/generate-ts.mjs");
  const fresh = await generate();
  const current = readFileSync(join(SCHEMA_DIR, "..", "generated", "ts", "contracts.d.ts"), "utf8");
  assert.equal(current, fresh, "generated/ts/contracts.d.ts is stale: run npm run generate");
});
