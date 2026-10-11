// The demo's scenario (docs/platform/demo.md): one story, Monday morning at Midtown Manhattan, resolved to the simulated cabinets of the
// current demo fleet. When a real cabinet has been installed, its network read is offered as the last step. Read only.
import type { Queryable } from "../db/db.js";

export interface ScenarioStep { label: string; path: string }
export interface DemoScenario { id: string; title: string; story: string; steps: ScenarioStep[] }

export async function demoScenarios(db: Queryable): Promise<DemoScenario[]> {
  const rows = (await db.query<{ id: string; name: string; scenario: string; site: string; site_id: string }>(
    `SELECT k.id, k.name, k.demo_scenario AS scenario, s.name AS site, s.id AS site_id
       FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE k.demo_scenario IS NOT NULL AND c.demo AND s.name = 'Midtown Manhattan' ORDER BY k.name`)).rows;
  if (rows.length === 0) return [];
  const site = rows[0]!;
  const scanner = rows.find(r => r.scenario === "scanner_flapping");
  const real = (await db.query<{ id: string; name: string }>(
    "SELECT id, name FROM cabinets WHERE demo_scenario IS NULL AND status = 'active' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const examRoom = rows.find(r => r.name === "Exam Room 1"), operating = rows.find(r => r.name === "Operating Room");
  const mapping = (await db.query<{ id: string; name: string }>(
    `SELECT k.id, k.name FROM cabinets k JOIN sites s ON s.id = k.site_id JOIN clients c ON c.id = s.client_id
      WHERE c.demo AND k.demo_scenario = 'scanner_errors' ORDER BY k.name`)).rows;
  const list: DemoScenario[] = [
    { id: "midtown", title: "Monday morning at Midtown Manhattan",
      story: "The exam rooms say they can't sync. Check one cabinet, then the whole site with one click: link, address, gateway and DNS are fine everywhere, and the sync cabinet's firewall is what's blocking the satellites. "
        + "Apply the client's firewall policy with one click, and the site is checked again right away. Operating Room still shows a warning: it matches the baseline, but open its full read and you'll see it loses packets to the gateway and the card is counting errors, so look at the cable. While you're there, Procedure Room's fingerprint scanner has dropped off three times since its driver was installed.",
      steps: [{ label: "The site", path: `/sites/${site.site_id}` },
        ...(examRoom ? [{ label: "One cabinet: Exam Room 1", path: `/cabinets/${examRoom.id}/network` }] : []),
        { label: "The whole site", path: `/sites/${site.site_id}?diagnose=network` },
        ...(operating ? [{ label: "Operating Room's network", path: `/cabinets/${operating.id}/network` }] : []),
        ...(scanner ? [{ label: "Procedure Room's scanner", path: `/cabinets/${scanner.id}/scanner` }] : [])] },
    ...(mapping[0] ? [{ id: "mapping", title: "Errors nobody has named yet",
      story: `${mapping.map(m => m.name).join(" and ")} keep logging errors from the fingerprint reader's driver, and no rule knows those errors, so they show up as unrecognized alerts. `
        + "Map the error to the fingerprint scanner issue once, and every cabinet that logs it is grouped under that issue. Then save what fixed it, with the cabinet's setup, and the next cabinet that shows the same problem comes up with the fix beside it.",
      steps: [{ label: "Unrecognized alerts", path: "/alerts?view=unrecognized" }, { label: `${mapping[0].name}: event logs`, path: `/cabinets/${mapping[0].id}/events` },
        { label: `${mapping[0].name}: alerts`, path: `/cabinets/${mapping[0].id}/alerts` }, { label: "Issues", path: "/issues" }] }] : []),
    ...(real ? [{ id: "real", title: "Your own cabinet",
      story: `${real.name} is a real cabinet running the agent. Its network page reads the adapter, address, DHCP or fixed, gateway and DNS straight from the machine, and Diagnose network checks every layer. No baseline is needed for that, and the site page can set one from this cabinet's own network, along with the site's time zone and firewall policy. With a baseline, the same check also compares against it.`,
      steps: [{ label: `${real.name}: network`, path: `/cabinets/${real.id}/network` }] }] : []),
  ];
  return list;
}
