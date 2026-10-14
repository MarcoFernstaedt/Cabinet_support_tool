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
  const reception = rows.find(r => r.name === "Reception");
  const list: DemoScenario[] = [
    { id: "midtown", title: "Midtown Manhattan: site-wide sync failure",
      story: "Exam rooms report sync failures. Single-cabinet and site-wide network diagnosis show link through DNS passing everywhere and the sync cabinet's firewall blocking the satellites; the client's firewall policy is applied in one step and the site is re-checked. "
        + "Operating Room matches its baseline but loses packets to the gateway and counts adapter errors. Procedure Room's scanner dropped three times after a driver install. Reception and Waiting Room log driver errors no rule recognizes: map them to the scanner issue and approve the fix a teammate saved. "
        + "The sequence ends by enrolling a live agent and reading its network.",
      steps: [{ label: "The site", path: `/sites/${site.site_id}` },
        ...(examRoom ? [{ label: "One cabinet: Exam Room 1", path: `/cabinets/${examRoom.id}/network` }] : []),
        { label: "The whole site", path: `/sites/${site.site_id}?diagnose=network` },
        ...(operating ? [{ label: "Operating Room's network", path: `/cabinets/${operating.id}/network` }] : []),
        ...(scanner ? [{ label: "Procedure Room's scanner", path: `/cabinets/${scanner.id}/scanner` }] : []),
        { label: "Unrecognized errors", path: "/alerts?view=unrecognized" },
        ...(reception ? [{ label: "Reception: event logs", path: `/cabinets/${reception.id}/events?log=System` }, { label: "Reception: alerts", path: `/cabinets/${reception.id}/alerts` }] : []),
        { label: "Known fixes", path: "/fixes" }] },
    ...(real ? [{ id: "real", title: "Your own cabinet",
      story: `${real.name} is a real cabinet running the agent. Its network page reads the adapter, address, DHCP or fixed, gateway and DNS straight from the machine, and Diagnose network checks every layer. No baseline is needed for that, and the site page can set one from this cabinet's own network, along with the site's time zone and firewall policy. With a baseline, the same check also compares against it.`,
      steps: [{ label: `${real.name}: network`, path: `/cabinets/${real.id}/network` }] }] : []),
  ];
  return list;
}
