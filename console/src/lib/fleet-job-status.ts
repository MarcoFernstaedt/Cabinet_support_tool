// Where a fleet job is, as the job page shows it (fleet audit finding 6, decision-log D83). A cancelled job is not over at once: the batch
// already sent finishes and is still verified, and the job ends (gets its finish time) only after that. Until then the page keeps
// following it and says so, instead of showing "Cancelled" over cabinets still marked "Sent".

export interface JobView { state: string; finishedAt: string | null; counts: Readonly<Record<string, unknown>> }
export type JobPhase = "running" | "cancelling" | "cancelled" | "finished";

/** The cabinets of a job still being worked on: sent and not answered, or answered and not yet verified. */
export function stillSent(counts: Readonly<Record<string, unknown>> | null | undefined): number {
  const n = (k: string) => { const v = counts?.[k]; return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0; };
  return n("issued") + n("succeeded");
}

export function jobPhase(j: JobView): JobPhase {
  if (j.state === "running") return "running";
  if (j.state === "cancelled") return j.finishedAt ? "cancelled" : "cancelling";
  return "finished";
}

/** Whether the page should keep fetching the job: while it runs, and while a cancelled job finishes what it had already sent. */
export const keepFollowing = (j: JobView | null | undefined): boolean => !!j && (jobPhase(j) === "running" || jobPhase(j) === "cancelling");

export function phaseText(j: JobView): string {
  const p = jobPhase(j);
  if (p === "running") return "Running";
  if (p === "finished") return "Finished";
  if (p === "cancelled") return "Cancelled";
  const n = stillSent(j.counts);
  return n === 0 ? "Cancelling: ending the job" : `Cancelling: finishing the ${n === 1 ? "cabinet" : `${n} cabinets`} already sent`;
}
