// What one server process does (F21.R3, decision-log D60). The platform has three parts: the agent API (cabinets connect to it), the
// console API (people), and the background jobs. One process can run all three, as before, or a deployment can run them apart, from the
// same build, by giving each process its SERVER_ROLES. They share nothing in memory: commands and results travel through the database and
// its notifications table, and every job takes a lease before it runs (F21.R1), so any number of processes can run side by side and each
// part can be restarted on its own.
export const SERVER_ROLES = ["agent", "console", "jobs"] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

/** SERVER_ROLES: a comma-separated list of agent, console and jobs; unset means all three. Anything else stops the server at start. */
export function parseRoles(value: string | undefined): ReadonlySet<ServerRole> {
  if (value === undefined || value.trim() === "") return new Set(SERVER_ROLES);
  const parts = value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) throw new Error("SERVER_ROLES names no role: give agent, console, jobs, or a comma-separated list of them.");
  for (const p of parts)
    if (!(SERVER_ROLES as readonly string[]).includes(p)) throw new Error(`SERVER_ROLES names "${p.slice(0, 40)}", which is not a role: use agent, console or jobs.`);
  return new Set(parts as ServerRole[]);
}

export interface ProcessPlan {
  /** This process answers cabinets on the agent API port. */
  servesAgents: boolean;
  /** This process forks the agent API workers (AGENT_API_WORKERS above 1) and serves no agents itself. */
  forksAgentWorkers: boolean;
  runsConsole: boolean;
  runsJobs: boolean;
}

/**
 * What this process runs. With AGENT_API_WORKERS above 1 the agent API runs in forked workers sharing its port, and the primary process
 * runs the console and the jobs (when it has those roles); a worker only ever serves agents.
 */
export function processPlan(roles: ReadonlySet<ServerRole>, workers: number, isPrimary: boolean): ProcessPlan {
  const agent = roles.has("agent");
  return {
    servesAgents: agent && (workers === 1 || !isPrimary),
    forksAgentWorkers: agent && workers > 1 && isPrimary,
    runsConsole: roles.has("console") && isPrimary,
    runsJobs: roles.has("jobs") && isPrimary,
  };
}
