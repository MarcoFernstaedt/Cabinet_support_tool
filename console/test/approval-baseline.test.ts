import test from "node:test";
import assert from "node:assert/strict";
import { choiceAfterPreview, decisionFrom, inForceText, type BaselinePreview } from "../src/lib/approval-baseline.ts";

const preview = (p: Partial<BaselinePreview>): BaselinePreview => ({ inForce: [], modelBaselines: 0, siteHasOwn: false, choices: [], ...p });
const CLIENT = { kind: "client", name: "Lakeside", version: 3 };

test("a decision is only sent once it is complete", () => {
  assert.equal(decisionFrom("", ""), null);
  assert.equal(decisionFrom("attach", ""), null, "attach needs the version");
  assert.deepEqual(decisionFrom("attach", "v1"), { use: "attach", versionId: "v1" });
  assert.deepEqual(decisionFrom("inherited", "v1"), { use: "inherited" }, "a version chosen earlier is not sent with another choice");
  assert.deepEqual(decisionFrom("capture", ""), { use: "capture" });
});

test("a baseline in force is the default; with none, the approver chooses", () => {
  assert.equal(choiceAfterPreview("", preview({ inForce: [CLIENT] })), "inherited");
  assert.equal(choiceAfterPreview("capture", preview({ inForce: [CLIENT] })), "capture", "the approver's own choice stands");
  assert.equal(choiceAfterPreview("inherited", preview({})), "", "nothing in force any more: choose again");
  assert.equal(choiceAfterPreview("attach", preview({ siteHasOwn: true, inForce: [{ kind: "site", name: "East", version: 1 }] })), "attach");
  assert.equal(choiceAfterPreview("attach", preview({ siteHasOwn: true })), "", "a site with its own baseline is not attached to");
  assert.equal(choiceAfterPreview("capture", preview({})), "capture");
});

test("the baselines in force are named with their level", () => {
  assert.equal(inForceText([]), "No approved baseline applies");
  assert.equal(inForceText([{ kind: "global", name: "Fleet", version: 2 }, CLIENT]), "Judged against Fleet v2 (the fleet), then Lakeside v3 (the client)");
});
