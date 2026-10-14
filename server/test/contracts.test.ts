// The server validates with exactly the shared schemas, and the generated
// types describe the same shapes. Compile-time checks live in this file too:
// if the types drifted from the schemas, `npm run build` would fail here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "@mashura/cabinet-contracts/load";
import { ContractError, catalog, envelopes, isOperationName, operations } from "../src/contracts.js";
import type { Command, FilesListParams, OperationName, TypedCommand } from "../src/contracts.js";

const EXAMPLES = join(SCHEMA_DIR, "..", "examples");
const load = (rel: string): unknown => JSON.parse(readFileSync(join(EXAMPLES, rel), "utf8"));
const files = (rel: string): string[] => (existsSync(join(EXAMPLES, rel)) ? readdirSync(join(EXAMPLES, rel)).filter(f => f.endsWith(".json")) : []);

test("the server's catalog has all 31 operations", () => {
  assert.equal(catalog.size, 31);
  assert.equal(isOperationName("files.list"), true);
  assert.equal(isOperationName("shell.run"), false);
  assert.equal(isOperationName({}), false);
});

test("server operation validators agree with every shared example", () => {
  for (const name of catalog.keys()) {
    for (const def of ["params", "output"] as const) {
      const v = operations[name][def];
      for (const f of files(`operations/${name}/${def}/valid`)) assert.equal(v.is(load(`operations/${name}/${def}/valid/${f}`)), true, `${name} ${def} ${f}`);
      for (const f of files(`operations/${name}/${def}/invalid`)) assert.equal(v.is(load(`operations/${name}/${def}/invalid/${f}`)), false, `${name} ${def} ${f}`);
    }
  }
});

test("server envelope validators agree with every shared example", () => {
  const map: Record<string, keyof typeof envelopes> = {
    command: "command", result: "result", event: "event", "event-batch": "eventBatch", heartbeat: "heartbeat",
    "server-ack": "serverAck", "commands-response": "commandsResponse", "enroll-request": "enrollRequest",
    "enroll-response": "enrollResponse", "enroll-status": "enrollStatus", "renew-request": "renewRequest", "renew-response": "renewResponse",
  };
  for (const [dir, key] of Object.entries(map)) {
    for (const f of files(`envelopes/${dir}/valid`)) assert.equal(envelopes[key].is(load(`envelopes/${dir}/valid/${f}`)), true, `${dir} ${f}`);
    for (const f of files(`envelopes/${dir}/invalid`)) assert.equal(envelopes[key].is(load(`envelopes/${dir}/invalid/${f}`)), false, `${dir} ${f}`);
  }
});

test("parse() returns typed data or a ContractError that never echoes the input", () => {
  const command = envelopes.command.parse(load("envelopes/command/valid/eventlog-query.json"));
  assert.equal(command.operation, "eventlog.query");

  const secret = "TOP-SECRET-bootstrap-token-value-0000000000";
  const hostile = load("envelopes/enroll-request/valid/typical.json") as Record<string, unknown>;
  try {
    envelopes.enrollRequest.parse({ ...hostile, bootstrapToken: `${secret}!` , extra: "<script>" });
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof ContractError);
    assert.ok(error.issues.length > 0);
    const text = JSON.stringify({ message: error.message, issues: error.issues });
    assert.ok(!text.includes(secret), "the token value must not appear in the error");
    assert.ok(!text.includes("<script>"), "hostile input must not appear in the error");
    assert.ok(error.issues.some(i => i.path === "/bootstrapToken"));
  }
});

// ---- Compile-time checks: these only need to type-check. ---------------------
export function typedCommandsCompile(): void {
  const params: FilesListParams = { path: "C:\\ProgramData", page: 1 };
  const ok: TypedCommand<"files.list"> = {
    commandId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", cabinetId: "9b2d7c1e-5a4f-4e3b-8c2d-1f0e9a8b7c6d",
    operation: "files.list", params, issuedBy: "4c1b2a3d-9e8f-4a7b-b6c5-d4e3f2a1b0c9",
    issuedAt: "2026-10-04T19:00:00Z", expiresAt: "2026-10-04T19:05:00Z",
  };
  const widened: Command = ok;
  void widened;
  // @ts-expect-error files.list params need a path
  const missing: TypedCommand<"files.list"> = { ...ok, params: {} };
  // @ts-expect-error the operation name is checked against the catalog
  const unknown: OperationName = "shell.run";
  // @ts-expect-error package types are only driver or msi
  const exe: TypedCommand<"package.install">["params"] = { packageId: "x", packageType: "exe", sha256: "a" };
  void missing; void unknown; void exe;
}
