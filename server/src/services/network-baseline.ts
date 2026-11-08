// A site's network baseline (docs/spec/16-network-troubleshooting.md): what its network should look like. Setting it changes
// nothing on a cabinet; the network diagnosis compares each cabinet with it and offers the fixes. Tier 2 and up, with an
// authenticator code bound to the exact baseline.
import { audit, safeJson, transaction, type Pool, type Queryable } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";
import type { NetworkBaseline } from "../diagnose/network-findings.js";

export async function setNetworkBaseline(pool: Pool, userId: string, siteId: string, baseline: NetworkBaseline | null, stepUpToken?: string): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken) await consumeStepUpToken(c, stepUpToken, userId, "site.network_baseline", siteId, { baseline });
    await writeNetworkBaseline(c, userId, siteId, baseline);
  });
}

/** Writes a site's network baseline in the caller's transaction (the caller checked the role and any code), and audits it. */
export async function writeNetworkBaseline(c: Queryable, userId: string, siteId: string, baseline: NetworkBaseline | null): Promise<void> {
  const r = await c.query<{ network_baseline: NetworkBaseline | null }>("SELECT network_baseline FROM sites WITH (UPDLOCK, ROWLOCK) WHERE id = $1 AND removed_at IS NULL", [siteId]);
  if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
  await c.query("UPDATE sites SET network_baseline = $2 WHERE id = $1", [siteId, baseline === null ? null : safeJson(baseline)]);
  await audit(c, { actorKind: "user", actorId: userId, action: "site.network_baseline", targetKind: "site", targetId: siteId, outcome: "succeeded",
    details: { before: r.rows[0]!.network_baseline, baseline } });
}
