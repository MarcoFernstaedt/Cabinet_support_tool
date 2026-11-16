// rules.ts and events.ts import each other (decision-log D104). That is safe only while neither reads the other's exports while it is
// loading: whichever loads first sees the other's bindings before they are set. events.ts builds its event insert from rules.ts's
// RULES_STAMP_SQL; built when the module loaded, a process that loads rules.ts first stopped with "Cannot access 'RULES_STAMP_SQL'
// before initialization" (the D73 failure, in another pair). Each module is loaded first in a fresh process, as a server or a test that
// imports only it would.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVICES = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "services");

for (const first of ["rules.js", "events.js", "alerts.js"]) {
  test(`a process that loads ${first} first loads it`, () => {
    const url = pathToFileURL(join(SERVICES, first)).href;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
  });
}
