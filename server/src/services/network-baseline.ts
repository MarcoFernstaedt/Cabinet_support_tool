// A site's network baseline (docs/spec/14-network-troubleshooting.md): what its network should look like. Setting it changes
// nothing on a cabinet; the network diagnosis compares each cabinet with it and offers the fixes. Tier 2 and up, with an
// authenticator code bound to the exact baseline.
import type pg from "pg";
import { audit, safeJson, transaction } from "../db/db.js";
import { consumeStepUpToken } from "../auth/stepup.js";
import { Refused } from "./errors.js";
import type { NetworkBaseline } from "../diagnose/network-findings.js";

export async function setNetworkBaseline(pool: pg.Pool, userId: string, siteId: string, baseline: NetworkBaseline | null, stepUpToken?: string): Promise<void> {
  await transaction(pool, async c => {
    if (stepUpToken) await consumeStepUpToken(c, stepUpToken, userId, "site.network_baseline", siteId, { baseline });
    const r = await c.query<{ before: NetworkBaseline | null }>(
      "UPDATE sites n SET network_baseline = $2 FROM sites o WHERE n.id = $1 AND o.id = n.id AND n.removed_at IS NULL RETURNING o.network_baseline AS before",
      [siteId, baseline === null ? null : safeJson(baseline)]);
    if (r.rowCount !== 1) throw new Refused("not_found", 404, "no such site");
    await audit(c, { actorKind: "user", actorId: userId, action: "site.network_baseline", targetKind: "site", targetId: siteId, outcome: "succeeded",
      details: { before: r.rows[0]!.before, baseline } });
  });
}
