// The warning every change on a sync cabinet carries in its confirmation (docs/spec/13-roadmap.md module 37, the owner's decision): which
// satellites depend on it, so a person changing it knows who loses sync if the change takes it offline. A warning only: the confirmation
// level is the operation's own, and the server decides what is allowed.

/** The sentence for a sync cabinet with satellites, or null when nothing depends on it. `names` holds at most the first few by name. */
export function syncWarning(count: number, names: readonly string[]): string | null {
  if (count <= 0) return null;
  const shown = names.slice(0, Math.min(names.length, count));
  const more = count - shown.length;
  const list = shown.length === 0 ? "" : ` (${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""})`;
  return `This is the sync cabinet for ${count} ${count === 1 ? "satellite" : "satellites"}${list}. If this change takes it offline, ${count === 1 ? "that satellite loses" : "they lose"} sync until it is back.`;
}
