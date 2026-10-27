// The baseline decision an approval carries (docs/spec/15-baselines-and-config.md "Baselines at enrollment"), built from what the approver
// chose. The server checks it again: whether a baseline really applies, and whether the one to attach is approved.

export type BaselineChoice = "" | "inherited" | "attach" | "capture";
export type BaselineDecision = { use: "inherited" } | { use: "attach"; versionId: string } | { use: "capture" };

/** What GET /api/admin/enrollments/:id/baseline answers for a client and site. */
export interface BaselinePreview {
  inForce: { kind: string; name: string; version: number }[];
  modelBaselines: number;
  siteHasOwn: boolean;
  choices: { versionId: string; version: number; scope: string; name: string }[];
}

/** The decision, or null while it is incomplete (nothing chosen, or "attach" without a version). */
export function decisionFrom(choice: BaselineChoice, attachId: string): BaselineDecision | null {
  if (choice === "attach") return attachId ? { use: "attach", versionId: attachId } : null;
  return choice ? { use: choice } : null;
}

/**
 * The choice to show once the preview arrives: a baseline in force is the default, and "use the one in force" is no longer offered when
 * none applies (the client or site changed). A choice the approver made otherwise stands.
 */
export function choiceAfterPreview(current: BaselineChoice, preview: BaselinePreview): BaselineChoice {
  if (preview.inForce.length > 0) return current === "" ? "inherited" : current;
  if (current === "inherited") return "";
  if (current === "attach" && preview.siteHasOwn) return "";
  return current;
}

const LEVEL: Record<string, string> = { global: "the fleet", model: "the cabinet model", client: "the client", site: "the site", cabinet: "the cabinet" };

/** "Judged against Ward standard v3 (the client's baseline)", for the baselines in force, widest first. */
export function inForceText(inForce: BaselinePreview["inForce"]): string {
  if (inForce.length === 0) return "No approved baseline applies";
  return "Judged against " + inForce.map(o => `${o.name} v${o.version} (${LEVEL[o.kind] ?? o.kind})`).join(", then ");
}
