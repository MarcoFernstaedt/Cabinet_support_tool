// Which PowerShell the operator is about to run the installer in, the line they paste for it, and how they find out
// which one they have; and which Windows the machine itself runs, which decides the package they download.
//
// A cabinet is set up by hand on the machine itself, so the console hands over the exact command to paste. Windows
// always ships Windows PowerShell 5.1 and only some machines have PowerShell 7, so the line is built for the engine
// the operator picks, and "What PowerShell version am I on?" walks them to the answer: nobody should have to guess.
// The installer runs on either engine (agent/install/Install-CabinetAgent.ps1 avoids everything 5.1 lacks and is
// parsed with 5.1's own grammar before release), so the choice only changes which program the line starts.
//
// The architecture choice is not a preference the way the engine is: Windows cannot run a 64-bit program on 32-bit
// Windows, so the agent is built once per architecture and the page has to hand over the machine's own package
// (docs/platform/second-architecture.md). It is offered the same way the engine is, with its own "Which Windows am
// I on?" help, and the installer refuses a package built for the other architecture rather than half-install it.

export type InstallEngine = "windows" | "pwsh";

export type EngineInfo = {
  id: InstallEngine;
  /** The name Windows gives this engine, in its own Start menu and documentation. */
  label: string;
  /** The program the pasted command starts. */
  exe: string;
  note: string;
};

export const INSTALL_ENGINES: readonly EngineInfo[] = [
  { id: "windows", label: "Windows PowerShell 5.1", exe: "powershell.exe", note: "On every Windows 10 and 11 machine. Nothing to install." },
  { id: "pwsh", label: "PowerShell 7", exe: "pwsh.exe", note: "Only where it was installed separately (winget install Microsoft.PowerShell)." },
];

/** Windows PowerShell is the one every machine certainly has, so it is what the page offers first. */
export const DEFAULT_INSTALL_ENGINE: InstallEngine = "windows";

export function engineInfo(engine: InstallEngine): EngineInfo {
  return INSTALL_ENGINES.find(e => e.id === engine) ?? INSTALL_ENGINES[0]!;
}

/**
 * Which Windows the machine in front of the operator runs. The agent is built once per architecture because Windows
 * cannot run a 64-bit program on 32-bit Windows, so the package the page hands over has to be the machine's own, and
 * the installer refuses a package built for the other one rather than half-install it (docs/platform/second-architecture.md).
 */
export type InstallArchitecture = "windows-x64" | "windows-x86";

export type ArchitectureInfo = {
  id: InstallArchitecture;
  /** What the machine's own Windows calls itself. */
  label: string;
  /** The package the console serves for this architecture. */
  packageName: string;
  note: string;
};

export const INSTALL_ARCHITECTURES: readonly ArchitectureInfo[] = [
  { id: "windows-x64", label: "64-bit Windows", packageName: "CabinetAgent-win-x64.zip", note: "Almost every Windows 11 machine, and every Windows machine built in the last decade." },
  { id: "windows-x86", label: "32-bit Windows", packageName: "CabinetAgent-win-x86.zip", note: "Older and low-power machines, including the ones that call themselves Windows 10 32-bit." },
];

/** 64-bit is what almost every machine is, so it is what the page offers first. */
export const DEFAULT_INSTALL_ARCHITECTURE: InstallArchitecture = "windows-x64";

export function architectureInfo(architecture: InstallArchitecture): ArchitectureInfo {
  return INSTALL_ARCHITECTURES.find(a => a.id === architecture) ?? INSTALL_ARCHITECTURES[0]!;
}

/**
 * The exact line to paste, for one engine. Both engines are the same installer with the same arguments.
 *
 * One paste does the whole handover, including the parts that used to be manual. The browser drops the package,
 * `token.txt` and `platform-ca.pem` in Downloads, and the operator has not unzipped anything: the first line unpacks
 * the package into a temp folder and puts the two files the installer reads beside it, the second goes there, and the
 * third runs the installer. Each step is its own line, so a paste that loses one fails at the step it lost instead of
 * half-installing.
 */
export function installCommand(o: { host?: string | null; port?: number | null; caSha256?: string | null; engine: InstallEngine; architecture?: InstallArchitecture; unsigned?: boolean; packageName?: string | null }): string {
  const args = [
    `-PlatformServerHost ${o.host || "<server>"}`,
    `-PlatformServerPort ${o.port ?? 8443}`,
    "-PlatformCaFile .\\platform-ca.pem",
    `-PlatformCaSha256 ${o.caSha256 || "<the SHA-256 the console shows>"}`,
    "-BootstrapTokenFile .\\token.txt",
  ];
  if (o.unsigned) args.push("-AllowUnsigned");
  const packageName = o.packageName || architectureInfo(o.architecture ?? DEFAULT_INSTALL_ARCHITECTURE).packageName;
  return [
    `$p="$HOME\\Downloads\\${packageName}"; $s="$env:TEMP\\CabinetAgent-install"; Remove-Item -Recurse -Force $s -ErrorAction SilentlyContinue; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($p,$s); Copy-Item -Force "$HOME\\Downloads\\token.txt","$HOME\\Downloads\\platform-ca.pem" $s`,
    "cd $s",
    `${engineInfo(o.engine).exe} -NoProfile -ExecutionPolicy Bypass -File .\\install\\Install-CabinetAgent.ps1 ${args.join(" ")}`,
  ].join("\n");
}

/** What the operator is told to do, and how to read what they see back. */
export const VERSION_HELP = {
  title: "What PowerShell version am I on?",
  steps: [
    "Press the Windows key and type PowerShell.",
    "Right-click the result and choose Run as administrator.",
    "In the window that opens, type $PSVersionTable.PSVersion and press Enter.",
  ],
  read: [
    { when: "5.1.x", means: "Windows PowerShell, the one Windows comes with. Choose Windows PowerShell 5.1 above." },
    { when: "7.x", means: "PowerShell 7. Choose PowerShell 7 above. (6.x runs the same way: pwsh.)" },
  ],
  notes: [
    "The install window has to be an administrator window whichever engine you pick. Windows 11 names it Terminal (Admin): open it, then pick Windows PowerShell from the dropdown beside the + tab.",
    "If the window answers that pwsh is not recognized, PowerShell 7 is not installed on that machine. Use Windows PowerShell; the installer is written for it as well.",
    "Both engines install exactly the same agent. The version you pick only changes which program the pasted line starts.",
  ],
};

/**
 * How the operator finds out which Windows the machine itself runs, asked of the machine rather than of the shell:
 * `$env:PROCESSOR_ARCHITECTURE` answers x86 from a 32-bit PowerShell even on 64-bit Windows, which is exactly the
 * wrong answer here, so the line asks Windows itself.
 */
export const ARCHITECTURE_HELP = {
  title: "Which Windows am I on?",
  steps: [
    "Press the Windows key and type PowerShell.",
    "Right-click the result and choose Run as administrator.",
    "In the window that opens, type (Get-CimInstance Win32_OperatingSystem).OSArchitecture and press Enter.",
  ],
  read: [
    { when: "64-bit", means: "64-bit Windows. Choose 64-bit Windows above." },
    { when: "32-bit", means: "32-bit Windows. Choose 32-bit Windows above." },
  ],
  notes: [
    "The agent's programs are built once per architecture, because Windows cannot run a 64-bit program on 32-bit Windows; the installer refuses a package built for the other architecture rather than half-install it. The right one here is the only one that installs at all.",
    "Read the answer from the machine, not from the shell: a 32-bit PowerShell on 64-bit Windows reports x86 for $env:PROCESSOR_ARCHITECTURE, and that would send you to the wrong package.",
    "The command works in either engine, so it can be run in the same window you are about to install from.",
  ],
};

/**
 * Reads the answer to `(Get-CimInstance Win32_OperatingSystem).OSArchitecture` the way it appears in the window, so
 * the operator can be told which architecture they are looking at instead of having to interpret it. Anything that
 * does not name one of the two comes back as null rather than a guess — in particular "x86", which is the answer a
 * 32-bit shell gives on a 64-bit machine and the wrong answer to this question.
 */
export function architectureFromText(text: string): InstallArchitecture | null {
  const t = (text ?? "").toLowerCase();
  if (/\b64\s*-\s*bit\b/.test(t)) return "windows-x64";
  if (/\b32\s*-\s*bit\b/.test(t)) return "windows-x86";
  return null;
}

/**
 * Reads the answer to `$PSVersionTable.PSVersion` the way it appears in the window, so the operator can be told
 * which engine they are looking at instead of having to interpret it. Anything that is not a PowerShell version
 * (a Windows build number, say) comes back as null rather than a guess.
 */
export function engineFromVersionText(text: string): InstallEngine | null {
  const m = /\d+(?:\.\d+)*/.exec(text ?? "");
  if (!m) return null;
  const major = Number(m[0].split(".")[0]);
  if (!Number.isInteger(major)) return null;
  if (major === 5) return "windows";
  if (major === 6 || major === 7) return "pwsh";
  return null;
}
