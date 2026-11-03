// Who closed a security alert, in words. An alert the platform closed itself (no recurrence within the window, decision D14)
// has no person: before, the page printed "Closed by" with nothing after it.

/** Names the person who closed it, or says the platform closed it. */
export function closedByText(resolvedBy: string | null | undefined): string {
  const who = typeof resolvedBy === "string" ? resolvedBy.trim() : "";
  return who ? `Closed by ${who}` : "Closed automatically by the platform";
}
