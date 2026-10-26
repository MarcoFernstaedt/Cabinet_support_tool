// The operations that touch a running program or decide whether one runs - service.control, service.setStartType and process.end -
// aim only at what the cabinet's approved-applications list names, whichever route asked for them (docs/spec/13-roadmap.md milestone
// 10). A start type decides what Windows starts at the next boot, so changing one (raising or lowering it) is control too.
//
// Why the server checks this for every route and not only for the control route: an agent built before the list existed enforces
// nothing, so a generic command naming any service or any process ID would be carried out. The server is the one place every request
// passes, so the rule lives here: a service is controlled only when an entry of the list that applies to this cabinet carries its
// service name; a process is ended only when the cabinet's own last report shows that ID running the exact program an entry approves.
// A cabinet with no list, or whose list was rejected, controls nothing.
import type { Queryable } from "../db/db.js";
import { appLevels, entryPath } from "./approved-apps.js";
import { Refused } from "./errors.js";
import { latestReading } from "./readings.js";

/** The operations that need an approved target and, whatever the catalog's confirmation level, a step-up code bound to the parameters. */
export const CONTROLLED_OPERATIONS: ReadonlySet<string> = new Set(["service.control", "service.setStartType", "process.end"]);

/** One process as the cabinet itself last reported it (operations/processes.list.schema.json). The path may be missing: Windows does not give one for every process. */
export interface ReportedProcess {
  processId: number;
  name: string;
  executablePath: string | null;
}

/** One service as the cabinet itself last reported it (operations/services.list.schema.json). */
export interface ReportedService {
  name: string;
  state: string;
}

/** The process list this cabinet last reported, or null when it has never reported one. Rows that are not a process at all are dropped, so a hand-edited reading cannot steer a pid. */
export async function reportedProcesses(db: Queryable, cabinetId: string): Promise<{ at: string; processes: ReportedProcess[] } | null> {
  const reading = await latestReading(db, cabinetId, "processes.list");
  if (!reading) return null;
  const rows = (reading.output as { processes?: unknown }).processes;
  if (!Array.isArray(rows)) return { at: reading.at, processes: [] };
  const processes: ReportedProcess[] = [];
  for (const raw of rows) {
    const p = raw as { processId?: unknown; name?: unknown; executablePath?: unknown };
    if (typeof p.processId !== "number" || !Number.isInteger(p.processId) || p.processId < 1) continue;
    if (typeof p.name !== "string" || p.name.length === 0) continue;
    processes.push({ processId: p.processId, name: p.name, executablePath: typeof p.executablePath === "string" ? p.executablePath : null });
  }
  return { at: reading.at, processes };
}

/** The service list this cabinet last reported, or null when it has never reported one. */
export async function reportedServices(db: Queryable, cabinetId: string): Promise<{ at: string; services: ReportedService[] } | null> {
  const reading = await latestReading(db, cabinetId, "services.list");
  if (!reading) return null;
  const rows = (reading.output as { services?: unknown }).services;
  if (!Array.isArray(rows)) return { at: reading.at, services: [] };
  const services: ReportedService[] = [];
  for (const raw of rows) {
    const s = raw as { name?: unknown; state?: unknown };
    if (typeof s.name !== "string" || s.name.length === 0) continue;
    services.push({ name: s.name, state: typeof s.state === "string" ? s.state : "unknown" });
  }
  return { at: reading.at, services };
}

/**
 * Refuses a service.control or process.end whose target is not on the list that applies to this cabinet. Any other operation passes
 * untouched. The parameters have already been checked against the operation's schema.
 */
export async function assertApprovedTarget(db: Queryable, cabinetId: string, operation: string, params: Record<string, unknown>): Promise<void> {
  if (!CONTROLLED_OPERATIONS.has(operation)) return;
  const levels = await appLevels(db, cabinetId);
  const entries = levels.effective?.entries ?? [];
  if (operation === "service.control" || operation === "service.setStartType") {
    // Windows compares service key names without regard to case, so the list does too.
    const name = typeof params.name === "string" ? params.name.toLowerCase() : "";
    if (!entries.some(e => e.kind === "service" && e.serviceName !== null && e.serviceName.toLowerCase() === name))
      throw new Refused("control_entry_not_approved", 403, "that service is not on this cabinet's approved-applications list");
    return;
  }
  const reported = await reportedProcesses(db, cabinetId);
  if (!reported) throw new Refused("control_process_no_reading", 409, "this cabinet has never reported its processes, so the process cannot be checked against its approved list");
  const row = reported.processes.find(p => p.processId === params.processId);
  if (!row || row.name !== params.name)
    throw new Refused("control_process_unreported", 404, "the cabinet's own process list has no such process ID with that name");
  // Windows compares paths without regard to case, and so does the cabinet (ApprovedApps.ForProgram).
  const reportedPath = row.executablePath?.toLowerCase() ?? null;
  if (reportedPath === null || !entries.some(e => entryPath(e).toLowerCase() === reportedPath))
    throw new Refused("control_process_not_approved", 403, "the program the cabinet reports under that process ID is not on its approved-applications list");
}
