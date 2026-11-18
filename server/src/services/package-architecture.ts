// What a release package really is, read from the programs inside it.
// The architecture a release is added under is a declaration by the pipeline; this is the check that makes it
// true, so the store never hands a cabinet a package built for Windows it cannot run, and two releases that share a version
// cannot be confused for each other.
//
// Nothing is added as a dependency for this: a zip's central directory and a PE header are both small, documented formats,
// and node:zlib inflates one entry's bytes on its own. Anything unreadable, unnamed or mixed is refused rather than guessed
// at - a wrong answer here would strand cabinets with a package they cannot run, which is the whole thing this prevents.

import { inflateRawSync } from "node:zlib";

/** The Windows architectures the platform knows (contracts/schemas/common.schema.json #/$defs/architecture). */
export type Architecture = "windows-x64" | "windows-x86";

const ARCHITECTURES: readonly Architecture[] = ["windows-x64", "windows-x86"];

/** Whether a value names one of the two architectures; the store, the check constraint and the console all agree on these. */
export const isArchitecture = (value: unknown): value is Architecture =>
  typeof value === "string" && (ARCHITECTURES as readonly string[]).includes(value);

/** The PE machine field each architecture's programs carry: 0x8664 is a 64-bit program, 0x14c a 32-bit one. */
const MACHINES: Record<Architecture, number> = { "windows-x64": 0x8664, "windows-x86": 0x14c };

/** What a program of an architecture carries in its header; the test kit builds its packages' programs with it. */
export const machineFor = (architecture: Architecture): number => MACHINES[architecture];

const ARCHITECTURE_OF = new Map<number, Architecture>(Object.entries(MACHINES).map(([a, m]) => [m, a as Architecture]));

/** A package whose programs cannot be read, or do not agree with each other; the service turns this into a refusal. */
export class PackageArchitectureError extends Error {}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64 = 0xffffffff;
const STORED = 0;

interface Entry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

/** The offset of the end-of-central-directory record: the signature, found by scanning back, whose comment ends the file. */
function endOfCentralDirectory(zip: Buffer): number {
  if (zip.length < 22) throw new PackageArchitectureError("the package is not a zip: it is too short to hold one");
  // The record is 22 bytes followed by a comment of at most 65535; the check that the comment really ends the file keeps a
  // signature that happens to sit inside a program's bytes from being mistaken for it.
  const earliest = Math.max(0, zip.length - (22 + 0xffff));
  for (let p = zip.length - 22; p >= earliest; p--) {
    if (zip.readUInt32LE(p) !== END_OF_CENTRAL_DIRECTORY) continue;
    if (p + 22 + zip.readUInt16LE(p + 20) === zip.length) return p;
  }
  throw new PackageArchitectureError("the package is not a zip: it has no end-of-central-directory record");
}

/** Every entry the archive's central directory names, in the order it names them. */
function entries(zip: Buffer): Entry[] {
  const eocd = endOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  const size = zip.readUInt32LE(eocd + 12);
  let p = zip.readUInt32LE(eocd + 16);
  // A zip64 archive moves the counts and offsets into a second record this reader does not describe. Refusing is honest;
  // reading the low half of a zip64 offset would put us in a program's bytes and produce a wrong answer.
  if (size === ZIP64 || p === ZIP64 || count === 0xffff) throw new PackageArchitectureError("the package is a zip64 archive, which this reader cannot describe");
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== CENTRAL_HEADER) throw new PackageArchitectureError("the package's central directory is damaged");
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    if (compressedSize === ZIP64 || localOffset === ZIP64) throw new PackageArchitectureError("the package is a zip64 archive, which this reader cannot describe");
    out.push({ name: zip.toString("utf8", p + 46, p + 46 + nameLength), method, compressedSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** The bytes of one entry, inflated if it was compressed; the central directory is authoritative about how many there are. */
function entryBytes(zip: Buffer, entry: Entry): Buffer {
  const p = entry.localOffset;
  if (p + 30 > zip.length || zip.readUInt32LE(p) !== LOCAL_HEADER) throw new PackageArchitectureError(`the package's entry ${entry.name} has no local header`);
  const start = p + 30 + zip.readUInt16LE(p + 26) + zip.readUInt16LE(p + 28);
  if (start + entry.compressedSize > zip.length) throw new PackageArchitectureError(`the package's entry ${entry.name} runs past the end of the file`);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === STORED) return Buffer.from(data);
  try {
    return inflateRawSync(data);
  } catch {
    throw new PackageArchitectureError(`the package's entry ${entry.name} is not a readable deflate stream`);
  }
}

/** The PE machine field of one program: its header says which Windows the program was built for. */
function machineOf(program: Buffer, name: string): number {
  if (program.length < 0x40) throw new PackageArchitectureError(`${name} is too short to be a Windows program`);
  if (program.readUInt16LE(0) !== 0x5a4d) throw new PackageArchitectureError(`${name} is not a Windows program: it does not start with MZ`);
  const pe = program.readUInt32LE(0x3c);
  if (pe + 6 > program.length || program.readUInt32LE(pe) !== 0x00004550) throw new PackageArchitectureError(`${name} is not a Windows program: it has no PE header`);
  return program.readUInt16LE(pe + 4);
}

/**
 * The architecture of a release package: the machine of every .exe inside it. The package's programs are the only thing that
 * can be trusted here - its name, and the release's declared architecture, are what this checks. A package whose programs
 * disagree, or are not readable Windows programs, has no single answer and is refused.
 */
export function packageArchitecture(packageBytes: Buffer): Architecture {
  const programs = entries(packageBytes).filter(e => e.name.toLowerCase().endsWith(".exe"));
  if (programs.length === 0) throw new PackageArchitectureError("the package holds no program: it has no .exe entry to read");
  const read = programs.map(program => {
    const machine = machineOf(entryBytes(packageBytes, program), program.name);
    const architecture = ARCHITECTURE_OF.get(machine);
    if (!architecture) throw new PackageArchitectureError(`${program.name} is built for another machine (0x${machine.toString(16)}): neither 64-bit nor 32-bit Windows`);
    return { name: program.name, architecture };
  });
  const architectures = new Set(read.map(p => p.architecture));
  if (architectures.size > 1) throw new PackageArchitectureError(`the package mixes architectures: ${read.map(p => `${p.name} (${p.architecture})`).join(", ")}`);
  return read[0]!.architecture;
}

/**
 * The programs a release package carries, exactly as the agent lays them out on disk
 * (agent/src/Cabinet.Agent.Core/Upgrades/Authenticode.cs, AgentLayout.ReleasePrograms): one folder per program at
 * the zip root. The updater looks each of these up by this name, so a package without them cannot be installed
 * however well formed it is. Keep this list beside that one: the agent's copy is what the machine enforces.
 */
export const RELEASE_PROGRAMS: readonly string[] = [
  "Cabinet.Agent.Broker/Cabinet.Agent.Broker.exe",
  "Cabinet.Agent.Network/Cabinet.Agent.Network.exe",
  "Cabinet.Agent.Updater/Cabinet.Agent.Updater.exe",
  "Cabinet.Agent.Harness/cabinet-harness.exe",
];

/**
 * Which of the release programs a package does not have, so an upload can be refused here instead of failing on a
 * cabinet. Empty means the package is laid out as a release. The installer bundle the platform serves for a fresh
 * install (CabinetAgent/{install,out}) holds the same programs one level down: it installs a cabinet perfectly well
 * and can never be updated to, so it must not be accepted as a release package.
 */
export function missingReleasePrograms(packageBytes: Buffer): string[] {
  const names = new Set(entries(packageBytes).map(e => e.name.replace(/\\/g, "/")));
  return RELEASE_PROGRAMS.filter(program => !names.has(program));
}
