// How the Upgrades screen states one cabinet's place in a rollout (decision-log D80). A skipped cabinet is one of two kinds: out of
// contact (outcome "offline": skipped after a day offline, or offline when the rollout completed), or in contact but not reached before
// the rollout completed (no outcome). Calling the second kind offline would tell the support desk something that is not true.

export type Tone = "ok" | "warn" | "crit" | "info" | "off";
export interface TargetView { state: string; outcome: string | null; check: string | null; message: string | null }

const STATE: Record<string, [Tone, string]> = {
  pending: ["off", "Waiting"], offered: ["info", "Offered"], succeeded: ["ok", "Upgraded"], failed: ["crit", "Failed"],
};

/** The states the Upgrades screen can filter by. "Skipped" covers both kinds: offline, and not reached. */
export const TARGET_FILTERS: readonly [string, string][] = [...Object.entries(STATE).map(([k, [, label]]): [string, string] => [k, label]), ["skipped", "Skipped"]];

export function targetBadge(t: Pick<TargetView, "state" | "outcome">): [Tone, string] {
  if (t.state === "skipped") return ["off", t.outcome === "offline" ? "Skipped (offline)" : "Skipped (not reached)"];
  return Object.hasOwn(STATE, t.state) ? STATE[t.state]! : ["off", t.state];
}

/** The line under the badge: how the upgrade ended, at which check; or, for a cabinet skipped with no outcome, why. Null: nothing to add. */
export function targetNote(t: TargetView, checkName: (check: string) => string): string | null {
  if (t.outcome && t.outcome !== "succeeded")
    return `${t.outcome.replace("_", " ")}${t.check ? ` at the ${checkName(t.check)} check` : ""}: ${t.message ?? ""}`;
  if (t.state === "skipped" && t.message) return t.message;
  return null;
}
