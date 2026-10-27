// A new site's policies in its first approval (docs/spec/05-server-spec.md "Site policies"): pre-filled from what the site would inherit,
// confirmed or changed by the approver. Keeping the inherited value sends null, so the site follows its client (else the fleet) later too;
// only a value the approver sets becomes the site's own. The server checks it all again.

export type Switch = "on" | "off";
export type Policy = { domain: Switch; private: Switch; public: Switch };

/** What GET /api/admin/enrollments/:id/site-policies answers. */
export interface SitePolicyPreview {
  siteExists: boolean;
  firewall: { policy: Policy; source: "client" | "fleet" };
  timeZone: { zone: string | null; source: "client" | "fleet" | null };
}

/** The approver's choices: keep what is inherited, or set the site's own. */
export interface SitePolicyFields { firewallOwn: boolean; firewall: Policy; timeZone: string }

export const fieldsFrom = (p: SitePolicyPreview): SitePolicyFields => ({ firewallOwn: false, firewall: p.firewall.policy, timeZone: "" });

/** The approval's sitePolicies, or nothing for a site that already exists (its policies are changed on its page). */
export function sitePoliciesFrom(preview: SitePolicyPreview | null, f: SitePolicyFields): { firewall: Policy | null; timeZone: string | null } | undefined {
  if (!preview || preview.siteExists) return undefined;
  return { firewall: f.firewallOwn ? f.firewall : null, timeZone: f.timeZone || null };
}

const FROM: Record<string, string> = { client: "the client's", fleet: "the fleet's" };
/** "the client's policy", "the fleet's default zone", for the sentences the approval shows. */
export const inheritedFrom = (source: string | null, what: string) => source ? `${FROM[source] ?? source} ${what}` : null;
