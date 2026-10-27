// Time zone and clock (docs/spec/13-roadmap.md module 21): what the cabinet reports against its site's zone, Windows
// Time's own status read on demand, and the two fixes, each with a confirmation click (Tier 1 and up): set the site's
// zone (tzutil) and sync the clock (w32tm). The time source is never changed, so Group Policy stays in charge of it.
import { useEffect } from "react";
import type { TimeSetZoneOutput, TimeStatusOutput, TimeSyncOutput } from "@mashura/cabinet-contracts/types";
import { useOperation } from "../../lib/commands";
import { useLoad } from "../../lib/useLoad";
import { fullTime } from "../../lib/time";
import { Badge, KeyValues, OperationPanel, WriteOutcome } from "../../components/ui";
import { Link } from "../../lib/router";
import { useCanWrite, useConfirmedWrite } from "./Writes";
import type { CabinetDetail } from "./CabinetPage";

export interface CabinetTime {
  timeZoneId: string | null; siteTimeZone: string | null; clockSkewSeconds: number | null; zoneWrong: boolean; clockOff: boolean; reportedAt: string | null;
}

/** Plain names for the zones the platform sets. */
export const ZONE_NAMES: Record<string, string> = {
  "Eastern Standard Time": "Eastern", "Central Standard Time": "Central", "Mountain Standard Time": "Mountain (with daylight saving)",
  "US Mountain Standard Time": "Arizona (no daylight saving)", "Pacific Standard Time": "Pacific", "Alaskan Standard Time": "Alaska", "Hawaiian Standard Time": "Hawaii",
};
export const zoneName = (id: string | null) => id === null ? "Not reported" : ZONE_NAMES[id] ? `${ZONE_NAMES[id]} (${id})` : id;

const skewText = (s: number | null) => s === null ? "Not reported" : Math.abs(s) < 1 ? "In step with the server" :
  `${Math.abs(s) >= 120 ? `${Math.round(Math.abs(s) / 60)} minutes` : `${Math.round(Math.abs(s))} seconds`} ${s > 0 ? "fast" : "slow"}`;

export function Time({ cabinet }: { cabinet: CabinetDetail }) {
  const facts = useLoad<CabinetTime>(`/api/cabinets/${cabinet.id}/time`);
  const status = useOperation<TimeStatusOutput>(cabinet.id, "time.status");
  useEffect(() => { void status.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const after = () => { facts.reload(); void status.start(); };
  const setZone = useConfirmedWrite<TimeSetZoneOutput>(cabinet, "time.setZone", r => { if (r.status === "succeeded") after(); });
  const sync = useConfirmedWrite<TimeSyncOutput>(cabinet, "time.sync", r => { if (r.status === "succeeded") after(); });
  const canZone = useCanWrite(cabinet, "time.setZone"), canSync = useCanWrite(cabinet, "time.sync");
  const f = facts.data;
  return (<>
    <section className="panel" aria-labelledby="time-heading">
      <h2 id="time-heading">Time zone and clock</h2>
      {facts.problem && <p className="error" role="alert">{facts.problem}</p>}
      {f && (<>
        <KeyValues rows={[
          ["Cabinet's time zone", <>{zoneName(f.timeZoneId)} {f.zoneWrong && <Badge tone="warn">Not the site's zone</Badge>}</>],
          ["Zone it should use", f.siteTimeZone ? zoneName(f.siteTimeZone) : <>Not set for the site, its client or the fleet. <Link to={`/sites/${cabinet.site.id}`}>Set it on the site</Link> so wrong zones are found.</>],
          ["Clock", <>{skewText(f.clockSkewSeconds)} {f.clockOff && <Badge tone="warn">More than 2 minutes off</Badge>}</>],
          ["Reported", f.reportedAt ? `In the heartbeat at ${fullTime(f.reportedAt)}` : "Not yet"],
        ]} />
        {(f.zoneWrong || f.clockOff) && (
          <ul className="findings">
            {f.zoneWrong && <li className="finding warn"><div className="finding-head"><strong>Wrong time zone</strong> <Badge tone="info">Confirmed</Badge></div>
              <p>The cabinet uses {zoneName(f.timeZoneId)}; its site uses {zoneName(f.siteTimeZone)}. Local times in schedules and logs are off by the difference.</p>
              {canZone && <p><button className="btn primary" onClick={() => setZone.ask({ timeZoneId: f.siteTimeZone },
                <p>Set the time zone to <strong>{zoneName(f.siteTimeZone)}</strong>, the site's zone. The clock itself does not change; only how local time is shown and logged.</p>)}>
                Set to {ZONE_NAMES[f.siteTimeZone!] ?? f.siteTimeZone}</button></p>}
            </li>}
            {f.clockOff && <li className="finding warn"><div className="finding-head"><strong>Clock is off</strong> <Badge tone="info">Confirmed</Badge></div>
              <p>The clock is {skewText(f.clockSkewSeconds)} against the server. Sync it now; if it drifts again, check Windows Time and its source below.</p>
              {canSync && <p><button className="btn primary" onClick={() => sync.ask({},
                <p>Ask Windows Time to synchronize the clock now with its configured source. The source is not changed.</p>)}>Sync the clock</button></p>}
            </li>}
          </ul>)}
        <WriteOutcome run={setZone.run} done={o => <>Time zone changed from {zoneName(o.before)} to {zoneName(o.after)}. The next heartbeat confirms it.</>} />
        <WriteOutcome run={sync.run} done={o => <>{o.message}{o.lastSuccessfulSyncAfter && <> Last successful sync: {fullTime(o.lastSuccessfulSyncAfter)}.</>}</>} />
        {setZone.dialog}{sync.dialog}
      </>)}
    </section>
    <OperationPanel title="Windows Time on the cabinet"
      run={status} onRun={() => void status.start()}>
      {out => (<>
        <KeyValues rows={[
          ["Time zone", `${out.timeZoneName} (${out.timeZoneId})`],
          ["Local time", `${out.localTime.replace("T", " ")}${out.daylightSavingNow ? " (daylight saving)" : ""}`],
          ["UTC offset", `${out.utcOffsetMinutes >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(out.utcOffsetMinutes) / 60)).padStart(2, "0")}:${String(Math.abs(out.utcOffsetMinutes) % 60).padStart(2, "0")}`],
          ["Windows Time", <Badge tone={out.timeService === "running" ? "ok" : "warn"}>{out.timeService.replaceAll("_", " ")}</Badge>],
          ["Source", out.sync.source ?? "Unknown"],
          ["Last successful sync", out.sync.state === "never_synced" ? <Badge tone="warn">Never</Badge> : out.sync.lastSuccessfulSync ? fullTime(out.sync.lastSuccessfulSync) : "Unknown"],
          ["Set by Group Policy", out.policyManaged ? "Yes: the source comes from policy" : "No"],
        ]} />
        {canSync && !(f?.clockOff) && <p><button className="btn" onClick={() => sync.ask({}, <p>Ask Windows Time to synchronize the clock now with its configured source.</p>)}>Sync the clock</button></p>}
      </>)}
    </OperationPanel>
  </>);
}
