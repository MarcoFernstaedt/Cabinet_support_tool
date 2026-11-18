// The derivation the update store trusts instead of a name: the architecture of a
// release package is the machine of the programs inside it, read out of the zip the pipeline published. These are
// specifications: what the platform derives, and the exact refusal every other package gets instead of a guess.
import test from "node:test";
import assert from "node:assert/strict";
import { missingReleasePrograms, PackageArchitectureError, packageArchitecture } from "../src/services/package-architecture.js";
import { pe, zip } from "./package-pki.js";

/** The programs of a real agent package, in the layout the pipeline publishes. */
const PROGRAMS = ["Cabinet.Agent.Broker/Cabinet.Agent.Broker.exe", "Cabinet.Agent.Harness/cabinet-harness.exe",
  "Cabinet.Agent.Network/Cabinet.Agent.Network.exe", "Cabinet.Agent.Updater/Cabinet.Agent.Updater.exe"];

const packageOf = (machine: number, deflate = true): Buffer =>
  zip([...PROGRAMS.map(name => [name, pe("MZ|signed:agent-signer", machine)] as [string, Buffer]), ["Cabinet.Agent.Network/notes.json", Buffer.from("{}")]], deflate);

const refused = (why: RegExp) => (e: unknown) => {
  assert.ok(e instanceof PackageArchitectureError, `expected a PackageArchitectureError, got ${String(e)}`);
  assert.match(e.message, why);
  return true;
};

test("a package's architecture is the machine of every program inside it", () => {
  assert.equal(packageArchitecture(packageOf(0x8664)), "windows-x64");
  assert.equal(packageArchitecture(packageOf(0x14c)), "windows-x86");
  // A zip may store or deflate each entry; both read the same, so the answer cannot depend on how the pipeline zipped it.
  assert.equal(packageArchitecture(packageOf(0x8664, false)), "windows-x64");
  assert.equal(packageArchitecture(packageOf(0x14c, false)), "windows-x86");
});

test("a package must hold the programs the updater installs, or it is refused before a cabinet ever sees one", () => {
  // The release layout: one folder per program at the zip root, which is exactly what the updater swaps in.
  assert.deepEqual(missingReleasePrograms(packageOf(0x8664)), []);
  // The installer bundle the deploy serves carries the same programs one level down. It installs a cabinet
  // perfectly well and can never be updated to, so the update store must not accept it as a release package.
  const bundle = zip([...PROGRAMS.map(name => [`CabinetAgent/out/${name}`, pe("MZ|signed:agent-signer", 0x8664)] as [string, Buffer]),
    ["CabinetAgent/install/Install-CabinetAgent.ps1", Buffer.from("# installer")]], true);
  assert.deepEqual(missingReleasePrograms(bundle).sort(), [...PROGRAMS].sort());
  // One program missing is enough: the updater fails on exactly that name.
  const partial = zip(PROGRAMS.slice(1).map(name => [name, pe("MZ|signed:agent-signer", 0x8664)] as [string, Buffer]), true);
  assert.deepEqual(missingReleasePrograms(partial), [PROGRAMS[0]]);  // the one that is missing, by name
  // A backslash-separated name is the same path, so an archive built on Windows is not refused for that alone.
  const backslashes = zip(PROGRAMS.map(name => [name.replace(/\//g, "\\"), pe("MZ|signed:agent-signer", 0x8664)] as [string, Buffer]), true);
  assert.deepEqual(missingReleasePrograms(backslashes), []);
});

test("a package that has no single architecture is refused, never guessed at", () => {
  // Programs built for different Windows: there is no answer that could be right for all of them.
  const mixed = zip([["Broker/Cabinet.Agent.Broker.exe", pe("MZ|signed", 0x8664)], ["Updater/Cabinet.Agent.Updater.exe", pe("MZ|signed", 0x14c)]], true);
  assert.throws(() => packageArchitecture(mixed), refused(/mixes architectures: Broker\/Cabinet\.Agent\.Broker\.exe \(windows-x64\), Updater\/Cabinet\.Agent\.Updater\.exe \(windows-x86\)/));
  // A machine that is neither 64-bit nor 32-bit Windows (0x1c0 is ARM): not something this platform can hand to a cabinet.
  assert.throws(() => packageArchitecture(packageOf(0x1c0)), refused(/another machine \(0x1c0\)/));
  // Nothing to read at all.
  assert.throws(() => packageArchitecture(zip([["Cabinet.Agent.Network/notes.json", Buffer.from("{}")]], true)), refused(/holds no program/));
  assert.throws(() => packageArchitecture(Buffer.from("this is not a zip")), refused(/not a zip/));
  // An .exe entry that is not a Windows program, and one that is too short to hold a header.
  const noHeader = pe("x"); noHeader.write("XXXX", 0x80, "latin1");
  assert.throws(() => packageArchitecture(zip([["a/Cabinet.Agent.Broker.exe", noHeader]], true)), refused(/has no PE header/));
  assert.throws(() => packageArchitecture(zip([["a/Cabinet.Agent.Broker.exe", Buffer.from("MZ")]], true)), refused(/too short/));
  assert.throws(() => packageArchitecture(zip([["a/Cabinet.Agent.Broker.exe", Buffer.alloc(0x100, 0x42)]], true)), refused(/does not start with MZ/));
});

test("only the programs count: a zip's other entries are not read as ones", () => {
  // A .dll that is not a Windows program cannot make a package unreadable: the platform hands out programs, and those are .exe.
  assert.equal(packageArchitecture(zip([["a/Cabinet.Agent.Broker.exe", pe("MZ|signed", 0x14c)], ["a/helper.dll", Buffer.from("MZ not a program")]], true)), "windows-x86");
});

test("a zip64 package is refused rather than read with half of an offset", () => {
  // The reader does not describe the second record zip64 moves the counts into, and reading a truncated offset would put it
  // in the middle of a program, so it says so instead.
  const big = packageOf(0x8664, false);
  const zip64 = Buffer.from(big);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
  assert.throws(() => packageArchitecture(zip64), refused(/zip64/));
});
