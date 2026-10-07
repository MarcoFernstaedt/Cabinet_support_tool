// Who may change a cabinet, and whether changes are paused. Showing or hiding controls only:
// the server checks the role, the step-up token, every pause, the user's limit and read-only
// cabinets again on every write, and the agent refuses writes on a read-only cabinet itself.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { atLeast, type Me } from "./session";

export interface WriteStatus {
  fleet: { paused: boolean; reason: string | null };
  clients: { id: string; name: string; reason: string | null }[];
}

const WriteStatusContext = createContext<{ status: WriteStatus | null; reload: () => void }>({ status: null, reload: () => undefined });

export function WriteStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WriteStatus | null>(null);
  const reload = useCallback(() => { api<WriteStatus>("GET", "/api/writes/status", undefined, { background: true }).then(setStatus, () => undefined); }, []);
  useEffect(() => { reload(); const t = setInterval(reload, 60_000); return () => clearInterval(t); }, [reload]);
  return <WriteStatusContext.Provider value={{ status, reload }}>{children}</WriteStatusContext.Provider>;
}

export const useWriteStatus = () => useContext(WriteStatusContext);

/** True when this person may see write controls for this cabinet right now. */
export function canWrite(me: Me, cabinet: { readOnly: boolean | null; client: { id: string } }, status: WriteStatus | null): boolean {
  if (!atLeast(me, "tier2") || cabinet.readOnly !== false) return false;
  if (status?.fleet.paused || status?.clients.some(c => c.id === cabinet.client.id)) return false;
  return true;
}

/** The banner on every page while writes are paused fleet-wide, and on a client's pages while that client is paused. */
export function WritePauseBanner({ clientId, clientOnly = false }: { clientId?: string; clientOnly?: boolean }) {
  const { status } = useWriteStatus();
  if (!status) return null;
  if (status.fleet.paused && clientOnly) return null; // the page-wide banner already says so
  if (status.fleet.paused)
    return <div className="banner crit" role="status"><strong>Changes to cabinets are paused fleet-wide.</strong> Diagnostics still work.{status.fleet.reason && <> Reason: {status.fleet.reason}</>}</div>;
  const client = clientId ? status.clients.find(c => c.id === clientId) : undefined;
  if (client)
    return <div className="banner warn" role="status"><strong>Changes to {client.name}'s cabinets are paused.</strong> Diagnostics still work.{client.reason && <> Reason: {client.reason}</>}</div>;
  return null;
}
