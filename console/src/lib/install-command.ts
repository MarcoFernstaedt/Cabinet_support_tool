// Which Windows a package is built for. The agent is built once per architecture because Windows cannot run a 64-bit
// program on 32-bit Windows. Installing needs no choice: the installer the setup
// page makes picks the package for the machine's own Windows. The upgrades page still names a release's architecture.

/** Which Windows a package or release is built for. */
export type InstallArchitecture = "windows-x64" | "windows-x86";

export type ArchitectureInfo = {
  id: InstallArchitecture;
  /** What the machine's own Windows calls itself. */
  label: string;
  /** The package the console serves for this architecture. */
  packageName: string;
};

export const INSTALL_ARCHITECTURES: readonly ArchitectureInfo[] = [
  { id: "windows-x86", label: "32-bit Windows", packageName: "CabinetAgent-win-x86.zip" },
  { id: "windows-x64", label: "64-bit Windows", packageName: "CabinetAgent-win-x64.zip" },
];

/** Where nothing else says which, a release is taken to be 64-bit: every release before 32-bit builds existed was. */
export const DEFAULT_INSTALL_ARCHITECTURE: InstallArchitecture = "windows-x64";

export function architectureInfo(architecture: InstallArchitecture): ArchitectureInfo {
  return INSTALL_ARCHITECTURES.find(a => a.id === architecture) ?? INSTALL_ARCHITECTURES[1]!;
}
