// The installer runs on a cabinet, under Windows PowerShell 5.1, as the only thing standing between an operator and a
// half-installed agent. Two properties of those files are load-bearing and are easy to break from a Linux editor:
// they must stay pure ASCII, and every failure must end in one readable sentence and exit code 1 rather than a
// PowerShell stack trace.
//
// ASCII: Windows PowerShell 5.1 reads a .ps1 as ANSI (Windows-1252) when the file has no BOM, so a single em dash
// becomes three bytes and one of them is a curly quote that closes the string it sits in early - the script then fails
// to parse on the cabinet, while every check made from this repository (pwsh 7, which reads UTF-8) passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");
const installDir = join(root, "agent", "install");
const scripts = readdirSync(installDir).filter((name) => name.endsWith(".ps1"));

test("the install scripts are pure ASCII with no BOM, so 5.1 parses them", () => {
  assert.ok(scripts.length >= 4, `expected the install scripts, found ${scripts.join(", ")}`);
  for (const name of scripts) {
    const bytes = readFileSync(join(installDir, name));
    const offenders = [...bytes].map((byte, index) => ({ byte, index })).filter((b) => b.byte > 127);
    if (offenders.length > 0) {
      const first = offenders[0]!;
      const line = bytes.subarray(0, first.index).toString("latin1").split("\n").length;
      assert.fail(`${name} has ${offenders.length} non-ASCII byte(s), first at line ${line} (0x${first.byte.toString(16)}): Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI and will mis-parse it`);
    }
    assert.notDeepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), `${name} starts with a UTF-8 BOM`);
  }
});

test("each script that installs or removes the agent ends in one funnel and exit code 1", () => {
  const endings: Record<string, string> = {
    "Install-CabinetAgent.ps1": "The cabinet agent was NOT installed.",
    "Uninstall-CabinetAgent.ps1": "The cabinet agent was NOT removed.",
  };
  for (const [name, marker] of Object.entries(endings)) {
    const text = readFileSync(join(installDir, name), "utf8");
    assert.ok(text.includes(marker), `${name} states the failure in plain words`);
    assert.match(text, /^\s*exit 1$/m, `${name} exits 1 when it fails`);
    assert.match(text, /^catch \{$/m, `${name} has the catch that prints it`);
    assert.match(text, /What happened :/, `${name} names what happened`);
    assert.match(text, /Next step {5}:|Next step/, `${name} says what to do next`);
  }
});

test("no throw in these scripts is left without a message to show the operator", () => {
  for (const name of scripts) {
    const text = readFileSync(join(installDir, name), "utf8");
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trimStart().startsWith("#")) continue;
      for (const match of line.matchAll(/\bthrow\b/g)) {
        const after = line.slice(match.index! + "throw".length).trimStart();
        if (after.startsWith("#")) continue; // the word only appears in a trailing comment
        assert.match(after, /^["'($]/, `${name}:${index + 1} throws without a message: ${line.trim()}`);
      }
    }
  }
});

test("the installer checks this machine before it copies anything", () => {
  const text = readFileSync(join(installDir, "Install-CabinetAgent.ps1"), "utf8");
  // The Windows build first (the agent is a .NET 10 program: Windows 7 and 8.1 cannot run it at all) and the
  // architecture of the published programs, read from the PE header rather than trusted from the file name.
  assert.match(text, /CurrentBuildNumber/);
  assert.match(text, /14393/);
  assert.match(text, /Function Get-PeMachine|function Get-PeMachine/);
  assert.match(text, /0x014c/);
  assert.match(text, /0x8664/);
});
