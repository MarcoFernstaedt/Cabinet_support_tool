// A new site's policies in a pending cabinet's approval (docs/spec/05-server-spec.md "Site policies"). The section shows what the site
// would inherit (its client's firewall policy and zone, else the fleet's) and lets the approver keep it or set the site's own. It shows
// only for a site that does not exist yet; an existing site's policies are changed on its page. The server checks it all again.
import { useEffect, useState } from "react";
import { api, describeError } from "../lib/api";
import { fieldsFrom, inheritedFrom, type Policy, type SitePolicyFields, type SitePolicyPreview, type Switch } from "../lib/site-policies";
import { ZONE_NAMES, zoneName } from "../pages/cabinet/Time";
import { describePolicy } from "./FirewallPolicy";

const PROFILES = [["domain", "Domain"], ["private", "Private"], ["public", "Public"]] as const;

export interface SitePolicyState { preview: SitePolicyPreview | null; problem: string | null; retry: () => void }

/** Reads what a new site would inherit as the client and site are typed, and starts the fields from it. */
export function useSitePolicyPreview(requestId: string, client: string, site: string, setFields: (f: SitePolicyFields) => void): SitePolicyState {
  const [preview, setPreview] = useState<SitePolicyPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const c = client.trim(), s = site.trim();
  useEffect(() => {
    setPreview(null);
    setProblem(null);
    if (!c || !s) return;
    let live = true;
    const t = setTimeout(() => {
      void api<SitePolicyPreview>("GET", `/api/admin/enrollments/${requestId}/site-policies?${new URLSearchParams({ client: c, site: s })}`)
        .then(p => { if (live) { setPreview(p); setFields(fieldsFrom(p)); } })
        .catch(e => { if (live) setProblem(describeError(e)); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [requestId, c, s, setFields, attempt]);
  return { preview, problem, retry: () => setAttempt(a => a + 1) };
}

export function SitePolicyFieldset({ name, site, state, fields, onChange }: {
  name: string; site: string; state: SitePolicyState; fields: SitePolicyFields; onChange: (f: SitePolicyFields) => void;
}) {
  const { preview, problem, retry } = state;
  if (problem) return (
    <p className="error small" role="alert">Could not read what the new site would inherit: {problem}{" "}
      <button type="button" className="btn small" onClick={retry}>Try again</button></p>);
  if (!preview || preview.siteExists) return null;
  const fwFrom = inheritedFrom(preview.firewall.source, "policy")!;
  const zoneFrom = inheritedFrom(preview.timeZone.source, "default zone");
  const setSwitch = (k: keyof Policy, v: Switch) => onChange({ ...fields, firewall: { ...fields.firewall, [k]: v } });
  return (
    <fieldset className="stack" aria-label={`Policies for the new site ${site}`}>
      <legend>Policies for the new site {site}</legend>
      <label><input type="radio" name={`${name}-fw`} checked={!fields.firewallOwn} onChange={() => onChange({ ...fields, firewallOwn: false })} />
        {" "}Firewall: use {fwFrom} ({describePolicy(preview.firewall.policy)})</label>
      <label><input type="radio" name={`${name}-fw`} checked={fields.firewallOwn} onChange={() => onChange({ ...fields, firewallOwn: true })} /> Firewall: set this site&apos;s own</label>
      {fields.firewallOwn && (
        <span className="row gap wrap">
          {PROFILES.map(([k, label]) => (
            <label key={k} className="field inline"><span>{label}</span>
              <select aria-label={`${label} profile`} value={fields.firewall[k]} onChange={e => setSwitch(k, e.target.value as Switch)}><option value="off">Off</option><option value="on">On</option></select></label>))}
        </span>)}
      <label className="field"><span>Time zone</span>
        <select aria-label="New site's time zone" value={fields.timeZone} onChange={e => onChange({ ...fields, timeZone: e.target.value })}>
          <option value="">{preview.timeZone.zone ? `Use ${zoneFrom} (${zoneName(preview.timeZone.zone)})` : "Not set (no zone is checked)"}</option>
          {Object.entries(ZONE_NAMES).map(([z, label]) => <option key={z} value={z}>{label}</option>)}
        </select></label>
      <span className="muted small">The network standard is set on the site page once its cabinets have reported their network.</span>
    </fieldset>
  );
}
