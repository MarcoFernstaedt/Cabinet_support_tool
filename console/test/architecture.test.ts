// How the console says a cabinet's architecture (src/lib/architecture.ts).
//
// A cabinet reports the Windows its agent programs are built for, and the console shows it in an operator's words.
// The rule these tests hold is the one that matters: it never guesses. An agent built before cabinets reported an
// architecture sends none, and saying "64-bit" there is exactly the mistake that would put the wrong package on a
// machine, so a value nobody recorded reads as nobody recorded it.
import test from "node:test";
import assert from "node:assert/strict";
import { architectureDetail, architectureLabel, architectureLine, isCabinetArchitecture } from "../src/lib/architecture.ts";

test("an architecture the platform recorded reads in the words an operator uses", () => {
  assert.equal(architectureLabel("windows-x64"), "64-bit");
  assert.equal(architectureLabel("windows-x86"), "32-bit");
  assert.equal(architectureLine("windows-x64"), "64-bit Windows");
  assert.equal(architectureLine("windows-x86"), "32-bit Windows");
  assert.equal(architectureDetail("windows-x86"), "32-bit Windows (windows-x86)");
});

test("a cabinet that has not reported one is never shown as a claim", () => {
  for (const value of [null, undefined, "", "windows-arm64", "64-bit"]) {
    assert.equal(architectureLabel(value), null, `${String(value)} must not read as an architecture`);
    assert.equal(architectureLine(value), "architecture not recorded");
    assert.equal(isCabinetArchitecture(value), false);
  }
  assert.match(architectureDetail(null), /not reported/);
  assert.match(architectureDetail(null), /64-bit Windows$/, "the detail may explain the meaning, and must say it is the meaning of nothing recorded");
});

test("only the two architectures the platform stores are architectures", () => {
  assert.equal(isCabinetArchitecture("windows-x64"), true);
  assert.equal(isCabinetArchitecture("windows-x86"), true);
  assert.equal(isCabinetArchitecture("x86"), false);
  assert.equal(isCabinetArchitecture("Windows-x86"), false, "the value on the wire is lower case; a case-folded match would hide a real mismatch");
});
