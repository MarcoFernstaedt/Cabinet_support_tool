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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

// The code part of a PowerShell line: everything before the first # that is not inside a quoted string, so a trailing
// comment cannot be mistaken for code (and a # inside a message is not mistaken for a comment).
function codePart(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if (character === "'" && !inDouble) inSingle = !inSingle;
    else if (character === '"' && !inSingle) inDouble = !inDouble;
    else if (character === "#" && !inSingle && !inDouble) return line.slice(0, index);
  }
  return line;
}

test("no throw in these scripts is left without a message to show the operator", () => {
  for (const name of scripts) {
    const text = readFileSync(join(installDir, name), "utf8");
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const match of codePart(line).matchAll(/\bthrow\b/g)) {
        const after = line.slice(match.index! + "throw".length).trimStart();
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

// pwsh runs on the Linux test machines; when it is there, the parts of the scripts that do not need Windows are run for real.
const pwsh = ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/microsoft/powershell/7/pwsh"].find((p) => existsSync(p));

/** Runs one function from a script, taken out of the script by the PowerShell parser, with the arguments given. */
function runFunction(script: string, name: string, args: string[]): { status: number | null; out: string } {
  const runner = join(mkdtempSync(join(tmpdir(), "ps-runner-")), "run.ps1");
  writeFileSync(runner, [
    "param([string]$Script, [string]$Name, [string[]]$Rest)",
    "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)",
    "$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }, $true)",
    "if (-not $fn) { throw \"no function $Name\" }",
    ". ([scriptblock]::Create($fn.Extent.Text))",
    "& $Name @Rest",
  ].join("\n"));
  const r = spawnSync(pwsh!, ["-NoProfile", "-NonInteractive", "-File", runner, "-Script", script, "-Name", name, "-Rest", ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("every install script parses with no errors", { skip: !pwsh && "pwsh is not installed" }, () => {
  for (const name of scripts) {
    const r = spawnSync(pwsh!, ["-NoProfile", "-NonInteractive", "-Command",
      "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:PS_FILE, [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.Message }; exit 1 }"],
      { encoding: "utf8", env: { ...process.env, PS_FILE: join(installDir, name) } });
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
  }
});

test("uninstall -RemoveData deletes links as links and never what they point at", { skip: !pwsh && "pwsh is not installed" }, () => {
  const root = mkdtempSync(join(tmpdir(), "remove-tree-"));
  const outside = join(root, "outside");
  const data = join(root, "data");
  mkdirSync(join(outside, "deep"), { recursive: true });
  writeFileSync(join(outside, "sentinel.txt"), "keep");
  writeFileSync(join(outside, "deep", "also.txt"), "keep");
  mkdirSync(join(data, "state", "sub"), { recursive: true });
  writeFileSync(join(data, "state", "sub", "f.txt"), "x");
  // What the network service could plant in a folder it can write: a link to a folder, a link to a file, a dangling link.
  symlinkSync(outside, join(data, "state", "folder-link"), "dir");
  symlinkSync(join(outside, "sentinel.txt"), join(data, "logs-file-link"));
  symlinkSync(join(root, "nowhere"), join(data, "dangling"));
  const r = runFunction(join(installDir, "Uninstall-CabinetAgent.ps1"), "Remove-Tree", [data]);
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(data), false, "the data folder is gone");
  assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "keep", "a linked file's target is untouched");
  assert.equal(readFileSync(join(outside, "deep", "also.txt"), "utf8"), "keep", "a linked folder's contents are untouched");
  // A link given as the path itself is removed as a link.
  symlinkSync(outside, join(root, "top-link"), "dir");
  assert.equal(runFunction(join(installDir, "Uninstall-CabinetAgent.ps1"), "Remove-Tree", [join(root, "top-link")]).status, 0);
  assert.equal(existsSync(join(root, "top-link")), false);
  assert.equal(existsSync(join(outside, "sentinel.txt")), true);
  rmSync(root, { recursive: true, force: true });
});

test("uninstall never uses Remove-Item -Recurse, which follows links on Windows PowerShell 5.1", () => {
  const text = readFileSync(join(installDir, "Uninstall-CabinetAgent.ps1"), "utf8");
  const code = text.split("\n").map(codePart).join("\n");
  assert.doesNotMatch(code, /Remove-Item[^\n]*-Recurse/);
  assert.match(code, /function Remove-Tree/);
});

test("a reinstall can turn read-only mode off, and refuses to be told both", () => {
  const text = readFileSync(join(installDir, "Install-CabinetAgent.ps1"), "utf8");
  assert.match(text, /\[switch\] \$ReadWrite/);
  assert.match(text, /if \(\$ReadOnly -and \$ReadWrite\) \{ throw /);
  assert.match(text, /readOnlyMode\s+= if \(\$ReadOnly\) \{ \$true \} elseif \(\$ReadWrite\) \{ \$false \} elseif \(\$installed\)/);
});

test("the installer refuses a source anyone but SYSTEM and administrators can change, and checks the copy it installs", () => {
  const text = readFileSync(join(installDir, "Install-CabinetAgent.ps1"), "utf8");
  const code = text.split("\n").map(codePart).join("\n");
  // The account running it counts as a non-administrator writer: its own unelevated programs could swap a file.
  assert.match(code, /\$trustedSids = @\('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'\)/);
  assert.doesNotMatch(code, /\$broad = /, "the old check looked only at Everyone, Authenticated Users and Users");
  assert.match(code, /GetOwner\(/, "the owner can rewrite the access list, so it is checked too");
  assert.match(code, /ReparsePoint\) \{ throw /, "a link in the source is refused");
  // The Authenticode scan reads the copy under Program Files, and the services are installed from that same copy.
  const copy = code.indexOf("$incoming = Join-Path $env:ProgramFiles");
  const scan = code.indexOf("Get-AuthenticodeSignature");
  const install = code.indexOf("$from = Join-Path $incoming $service.Project");
  assert.ok(copy > 0 && scan > copy && install > scan, "copy, then check the copy, then install the copy");
  assert.match(code, /Get-ChildItem -LiteralPath \$incoming -Recurse -File -Include '\*\.exe', '\*\.dll'/);
  assert.match(code, /finally \{[\s\S]*Remove-Item -LiteralPath \$incoming/);
});
