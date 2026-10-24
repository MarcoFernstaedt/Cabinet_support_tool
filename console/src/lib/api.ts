// The console's only path to the server. Same origin, cookie session; the server
// checks every permission, so nothing here is a security boundary.

import { withBase } from "./base";
import { explainFailure, formatExplanation, PLATFORM_CODES, type Explanation } from "./error-explanations";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly data: Record<string, unknown> = {}) { super(code); }
}

/**
 * The failures the explainer does not model: the sign-in flow's own codes, the platform's
 * "something broke" answers, and a server that never answered. Every other code is worded
 * once, in error-explanations.ts, which is what the console shows.
 */
const localExplanations: Record<string, Explanation> = {
  invalid_credentials: { title: "Sign-in refused", detail: "That username and password do not match.", fix: "Check the username, then type the password again. An Admin can reset a forgotten one." },
  account_locked: { title: "Account locked", detail: "Too many attempts, so the account is locked for 15 minutes.", fix: "Wait 15 minutes, then sign in again." },
  too_many_attempts: { title: "Too many attempts", detail: "Too many attempts from this computer, so it is refusing for now.", fix: "Wait a few minutes, then try again." },
  write_limit_reached: { title: "Hourly change limit reached", detail: "Changes are paused until an Admin resumes them.", fix: "Ask an Admin to resume writes, then repeat the action." },
  publisher_not_trusted: { title: "Publisher not trusted", detail: "Refused: the package is signed by a publisher that is not on the trusted list.", fix: "An Admin adds the publisher, then the package can be approved." },
  verification_failed: { title: "Package could not be checked", detail: "Refused: the signature or the hash could not be verified.", fix: "Upload the package again untouched; if it still fails, stop and tell Tier 2." },
  origin_refused: { title: "Request refused", detail: "The request came from an unexpected page.", fix: "Reload the console and repeat the action." },
  server_error: { title: "Server error", detail: "The server hit an error; nothing was changed.", fix: "Try once more; if it happens again, copy this text to your Tier 2 contact." },
  claim_first: { title: "Claim the alert first", detail: "Only the person who claimed the alert, or an Admin, can resolve it.", fix: "Claim the alert, then resolve it." },
  unreachable: { title: "Server not reachable", detail: "The console could not reach the server, so nothing was changed.", fix: "Check this computer's connection, then reload the page." },
};

const explained = new Set(PLATFORM_CODES);

/** A failure in, the three things a screen can show: a short title, what happened, and what to do next. */
export const explainError = (e: unknown): Explanation => {
  if (e instanceof ApiError) {
    if (explained.has(e.code)) return explainFailure({ code: e.code, status: e.status, message: e.message });
    return localExplanations[e.code] ?? explainFailure({ status: e.status, message: e.code });
  }
  return explainFailure(e instanceof Error || typeof e === "string" ? e : { message: "" });
};

/** The same explanation as one line, for alerts and form problems. */
export const describeError = (e: unknown): string => {
  // Which fields a contract check refused, so a form can be corrected.
  const data = e instanceof ApiError ? e.data : {};
  const issues = Array.isArray(data.issues)
    ? (data.issues as { path?: string; rule?: string }[]).slice(0, 3).map(i => `${i.path ?? ""} (${i.rule ?? "invalid"})`)
    : [];
  const reason = typeof data.reason === "string" ? data.reason : "";
  return formatExplanation(explainError(e), { issues, reason });
};

/** Listeners told when the session has ended, so the app can return to sign-in. */
const signedOutListeners = new Set<() => void>();
export const onSignedOut = (fn: () => void): (() => void) => { signedOutListeners.add(fn); return () => signedOutListeners.delete(fn); };

/**
 * background: a poll the person did not ask for (a badge refreshing). The server checks the session but does not
 * count it as activity, so an unattended console still times out and "online now" shows real activity.
 */
export async function api<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, opts: { background?: boolean } = {}): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: { Accept: "application/json", ...(opts.background ? { "X-Background": "1" } : {}) } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  let response: Response;
  try { response = await fetch(withBase(path), init); }
  catch { throw new ApiError(0, "unreachable"); }
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const code = (data as { error?: string } | null)?.error ?? "server_error";
    if (response.status === 401 && (code === "signed_out" || code === "sign_in_incomplete") && !path.startsWith("/api/auth/")) signedOutListeners.forEach(fn => fn());
    throw new ApiError(response.status, code, (data ?? {}) as Record<string, unknown>);
  }
  return data as T;
}

/** Sends a file as the raw request body (package uploads), with the same error handling as api(). */
export async function upload<T>(path: string, file: Blob): Promise<T> {
  let response: Response;
  try { response = await fetch(withBase(path), { method: "PUT", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/octet-stream" }, body: file }); }
  catch { throw new ApiError(0, "unreachable"); }
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string } | null)?.error ?? "server_error", (data ?? {}) as Record<string, unknown>);
  return data as T;
}
