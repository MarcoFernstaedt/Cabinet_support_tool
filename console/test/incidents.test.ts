// Incident records as the console shows them (src/lib/incidents.ts): every state and step has words and a tone, an unknown one is shown
// as itself rather than hidden, and the line under an incident says where it stands.
import test from "node:test";
import assert from "node:assert/strict";
import { actorText, incidentLine, linkLabel, STATE, stateOf, stepLabel, type IncidentSummary } from "../src/lib/incidents.ts";

const base: IncidentSummary = { id: "1", state: "open", symptom: "Scanner offline", module: null, openedBy: { kind: "user", name: "Dana Ruiz" },
  openedAt: "2026-10-31T10:00:00Z", updatedAt: "2026-10-31T10:00:00Z", closedAt: null, outcome: null };

test("every state the server can store has words and a tone, and an unknown one is shown as itself", () => {
  // The states of migration 0017's incidents_state_check.
  for (const s of ["open", "awaiting_approval", "approved", "repairing", "resolved", "unresolved"]) assert.ok(STATE[s as keyof typeof STATE], s);
  assert.deepEqual(stateOf("resolved"), ["Resolved", "ok"]);
  assert.deepEqual(stateOf("something_new"), ["something_new", "off"]);
});

test("every step and link kind has words; an unknown one is shown as itself", () => {
  for (const k of ["symptom", "evidence", "hypothesis", "proposed_repair", "approval", "execution", "verification", "note", "close"]) assert.notEqual(stepLabel(k), k);
  assert.equal(stepLabel("proposed_repair"), "Repair proposed");
  assert.equal(stepLabel("mystery"), "mystery");
  assert.equal(linkLabel("case_note"), "Case note");
  assert.equal(linkLabel("mystery"), "mystery");
});

test("who acted is a person's name or the platform part, never an id", () => {
  assert.equal(actorText({ kind: "user", name: "Dana Ruiz" }), "Dana Ruiz");
  assert.equal(actorText({ kind: "system", name: "engine" }), "the platform (engine)");
});

test("the line under an incident says where it stands, and a closed one how it ended", () => {
  assert.equal(incidentLine(base), "Opened by Dana Ruiz.");
  assert.match(incidentLine({ ...base, state: "awaiting_approval" }), /waits for a person to approve/);
  assert.match(incidentLine({ ...base, state: "repairing" }), /checked next/);
  assert.equal(incidentLine({ ...base, state: "resolved", closedAt: "2026-10-31T11:00:00Z", outcome: "The service is running again" }), "Ended: The service is running again");
  assert.equal(incidentLine({ ...base, state: "unresolved", closedAt: "2026-10-31T11:00:00Z" }), "Closed.");
});
