// The live stream, and running a cabinet operation: issue it, then wait for its result.
// Results arrive on the live stream; a slow poll covers a dropped stream. The same stream
// carries new major alerts and every alert's claim and resolution.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, describeError } from "./api";
import { withBase } from "./base";

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

/** A security alert, new or repeated, announced to Admins on the live stream. */
export interface SecurityNews { id: string; created: boolean; kind: string; title: string; }
type SecurityListener = (news: SecurityNews) => void;

const StreamContext = createContext<{ wake: Map<string, Waiter>; alerts: Set<AlertListener>; security: Set<SecurityListener> }>({ wake: new Map(), alerts: new Set(), security: new Set() });

export function CommandStream({ children }: { children: ReactNode }) {
  const wake = useRef(new Map<string, Waiter>()).current;
  const alerts = useRef(new Set<AlertListener>()).current;
  const security = useRef(new Set<SecurityListener>()).current;
  useEffect(() => {
    const source = new EventSource(withBase("/api/stream"));
    source.addEventListener("result", e => {
      try { const { commandId } = JSON.parse((e as MessageEvent<string>).data) as { commandId: string }; wake.get(commandId)?.(); } catch { /* ignore */ }
    });
    source.addEventListener("alert", e => {
      let news: AlertNews;
      try { news = JSON.parse((e as MessageEvent<string>).data) as AlertNews; } catch { return; }
      alerts.forEach(fn => fn(news));
    });
    // Sent to Admins only; the server decides who receives it.
    source.addEventListener("security", e => {
      let news: SecurityNews;
      try { news = JSON.parse((e as MessageEvent<string>).data) as SecurityNews; } catch { return; }
      security.forEach(fn => fn(news));
    });
    return () => source.close();
  }, [wake, alerts, security]);
  return <StreamContext.Provider value={{ wake, alerts, security }}>{children}</StreamContext.Provider>;
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

/** Calls fn for every security alert announced on the live stream (Admins only) while the component is mounted. */
export function useSecurityNews(fn: SecurityListener): void {
  const { security } = useContext(StreamContext);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const listener: SecurityListener = n => latest.current(n);
    security.add(listener);
    return () => { security.delete(listener); };
  }, [security]);
}

const TERMINAL = new Set(["succeeded", "failed", "rejected", "expired"]);

interface Issued { commandId: string; issuedAt?: string; expiresAt: string }

/** Issuing and waiting, separately: a write's confirmation dialog awaits the issue (so a refusal shows there), then waits in the background. */
export function useCommands() {
  const { wake } = useContext(StreamContext);
  const issue = useCallback((cabinetId: string, operation: string, params: Record<string, unknown>, stepUpToken?: string) =>
    api<Issued>("POST", `/api/cabinets/${cabinetId}/commands`, { operation, params, ...(stepUpToken ? { stepUpToken } : {}) }), []);
  const wait = useCallback(async <T,>({ commandId, issuedAt, expiresAt }: Issued): Promise<CommandResult<T>> => {
    // The command's lifetime comes from the server's own two times; it is counted from now on this computer's clock,
    // so a browser whose clock is off still waits the right time (and always looks at least once).
    const lifetime = issuedAt ? new Date(expiresAt).getTime() - new Date(issuedAt).getTime() : 5 * 60_000;
    const deadline = Date.now() + Math.max(0, lifetime) + 30_000;
    for (let first = true; first || Date.now() < deadline; first = false) {
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
  return { issue, wait };
}

export function useRunner() {
  const { issue, wait } = useCommands();
  return useCallback(async <T,>(cabinetId: string, operation: string, params: Record<string, unknown>): Promise<CommandResult<T>> =>
    wait<T>(await issue(cabinetId, operation, params)), [issue, wait]);
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

/**
 * One write operation: begin() issues it with a step-up token and throws if the server refuses (the dialog shows why);
 * the answer is then awaited in the background and kept here.
 */
export function useWrite<T>(cabinetId: string, operation: string) {
  const { issue, wait } = useCommands();
  const [state, setState] = useState<Run<T>>({ state: "idle", result: null, problem: null, at: null });
  const begin = useCallback(async (params: Record<string, unknown>, stepUpToken: string | undefined, after?: (r: CommandResult<T>) => void) => {
    const issued = await issue(cabinetId, operation, params, stepUpToken);
    setState(s => ({ ...s, state: "running", problem: null }));
    void wait<T>(issued).then(
      result => { setState({ state: "done", result, problem: null, at: new Date().toISOString() }); after?.(result); },
      e => setState({ state: "done", result: null, problem: describeError(e), at: new Date().toISOString() }));
  }, [issue, wait, cabinetId, operation]);
  const clear = useCallback(() => setState({ state: "idle", result: null, problem: null, at: null }), []);
  return { ...state, begin, clear };
}
