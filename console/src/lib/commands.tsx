// The live stream, and running a cabinet operation: issue it, then wait for its result.
// Results arrive on the live stream; a slow poll covers a dropped stream. The same stream
// carries new major alerts and every alert's claim and resolution.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, describeError } from "./api";

export interface CommandResult<T = unknown> {
  status: "succeeded" | "failed" | "rejected" | "expired";
  output?: T;
  error?: { code: string; message: string };
  finishedAt?: string;
}

type Waiter = () => void;

/** An alert change announced on the live stream. */
export interface AlertNews {
  change: "created" | "claimed" | "resolved" | "open";
  alertId: string; severity: "major" | "minor"; title: string; state: string; sitePattern: boolean;
  cabinet: { id: string; name: string }; site: { id: string; name: string }; client: { id: string; name: string };
  claimedBy: { id: string; name: string } | null;
}
type AlertListener = (news: AlertNews) => void;

const StreamContext = createContext<{ wake: Map<string, Waiter>; alerts: Set<AlertListener> }>({ wake: new Map(), alerts: new Set() });

export function CommandStream({ children }: { children: ReactNode }) {
  const wake = useRef(new Map<string, Waiter>()).current;
  const alerts = useRef(new Set<AlertListener>()).current;
  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.addEventListener("result", e => {
      try { const { commandId } = JSON.parse((e as MessageEvent<string>).data) as { commandId: string }; wake.get(commandId)?.(); } catch { /* ignore */ }
    });
    source.addEventListener("alert", e => {
      let news: AlertNews;
      try { news = JSON.parse((e as MessageEvent<string>).data) as AlertNews; } catch { return; }
      alerts.forEach(fn => fn(news));
    });
    return () => source.close();
  }, [wake, alerts]);
  return <StreamContext.Provider value={{ wake, alerts }}>{children}</StreamContext.Provider>;
}

/** Calls fn for every alert change on the live stream while the component is mounted. */
export function useAlertNews(fn: AlertListener): void {
  const { alerts } = useContext(StreamContext);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const listener: AlertListener = n => latest.current(n);
    alerts.add(listener);
    return () => { alerts.delete(listener); };
  }, [alerts]);
}

const TERMINAL = new Set(["succeeded", "failed", "rejected", "expired"]);

export function useRunner() {
  const { wake } = useContext(StreamContext);
  return useCallback(async <T,>(cabinetId: string, operation: string, params: Record<string, unknown>): Promise<CommandResult<T>> => {
    const { commandId, expiresAt } = await api<{ commandId: string; expiresAt: string }>("POST", `/api/cabinets/${cabinetId}/commands`, { operation, params });
    const deadline = new Date(expiresAt).getTime() + 30_000;
    while (Date.now() < deadline) {
      const record = await api<{ status: string; result: { status: string; output?: T; error?: { code: string; message: string }; finishedAt?: string } | null }>("GET", `/api/commands/${commandId}`);
      if (TERMINAL.has(record.status)) {
        const r: CommandResult<T> = { status: record.status as CommandResult["status"] };
        if (record.result?.output !== undefined) r.output = record.result.output;
        if (record.result?.error) r.error = record.result.error;
        if (record.result?.finishedAt) r.finishedAt = record.result.finishedAt;
        return r;
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake.delete(commandId); resolve(); }, 3000);
        wake.set(commandId, () => { clearTimeout(timer); wake.delete(commandId); resolve(); });
      });
    }
    return { status: "expired", error: { code: "expired", message: "The cabinet did not answer before the command expired. It may be offline." } };
  }, [wake]);
}

export interface Run<T> { state: "idle" | "running" | "done"; result: CommandResult<T> | null; problem: string | null; at: string | null; }

/** One operation's state in a section: run it, show progress, keep the last answer. */
export function useOperation<T>(cabinetId: string, operation: string) {
  const run = useRunner();
  const [state, setState] = useState<Run<T>>({ state: "idle", result: null, problem: null, at: null });
  const start = useCallback(async (params: Record<string, unknown> = {}) => {
    setState(s => ({ ...s, state: "running", problem: null }));
    try {
      const result = await run<T>(cabinetId, operation, params);
      setState({ state: "done", result, problem: null, at: new Date().toISOString() });
      return result;
    } catch (e) {
      setState({ state: "done", result: null, problem: describeError(e), at: new Date().toISOString() });
      return null;
    }
  }, [run, cabinetId, operation]);
  return { ...state, start };
}
