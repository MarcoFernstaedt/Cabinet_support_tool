// The console's only path to the server. Same origin, cookie session; the server
// checks every permission, so nothing here is a security boundary.

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly data: Record<string, unknown> = {}) { super(code); }
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: "That username and password do not match.",
  account_locked: "Too many attempts. The account is locked for 15 minutes.",
  too_many_attempts: "Too many attempts from this computer. Try again later.",
  invalid_code: "That code is not right, or was already used. Wait for the next code and try again.",
  weak_password: "Choose a password of at least 12 characters that is not your old one and does not contain your username.",
  step_up_required: "The confirmation expired or was already used. Confirm again.",
  forbidden: "Your role cannot do this.",
  signed_out: "You have been signed out.",
  sign_in_incomplete: "Finish signing in first.",
  not_found: "Not found.",
  invalid_request: "The request was not accepted. Check the values and try again.",
  invalid_address: "The sync cabinet must have a private IPv4 address (10.x, 172.16-31.x or 192.168.x).",
  name_taken: "A cabinet with that name already exists at that site.",
  not_pending: "That request is no longer waiting for approval.",
  writes_unavailable: "Changes to cabinets arrive in a later release.",
  origin_refused: "The request came from an unexpected page. Reload the console.",
  server_error: "The server hit an error. Try again.",
  already_claimed: "Someone else claimed this alert first.",
  already_resolved: "This alert is already resolved.",
  claim_first: "Claim the alert before resolving it. Only the person who claimed it (or an Admin) can resolve it.",
  rule_too_broad: "Keep at least one of the source, event ID, hardware ID or a message phrase, so the rule cannot swallow unrelated errors.",
  rule_impossible: "Log, source, event ID and level only apply to event log errors.",
  not_live: "That rule is not live.",
};

export const describeError = (e: unknown): string =>
  e instanceof ApiError ? MESSAGES[e.code] ?? `The server refused this (${e.code}).` : "The server could not be reached.";

/** Listeners told when the session has ended, so the app can return to sign-in. */
const signedOutListeners = new Set<() => void>();
export const onSignedOut = (fn: () => void): (() => void) => { signedOutListeners.add(fn); return () => signedOutListeners.delete(fn); };

export async function api<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  let response: Response;
  try { response = await fetch(path, init); }
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
