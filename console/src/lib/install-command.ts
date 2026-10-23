// Which PowerShell the operator is about to run the installer in, the line they paste for it, and how they find out
// which one they have.
//
// A cabinet is set up by hand on the machine itself, so the console hands over the exact command to paste. Windows
// always ships Windows PowerShell 5.1 and only some machines have PowerShell 7, so the line is built for the engine
// the operator picks, and "What PowerShell version am I on?" walks them to the answer: nobody should have to guess.
// The installer runs on either engine (agent/install/Install-CabinetAgent.ps1 avoids everything 5.1 lacks and is
// parsed with 5.1's own grammar before release), so the choice only changes which program the line starts.

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
 * The exact line to paste, for one engine. Both engines are the same installer with the same arguments.
 *
 * One paste does the whole handover, including the parts that used to be manual. The browser drops the package,
 * `token.txt` and `platform-ca.pem` in Downloads, and the operator has not unzipped anything: the first line unpacks
 * the package into a temp folder and puts the two files the installer reads beside it, the second goes there, and the
 * third runs the installer. Each step is its own line, so a paste that loses one fails at the step it lost instead of
 * half-installing.
 */
export function installCommand(o: { host?: string | null; port?: number | null; caSha256?: string | null; engine: InstallEngine; unsigned?: boolean; packageName?: string | null }): string {
  const args = [
    `-PlatformServerHost ${o.host || "<server>"}`,
    `-PlatformServerPort ${o.port ?? 8443}`,
    "-PlatformCaFile .\\platform-ca.pem",
    `-PlatformCaSha256 ${o.caSha256 || "<the SHA-256 the console shows>"}`,
    "-BootstrapTokenFile .\\token.txt",
  ];
  if (o.unsigned) args.push("-AllowUnsigned");
  const packageName = o.packageName || "CabinetAgent-win-x64.zip";
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
