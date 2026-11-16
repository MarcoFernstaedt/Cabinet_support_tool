import test from "node:test";
import assert from "node:assert/strict";
import { envelopes } from "../src/contracts.js";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

test("shell wire kinds are directional, named and closed to generic pipes and executable paths", () => {
  for (const body of [{ kind: "shell.in", data: "YQ==" }, { kind: "shell.resize", columns: 80, rows: 24 }, { kind: "shell.exit" }]) {
    assert.equal(envelopes.sessionControl.is(body), true);
    assert.equal(envelopes.sessionFrame.is(body), false);
  }
  for (const body of [{ kind: "shell.out", data: "YQ==" }, { kind: "shell.exit", code: 0 }]) {
    assert.equal(envelopes.sessionFrame.is(body), true);
    assert.equal(envelopes.sessionControl.is(body), false);
  }
  for (const body of [{ kind: "pipe", data: "YQ==" }, { kind: "shell.in", data: "!" }, { kind: "shell.in", data: "YQ==", executable: "cmd.exe" }, { kind: "shell.resize", columns: 0, rows: 24 }])
    assert.equal(envelopes.sessionControl.is(body), false);
  assert.equal(envelopes.sessionControl.is({ control: "keepalive", data: "YQ==" }), false);
  assert.equal(envelopes.sessionFrame.is({ data: "YQ==" }), true);
});

test("release packing and shipped configuration never enable the development shell", () => {
  const folder = resolve(import.meta.dirname, "../../../agent/install");
  assert.doesNotMatch(readFileSync(resolve(folder, "new-agent-release.py"), "utf8"), /developmentShellEnabled/);
  for (const name of readdirSync(folder).filter(n => /\.json$|\.ps1$/.test(n)))
    assert.doesNotMatch(readFileSync(resolve(folder, name), "utf8"), /developmentShellEnabled/);
});
