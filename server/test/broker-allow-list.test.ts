// The broker runs only the operations on its own hand-written list (Cabinet.Agent.Core/BrokerProtocol.cs), and that list
// is kept in step with a second hand-written list in the contract (schemas/agent/broker-request.schema.json) by a .NET
// test that compares the two. Neither list is checked against the registry the broker is actually handed, so an operation
// added to that registry and forgotten in both lists is invisible - and it is not a cosmetic mistake: the broker's
// constructor throws ArgumentException for an operation it has no right to run, the service stops as it starts, and the
// agent install fails on the cabinet. That is exactly what boot.history did (0e56dc5 added the read to the broker's
// registry; the witness lists were not touched; the suite stayed green because the guard test compared one stale list
// with the other stale list).
//
// The three files are in three languages, so no compiler can check this. Reading them as text is the cheap, honest
// substitute: it fails the moment a read is registered with the broker and not declared, which is the drift that shipped.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");
const agentSrc = join(root, "agent", "src");

const catalog = readFileSync(join(agentSrc, "Cabinet.Agent.Contracts", "Catalog.cs"), "utf8");
const byConstant = new Map<string, string>();
for (const m of catalog.matchAll(/public const string (\w+)\s*=\s*"([^"]+)"/g)) {
  const [, constant, value] = m;
  if (constant && value) byConstant.set(constant, value);
}

/** The Catalog.* constants a file names, as operation names. */
function operations(text: string, where: string): string[] {
  return [...text.matchAll(/Catalog\.(\w+)/g)].map(m => {
    const constant = m[1] ?? "";
    const name = byConstant.get(constant);
    assert.ok(name, `${where} names Catalog.${constant}, which Catalog.cs does not declare`);
    return name;
  });
}

// Only the Operations array: BrokerProtocol.cs names Catalog constants for other reasons too.
const protocol = readFileSync(join(agentSrc, "Cabinet.Agent.Core", "BrokerProtocol.cs"), "utf8");
const listStart = protocol.indexOf("Operations = new[]");
assert.ok(listStart > 0, "BrokerProtocol.cs no longer has an Operations array - this test needs rewriting, not deleting");
const allowed = operations(protocol.slice(listStart, protocol.indexOf("};", listStart)), "BrokerProtocol.cs");

const registered = operations(readFileSync(join(agentSrc, "Cabinet.Agent.Windows", "BrokerReadOperations.cs"), "utf8"),
  "Cabinet.Agent.Windows/BrokerReadOperations.cs");

const schema = JSON.parse(readFileSync(join(root, "contracts", "schemas", "agent", "broker-request.schema.json"), "utf8"));
const declared: string[] = schema.properties.operation.enum;

test("every read the broker is given is on the broker's own list", () => {
  const missing = registered.filter(name => !allowed.includes(name));
  assert.deepEqual(missing, [],
    `BrokerProtocol.cs's Operations is missing ${missing.join(", ")}. The broker throws while it starts and the agent never installs.`);
});

test("every read the broker is given is named in the broker request contract", () => {
  const missing = registered.filter(name => !declared.includes(name));
  assert.deepEqual(missing, [],
    `contracts/schemas/agent/broker-request.schema.json is missing ${missing.join(", ")}.`);
});

test("the broker's list and the contract name exactly the same operations", () => {
  // The .NET guard test asserts this too, but it runs only on Windows; this is the same check on the host that gates merges.
  assert.deepEqual([...allowed].sort(), [...declared].sort());
});
