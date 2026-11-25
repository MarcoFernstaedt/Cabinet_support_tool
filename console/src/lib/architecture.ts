// A cabinet's architecture, as the console says it (docs/spec/18-built-designs.md §1).
//
// The value on the wire is what the agent reports about its own programs: "windows-x64" or "windows-x86"
// (contracts/schemas/common.schema.json#/$defs/architecture). The console says it in the words an operator uses, and it
// says nothing at all when a cabinet has not reported one: that is an agent built before architectures were reported,
// and guessing from the operating system's name is exactly the mistake that would put the wrong package on a machine.
export type CabinetArchitecture = "windows-x64" | "windows-x86";

/** Whether a value from outside the console is one of the two architectures it knows about. */
export function isCabinetArchitecture(value: unknown): value is CabinetArchitecture {
  return value === "windows-x64" || value === "windows-x86";
}

/** "64-bit" / "32-bit", or null when the cabinet has reported no architecture. */
export function architectureLabel(value: string | null | undefined): string | null {
  if (value === "windows-x64") return "64-bit";
  if (value === "windows-x86") return "32-bit";
  return null;
}

/** The long form for the cabinet page, where there is room to explain what the value means. */
export function architectureDetail(value: string | null | undefined): string {
  if (value === "windows-x64") return "64-bit Windows (windows-x64)";
  if (value === "windows-x86") return "32-bit Windows (windows-x86)";
  return "not reported — this agent was built before cabinets reported one, which means 64-bit Windows";
}

/**
 * One line for a table cell or a list: "64-bit Windows", "32-bit Windows", or a plain statement that nobody has
 * recorded one. It never falls back to a claim: an operator reading the wrong architecture here is exactly how the
 * wrong package ends up on a machine.
 */
export function architectureLine(value: string | null | undefined): string {
  return architectureLabel(value) ? `${architectureLabel(value)} Windows` : "architecture not recorded";
}
