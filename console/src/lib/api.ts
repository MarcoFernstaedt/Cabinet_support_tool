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
  name_taken: "That name is already used here.",
  not_pending: "That request is no longer waiting for approval.",
  writes_paused: "Changes to cabinets are paused. Diagnostics still work.",
  writes_paused_for_you: "Your changes are paused because you reached your hourly limit. An Admin can resume them.",
  write_limit_reached: "That was over your hourly limit for changes, so your changes are now paused until an Admin resumes them.",
  read_only_cabinet: "This cabinet was installed read-only and accepts no changes.",
  package_not_approved: "That package is not approved (it may have been retired).",
  same_person: "Another Admin must approve this: the Admin who uploaded a package cannot approve it.",
  version_exists: "That name and version already exist. Changing a package means uploading a new version.",
  not_uploading: "This package is not waiting for your upload.",
  too_large: "The file is larger than the package size limit.",
  hash_mismatch: "The file does not match its expected hash.",
  signature_invalid: "Refused: the package is unsigned, or was changed after it was signed.",
  publisher_not_trusted: "Refused: the package is signed by a publisher that is not on the trusted list.",
  verification_failed: "Refused: the package could not be checked.",
  unavailable: "The server has no package store configured.",
  username_taken: "That username is already used.",
  username_deleted: "That username belonged to an account that was deleted. You can reactivate it instead.",
  totp_required: "This person must set up an authenticator before becoming Tier 2 or Admin.",
  last_admin: "This is the last active Admin account; it cannot be removed, disabled or demoted.",
  not_yourself: "Ask another Admin to change your own role, disable or delete your account.",
  has_cabinets: "It still has active or pending cabinets. Move or remove them first.",
  not_paused: "This person's changes are not paused.",
  origin_refused: "The request came from an unexpected page. Reload the console.",
  server_error: "The server hit an error. Try again.",
  already_claimed: "Someone else claimed this alert first.",
  already_resolved: "This alert is already resolved.",
  claim_first: "Claim the alert before resolving it. Only the person who claimed it (or an Admin) can resolve it.",
  rule_too_broad: "Keep at least one of the source, event ID, hardware ID or a message phrase, so the rule cannot swallow unrelated errors.",
  rule_impossible: "Log, source, event ID and level only apply to event log errors.",
  not_live: "That rule is not live.",
};

export const describeError = (e: unknown): string => {
  if (!(e instanceof ApiError)) return "The server could not be reached.";
  const base = MESSAGES[e.code] ?? `The server refused this (${e.code}).`;
  // Which fields a contract check refused, so a form can be corrected.
  const issues = Array.isArray(e.data.issues) ? (e.data.issues as { path?: string; rule?: string }[]).slice(0, 3).map(i => `${i.path ?? ""} (${i.rule ?? "invalid"})`) : [];
  const reason = typeof e.data.reason === "string" ? e.data.reason : "";
  return [base, issues.length ? `Check: ${issues.join(", ")}.` : "", reason && !base.includes(reason) ? reason : ""].filter(Boolean).join(" ");
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

/** Sends a file as the raw request body (package uploads), with the same error handling as api(). */
export async function upload<T>(path: string, file: Blob): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { method: "PUT", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/octet-stream" }, body: file }); }
  catch { throw new ApiError(0, "unreachable"); }
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string } | null)?.error ?? "server_error", (data ?? {}) as Record<string, unknown>);
  return data as T;
}
