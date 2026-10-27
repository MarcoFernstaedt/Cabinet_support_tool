// Turns any platform failure into words a non-engineer can act on: what happened, in plain words, and
// exactly what to do next (console/src/lib/error-explanations.ts).
//
// Pure and dependency-free: no React, no I/O. Every code the server can refuse with (server/src/services/errors.ts,
// `new Refused("<code>", ...)`) has its own entry here, so a refusal never lands on the generic text. HTTP statuses,
// network failures and the installer/script failures this project actually hit are covered the same way. When a
// failure is not recognised the raw text is handed back untouched — the console must never invent a cause.

/** What the caller has: an API code, an HTTP status, a raw message, or an Error. */
export type FailureInput = string | number | Error | Failure;

/** A failure flattened to the three things the explainer can use. */
export interface Failure {
  code?: string;
  status?: number;
  message: string;
}

/** What the console shows: a short title, the plain explanation, and the next step. */
export interface Explanation {
  title: string;
  detail: string;
  fix: string;
}

/** Shared wording for the two write-pause codes, which differ only in who is affected. */
const pausedWrites = (who: string): Explanation => ({
  title: "Changes are paused",
  detail: `Writing to cabinets is paused ${who}; nothing on the machine was changed.`,
  // Only an Admin resumes writes, for the platform, a client or an account (write-routes.ts, users.ts).
  fix: "Ask an Admin to resume writes, then repeat the action.",
});

const codeExplanations: Record<string, Explanation> = {
  // ---- accounts, sign-in and permissions ------------------------------------------------------------
  forbidden: {
    title: "Not permitted",
    detail: "Your role does not allow this action on this cabinet or page.",
    fix: "Ask your Admin for the role this needs, or Tier 2 if you believe you already have it.",
  },
  not_allowed: {
    title: "Not allowed in this state",
    detail: "The item's current state does not permit this action.",
    fix: "Reload the item to see its state; ask Tier 2 if the state looks wrong.",
  },
  read_only_cabinet: {
    title: "Cabinet is read-only",
    detail: "A running operation holds the lock, or the cabinet is set read-only on purpose.",
    fix: "Wait for the operation to finish; an Admin can clear a stuck lock.",
  },
  signed_out: {
    title: "Signed out",
    detail: "Your session ended, so the action was not carried out.",
    fix: "Sign in again and repeat the action.",
  },
  sign_in_incomplete: {
    title: "Sign-in did not finish",
    detail: "A step is still missing, such as the second factor.",
    fix: "Sign in again from the start and complete every step.",
  },
  step_up_required: {
    title: "Confirmation required",
    detail: "This action needs a fresh sign-in or a second factor.",
    fix: "Complete the confirmation prompt, then repeat the action.",
  },
  totp_required: {
    title: "Second factor required",
    detail: "This account must enter an authenticator code to finish signing in.",
    fix: "Enter the current code from the authenticator app; if none is set up on the account, ask an Admin to reset it.",
  },
  weak_password: {
    title: "Password too weak",
    detail: "Too short or too easy to guess, so it was rejected.",
    fix: "Use at least 12 characters mixing words, numbers and symbols.",
  },
  username_taken: {
    title: "Username taken",
    detail: "Another account already uses this name.",
    fix: "Pick a different username and save again.",
  },
  username_deleted: {
    title: "Account deleted",
    detail: "The user was removed and can no longer sign in or be changed.",
    fix: "Create a new account, or ask an Admin to restore one.",
  },
  not_yours: {
    title: "Belongs to someone else",
    detail: "Only items you own or are responsible for can be changed.",
    fix: "Ask the owner, or ask an Admin to transfer it to you.",
  },
  not_yourself: {
    title: "Not your own account",
    detail: "This action would remove your own access to the console.",
    fix: "Ask another Admin to make the change.",
  },
  same_person: {
    title: "Two different people required",
    detail: "The Admin who uploaded a package cannot also approve it.",
    fix: "Ask a second Admin to review and approve it.",
  },
  own_proposal: {
    title: "Cannot approve your own proposal",
    detail: "Approvals need a second person, so someone else has to decide this one.",
    fix: "Ask another Admin to review and approve it.",
  },
  last_admin: {
    title: "That is the last Admin",
    detail: "The platform needs at least one Admin at all times, so this account cannot be removed or demoted.",
    fix: "Make another account an Admin first, then change this one.",
  },
  demo_client: {
    title: "Demo console",
    detail: "This is the demonstration copy, where real cabinets are refused.",
    fix: "Sign in to the real console address to work with real cabinets.",
  },
  real_cabinet_in_demo_client: {
    title: "Demo only",
    detail: "The demo console may not control a real cabinet.",
    fix: "Use the real console address for real cabinets.",
  },
  writes_paused: pausedWrites("platform-wide"),
  writes_paused_for_you: pausedWrites("for your account"),

  // ---- enrollment, sites and cabinets ---------------------------------------------------------------
  enrollment_refused: {
    title: "Cabinet could not be enrolled",
    detail: "The platform refused the enrollment, so the machine is not registered.",
    fix: "Check the token has not expired and belongs to this site, then start enrollment again; ask Tier 2 if it repeats.",
  },
  certificate_refused: {
    title: "Certificate rejected",
    detail: "The platform did not accept the certificate the agent presented, so the connection is not trusted.",
    fix: "Enroll again with a fresh token; if it still fails, send this text to Tier 2.",
  },
  already_claimed: {
    title: "Someone else claimed it first",
    detail: "Another person claimed this alert a moment before you, so it is theirs to work on.",
    fix: "Reload the alert to see who has it and talk to them; an Admin can resolve it if they cannot.",
  },
  invalid_code: {
    title: "Code not recognised",
    detail: "The enrollment or one-time code did not match what the platform expected, or it has expired.",
    fix: "Copy the code again from the console without spaces, or request a new one and retry.",
  },
  setup_not_started: {
    title: "Setup has not started",
    detail: "This cabinet has no enrollment in progress.",
    fix: "Start a new enrollment from the site page and follow the install steps it shows.",
  },
  cabinet_offline: {
    title: "Cabinet is not connected",
    detail: "It has not checked in with the platform, so it cannot be given instructions.",
    fix: "Check the machine is switched on and its Cabinet Agent service is running, then try again.",
  },
  has_cabinets: {
    title: "Site still has cabinets",
    detail: "A site with cabinets attached cannot be removed.",
    fix: "Move or remove the cabinets first, then delete the site — an Admin can do this.",
  },
  too_many_cabinets: {
    title: "Too many cabinets for one site",
    detail: "The site has reached its limit, so this cabinet was not added.",
    fix: "Remove a cabinet from the site, or ask your Admin to raise the limit.",
  },
  one_site_only: {
    title: "One site per cabinet",
    detail: "This request placed the same cabinet in more than one site.",
    fix: "Pick a single site and try again.",
  },
  name_taken: {
    title: "Name already in use",
    detail: "Another cabinet, site or group has this name.",
    fix: "Choose a different name and save again.",
  },
  invalid_address: {
    title: "Address not valid",
    detail: "The server address was not in a form the platform could use.",
    fix: "Enter just a host name or IP address, such as cab.example.com.",
  },
  sync_exists: {
    title: "Site already has a sync cabinet",
    detail: "A site can have only one cabinet the others sync through, and this site already has it.",
    fix: "Approve this cabinet as a satellite or standalone, or change the existing sync cabinet's role first — an Admin can do this.",
  },
  satellite_needs_sync: {
    title: "Satellite needs the sync cabinet's address",
    detail: "This cabinet will sync through another cabinet, but the platform was not told the address.",
    fix: "Enter the sync cabinet's private address, such as 10.0.0.5, with this approval; or approve the sync cabinet first and set the address on the site.",
  },
  sync_not_allowed: {
    title: "A sync cabinet takes no sync address",
    detail: "The sync cabinet is the one the others connect to, so it gets no address to sync with.",
    fix: "Leave the address empty, or approve this cabinet as a satellite instead.",
  },
  invalid_ports: {
    title: "Sync ports not valid",
    detail: "A port is a whole number from 1 to 65535, listed once, and a site can have only a few.",
    fix: "Remove the duplicate or out-of-range ports and save again.",
  },

  // ---- requests, approvals and issues --------------------------------------------------------------
  already_pending: {
    title: "Request already waiting",
    detail: "The same request is already waiting for an answer.",
    fix: "Wait for an Admin or Tier 2 to answer the request that is open.",
  },
  not_pending: {
    title: "Not waiting for an answer",
    detail: "The request was already answered or withdrawn, so it cannot be approved or denied now.",
    fix: "Reload the requests list to see what is still open.",
  },
  already_resolved: {
    title: "Issue already closed",
    detail: "Someone has already marked this issue as resolved.",
    fix: "Reload the page to see its current state, and open a new issue if the problem is still there.",
  },
  already_renewed: {
    title: "Already renewed",
    detail: "The cabinet's certificate was renewed recently and does not need renewing yet.",
    fix: "Nothing to do now; renew when the console shows the renewal is due.",
  },
  renew_too_early: {
    title: "Too early to renew",
    detail: "The certificate still has enough life left, so renewal is not needed yet.",
    fix: "Nothing to do now; renew when the console shows it is due.",
  },
  not_approved: {
    title: "Not approved",
    detail: "This item still needs an approval before it can be used.",
    fix: "Ask an Admin to approve it, then try again.",
  },
  package_not_approved: {
    title: "Package not approved",
    detail: "The package has not been signed off, so cabinets will not accept it.",
    fix: "Ask an Admin to approve it, then roll it out.",
  },
  wrong_stage: {
    title: "Step out of order",
    detail: "The item is at a different stage, so this action does not apply yet.",
    fix: "Reload to see the current stage and use the action it offers.",
  },
  wrong_category: {
    title: "Wrong category",
    detail: "The item does not match the category it was put in.",
    fix: "Change the category, or move the item to the right one.",
  },
  bad_item: {
    title: "Invalid entry",
    detail: "The console sent an entry that the server could not read.",
    fix: "Reload the page and try again; if it happens again, copy this text to Tier 2.",
  },
  duplicate_item: {
    title: "Added twice",
    detail: "The same entry is already in the list.",
    fix: "Remove the duplicate, or edit the entry that is already there.",
  },
  duplicate_key: {
    title: "Name already used",
    detail: "Another entry in this list has the same name.",
    fix: "Choose a different name and save again.",
  },
  too_many_items: {
    title: "Too many entries",
    detail: "The list is longer than the platform will accept in one request.",
    fix: "Remove some entries, or split the change into smaller batches.",
  },
  too_many_notes: {
    title: "Note limit reached",
    detail: "This issue has reached its limit for notes.",
    fix: "Add the new information to an existing note, or open a follow-up issue.",
  },
  too_many_proposals: {
    title: "Too many open proposals",
    detail: "There is a limit on proposals waiting for a decision, so this one was not raised.",
    fix: "Wait for the open ones to be decided, or withdraw one first.",
  },
  fix_not_for_this_issue: {
    title: "Fix belongs to another issue",
    detail: "The suggested fix was written for a different problem, so it was not applied.",
    fix: "Reload the issue and use the fix shown on it; ask Tier 2 if it is unclear which one fits.",
  },
  no_approved_baseline: {
    title: "No approved baseline yet",
    detail: "Nothing is approved as this cabinet's expected state, so there is nothing to compare against.",
    fix: "Ask an Admin to approve a baseline from a known-good reading of this cabinet.",
  },
  no_configuration: {
    title: "Nothing set up yet",
    detail: "The configuration this action needs has not been created.",
    fix: "Create or import the configuration first; ask Tier 2 if you expected one to exist.",
  },
  not_a_draft: {
    title: "No longer a draft",
    detail: "The item has already been sent for approval, so it can no longer be edited as a draft.",
    fix: "Withdraw it first, or create a new draft.",
  },
  stale_base: {
    title: "Changed by someone else",
    detail: "The item was edited after you opened it, so saving would overwrite their change.",
    fix: "Reload to get the latest version and reapply your edit.",
  },
  rule_impossible: {
    title: "Rule can never match",
    detail: "The conditions contradict each other, so no reading would ever satisfy them.",
    fix: "Remove one of the conflicting conditions and save again.",
  },
  rule_too_broad: {
    title: "Rule is too broad",
    detail: "It would match far more than intended, which could hide real problems.",
    fix: "Add a more specific condition, such as a name or a file path.",
  },

  // ---- jobs, commands and searches -----------------------------------------------------------------
  job_exists: {
    title: "Job already running",
    detail: "A job for this cabinet and this action already exists, so a second one was not started.",
    fix: "Watch the existing job in the Jobs list instead of starting another.",
  },
  busy: {
    title: "Platform busy",
    detail: "Another job is running that blocks this one right now.",
    fix: "Wait a minute and try again; if it keeps happening, tell Tier 2 which action you were doing.",
  },
  unavailable: {
    title: "Platform unavailable",
    detail: "The server is restarting or a dependency is down, so the action did not run.",
    fix: "Wait a minute and try again; if it lasts longer, tell Tier 2.",
  },
  rate_limited: {
    title: "Too many requests",
    detail: "The platform is limiting how often this can be done, so nothing was changed.",
    fix: "Wait a minute and try again.",
  },
  unknown_command: {
    title: "Command not known",
    detail: "The platform does not recognise the command name, which usually means the agent is older than the server.",
    fix: "Update the Cabinet Agent to the current version, then try again.",
  },
  unknown_operation: {
    title: "Operation not known",
    detail: "The agent asked for something the platform does not offer, which usually means the two versions differ.",
    fix: "Update the Cabinet Agent to match the server, then try again.",
  },
  unknown_keyword: {
    title: "Word not recognised",
    detail: "The search or filter used a keyword the platform does not support.",
    fix: "Remove that word, or pick one from the suggestions shown.",
  },
  usage: {
    title: "Incomplete request",
    detail: "A required value was left out, so nothing was done.",
    fix: "Fill in the missing field shown and try again.",
  },
  invalid_request: {
    title: "Request not understood",
    detail: "The server could not read what the console sent, which usually means the console and server versions differ.",
    fix: "Reload the console; if it repeats, tell Tier 2 the console version in the footer.",
  },
  invalid_params: {
    title: "Settings not valid",
    detail: "One or more values sent with this request were missing or out of range.",
    fix: "Check the highlighted fields and try again.",
  },
  invalid_json: {
    title: "Message not readable",
    detail: "The data sent was not in the format the server expects.",
    fix: "Reload the page and repeat the action; if it repeats, copy this text to Tier 2.",
  },
  invalid_window: {
    title: "Time window not valid",
    detail: "The start or end time is missing, in the wrong order, or further back than the platform keeps.",
    fix: "Pick a start earlier than the end, inside the allowed range, and try again.",
  },
  invalid_output: {
    title: "Result not readable",
    detail: "A command finished but returned data in a shape the platform did not expect.",
    fix: "Run the action again; if it repeats, copy this text to Tier 2.",
  },
  invalid_result: {
    title: "Unusable result from the cabinet",
    detail: "The answer from the cabinet did not match the format the platform expects.",
    fix: "Run the action again; if it keeps happening, tell Tier 2.",
  },
  invalid_runbook: {
    title: "Fix instructions not valid",
    detail: "The runbook for this issue is malformed, so it cannot be offered safely.",
    fix: "Tell Tier 2 which issue you opened, and do not run the steps by hand.",
  },
  invalid_manifest: {
    title: "Package list not valid",
    detail: "The list of files inside the package is malformed, so the package cannot be trusted.",
    fix: "Rebuild the package with the release tool; if you did not build it, tell Tier 2.",
  },
  no_file_paths: {
    title: "No file paths given",
    detail: "This check needs at least one path to look at, and none were sent.",
    fix: "Add at least one path and run the check again.",
  },
  not_searchable: {
    title: "Not searchable yet",
    detail: "The item is not ready for search, which usually means it is still being prepared.",
    fix: "Wait a moment and search again.",
  },
  not_found: {
    title: "Not found",
    detail: "The item was removed, renamed, or belongs to a different site.",
    fix: "Reload the list and pick it again from what is shown.",
  },
  not_deleted: {
    title: "Not deleted",
    detail: "The item is still present, so the delete did not take effect.",
    fix: "Reload and try again; if it is still there, tell Tier 2.",
  },
  not_paused: {
    title: "Not paused",
    detail: "This action assumes a paused state that the item is not in.",
    fix: "Reload to see the current state, and use the action that matches it.",
  },
  not_live: {
    title: "Not live yet",
    detail: "The change exists but has not been switched on for the cabinet.",
    fix: "Publish or roll it out first, then try again.",
  },
  not_uploading: {
    title: "No upload in progress",
    detail: "The cabinet is not currently receiving a package, so this step does not apply.",
    fix: "Start the upload again from the cabinet page.",
  },
  not_awaiting_package: {
    title: "Cabinet is not waiting for a package",
    detail: "The cabinet is in a different state, so the upload step does not apply.",
    fix: "Reload the cabinet page to see its current state.",
  },
  result_not_expected: {
    title: "Unexpected result",
    detail: "The cabinet replied to a job the platform was not waiting for.",
    fix: "Tell Tier 2; the agent may be running a job left over from an earlier version.",
  },
  result_over_cap: {
    title: "Result too big",
    detail: "The cabinet's output is larger than the platform will store, so it was not saved.",
    fix: "Make the command print less; ask Tier 2 if you cannot change it.",
  },
  query_timeout: {
    title: "Search took too long",
    detail: "The database stopped the query before it could finish.",
    fix: "Narrow the search with a filter or a shorter time range and try again.",
  },
  query_too_slow: {
    title: "Search too heavy",
    detail: "The request would have to scan too much data, so the platform refused it.",
    fix: "Add filters or a shorter time range to make the search smaller.",
  },
  search_too_slow: {
    title: "Search too slow",
    detail: "The platform stopped it before it could return results.",
    fix: "Use fewer words, or a narrower time range.",
  },
  too_large: {
    title: "Too large",
    detail: "The upload or request is bigger than the platform accepts.",
    fix: "Split it into smaller parts or reduce the file size, then try again.",
  },

  // ---- releases and rollouts -----------------------------------------------------------------------
  hash_mismatch: {
    title: "Package does not match what was published",
    detail: "The downloaded file's fingerprint differs from the one the platform recorded, so it may be damaged or altered.",
    fix: "Download the package again without changing it; if the mismatch persists, stop and tell Tier 2.",
  },
  signature_invalid: {
    title: "Package signature not valid",
    detail: "The signature does not match the package, so it may have been altered or built with an unknown key.",
    fix: "Do not install it; download the package again and tell Tier 2 if it still fails.",
  },
  release_changed: {
    title: "Release changed while you were working",
    detail: "Someone published a newer version, so your change was not saved over it.",
    fix: "Reload and reapply your change to the current version.",
  },
  release_not_ready: {
    title: "Release not ready",
    detail: "The package is still uploading or being checked, or it has not been approved yet.",
    fix: "Wait for it to finish and try again; the release page shows its state.",
  },
  version_exists: {
    title: "Version already exists",
    detail: "A package with the same version number was already published.",
    fix: "Bump the version number and publish again.",
  },
  version_not_newer: {
    title: "Version not newer",
    detail: "Cabinets only upgrade to a higher version than the one they already run.",
    fix: "Publish a higher version number.",
  },
  rollout_active: {
    title: "Rollout already running",
    detail: "Only one rollout can run at a time, so this one was not started.",
    fix: "Wait for the current rollout to finish, or pause it first.",
  },
  pilot_not_eligible: {
    title: "Cabinet cannot join the pilot",
    detail: "It is offline, or on a version that cannot take part in a staged rollout.",
    fix: "Bring it online and up to the required version, or pick a different cabinet.",
  },
  rename_not_allowed: {
    title: "Cannot be renamed",
    detail: "The platform reserves this name, or the item is locked by another change.",
    fix: "Choose a different name; ask Tier 2 if the lock is unexpected.",
  },
};

/** Every platform refusal code this module explains, sorted. */
export const PLATFORM_CODES: readonly string[] = Object.freeze(Object.keys(codeExplanations).sort());

const knownCodes = new Set(PLATFORM_CODES);

/** HTTP statuses the console can receive, including the gateway errors a proxy adds. */
const statusExplanations: Record<number, Explanation> = {
  400: {
    title: "Server did not understand the request",
    detail: "Something the console sent did not match what the server expects.",
    fix: "Reload the page and try again; if it repeats, tell Tier 2.",
  },
  401: {
    title: "Not signed in",
    detail: "The server did not recognise your session, so nothing was changed.",
    fix: "Sign in again and repeat the action.",
  },
  403: {
    title: "Not permitted",
    detail: "Your account is not allowed to do this on this cabinet or page.",
    fix: "Ask your Admin for the role this needs, or Tier 2 if you believe you already have it.",
  },
  404: {
    title: "Page or item not found",
    detail: "It was removed or renamed, or it belongs to a different site.",
    fix: "Go back to the list and open it from there.",
  },
  409: {
    title: "Changed by someone else first",
    detail: "The item was updated after you opened it, so your change was not saved.",
    fix: "Reload to see the latest version, then reapply your change.",
  },
  413: {
    title: "Upload too big",
    detail: "The file is larger than the platform accepts in one go.",
    fix: "Reduce the file size or split it into smaller parts, then upload again.",
  },
  429: {
    title: "Too many requests",
    detail: "The platform is limiting how often this can be done, so nothing was changed.",
    fix: "Wait a minute and try again.",
  },
  500: {
    title: "Server internal error",
    detail: "Something went wrong inside the platform, not on your machine.",
    fix: "Try once more; if it keeps failing, copy this text to Tier 2.",
  },
  502: {
    title: "Server behind the console did not answer properly",
    detail: "A part of the platform is down or restarting, so the action could not run.",
    fix: "Wait a minute and try again; if it lasts, tell Tier 2.",
  },
  503: {
    title: "Platform unavailable",
    detail: "The server is restarting or under maintenance, so the action did not run.",
    fix: "Wait a few minutes and try again; if it lasts, tell Tier 2.",
  },
  504: {
    title: "Server took too long to answer",
    detail: "The platform gave up waiting, so it is not known whether the action was carried out.",
    fix: "Wait a minute, reload the page to check the result, and only then try again.",
  },
};

/**
 * Failures seen before any server answers, plus the installer failures this project actually hit.
 * Order matters: the most specific wording wins, so the installer rules are checked first.
 */
const messageRules: ReadonlyArray<{ pattern: RegExp; explanation: Explanation }> = [
  // ---- installer failures (Install-CabinetAgent.cmd, run on the built-in Windows PowerShell 5.1) ---------------------------------
  {
    // The installer is plain ASCII PowerShell 5.1; a parse error means the file was edited or re-saved, not a PowerShell version problem.
    pattern: /unexpected token|missing closing '\}'|parsererror|assignment expression.*not valid|expression or statement is incomplete/i,
    explanation: {
      title: "Installer file damaged",
      detail: "Windows PowerShell could not parse the installer, which happens when the file is opened and re-saved or altered in transit.",
      fix: "Create a new installer in Admin → Setup and run it without opening it.",
    },
  },
  {
    pattern: /running scripts is disabled|execution policy|executionpolicy|unauthorizedaccess.*\.ps1|\.ps1.*cannot be loaded/i,
    explanation: {
      title: "Script execution policy",
      detail: "Windows refused to run a PowerShell file directly.",
      fix: "Run Install-CabinetAgent.cmd, not a .ps1 file; it applies -ExecutionPolicy Bypass for that run only.",
    },
  },
  {
    pattern: /is not recognized as the name of a cmdlet|is not recognized as an internal or external command|commandnotfoundexception|the term '[^']+' is not recognized/i,
    explanation: {
      title: "File not found",
      detail: "A file the installer needs was not found in its folder.",
      fix: "Keep Install-CabinetAgent.cmd in the same folder as the agent files and run it from that folder.",
    },
  },
  {
    // Old Windows with TLS 1.2 off: the agent cannot reach the server.
    pattern: /could not create ssl\/tls secure channel|secure channel|tls ?1\.[0-9]|ssl\/tls|the underlying connection was closed.*(unexpected|tls)|tls.*(disabled|not enabled|not supported)/i,
    explanation: {
      title: "TLS 1.2 not available",
      detail: "Windows on this machine does not enable TLS 1.2, which the platform requires.",
      fix: "Enable TLS 1.2 (Internet Options → Advanced), install pending Windows updates, then run Install-CabinetAgent.cmd again.",
    },
  },
  {
    // Agent installed and running, but its outbound connection is blocked or the address is wrong.
    pattern: /10061|10060|no route to host|(agent|service|cabinet).{0,60}(cannot|can't|unable to|failed to).{0,30}(reach|connect)|(cannot|can't|unable to) (reach|connect to) (the )?(platform|server)/i,
    explanation: {
      title: "The agent is installed but cannot reach the server",
      detail: "The service is running but its outbound connection is refused or times out: a network path problem, not an install problem.",
      fix: "Allow outbound traffic to the server address and agent port through the firewall and any proxy; do not reinstall.",
    },
  },

  // ---- network-level failures --------------------------------------------------------------------
  {
    pattern: /failed to fetch|fetch failed|networkerror|network error|load failed|network request failed/i,
    explanation: {
      title: "Cannot reach the server",
      detail: "Your browser could not open a connection to the platform at all.",
      fix: "Check you are on the office network or VPN, then reload; if other sites also fail, the network is down.",
    },
  },
  {
    pattern: /econnrefused|connection refused|connect econnrefused/i,
    explanation: {
      title: "Server refused the connection",
      detail: "Something answered at that address but is not the platform, or the platform is not running.",
      fix: "Check the address and port, then try again; tell Tier 2 if the platform should be running.",
    },
  },
  {
    pattern: /enotfound|eai_again|getaddrinfo|name or service not known|nodename nor servname|dns/i,
    explanation: {
      title: "That server name could not be found",
      detail: "The name in the address does not resolve, which usually means a typo or no access to the internal network.",
      fix: "Check the spelling of the address and that you are on the office network or VPN, then reload.",
    },
  },
  {
    pattern: /abort|etimedout|timed? ?out|timeout|took too long/i,
    explanation: {
      title: "The server did not answer in time",
      detail: "The request was stopped before the platform replied, so the action may or may not have happened.",
      fix: "Reload the page to see the current state, then try again; if it keeps timing out, tell Tier 2.",
    },
  },
  {
    pattern: /certificate|self.signed|cert_|unable_to_verify|err_tls|ssl|tls handshake|hostname mismatch/i,
    explanation: {
      title: "Secure connection not trusted",
      detail: "The certificate the server presented is not the one this computer expects, so the browser stopped the connection.",
      fix: "Check the address is exactly the one you were given; if it is, send this text to Tier 2 — do not click through the warning.",
    },
  },
];

const generic = (raw: string): Explanation => ({
  title: "Request failed",
  detail: raw,
  fix: "Copy this text to your Tier 2 contact.",
});

/**
 * The three fields as one line, for alerts and form problems, with anything the caller
 * knows about the request appended: which fields a contract check refused, and the
 * server's own reason for a refusal that carries one.
 */
export function formatExplanation(explanation: Explanation, extra: { issues?: string[]; reason?: string } = {}): string {
  const { issues = [], reason = "" } = extra;
  return [
    `${explanation.title}.`,
    explanation.detail,
    issues.length ? `Check: ${issues.join(", ")}.` : "",
    reason && !explanation.detail.includes(reason) ? reason : "",
    explanation.fix,
  ].filter(Boolean).join(" ");
}

/**
 * Flattens whatever the caller has into `{ code?, status?, message }`.
 * A single word is read as a code only when the platform uses it; anything else is kept as the message
 * so that `"ECONNREFUSED"` still reaches the network rules instead of dying as an unknown code.
 */
export function normaliseFailure(input: FailureInput): Failure {
  if (typeof input === "number") {
    return { status: Number.isFinite(input) ? input : undefined, message: "" };
  }
  if (typeof input === "string") {
    const text = input.trim();
    return knownCodes.has(text) ? { code: text, message: "" } : { message: text };
  }
  if (input instanceof Error) {
    const carried = (input as Error & { code?: unknown; status?: unknown });
    const code = typeof carried.code === "string" ? carried.code.trim() : "";
    const status = typeof carried.status === "number" ? carried.status : undefined;
    const message = input.message || "";
    // An aborted request is a network failure with no code of its own.
    if (!code && input.name === "AbortError") return { code: "abort", status, message };
    return {
      ...(code && knownCodes.has(code) ? { code } : {}),
      ...(status !== undefined ? { status } : {}),
      message: code && !knownCodes.has(code) ? `${code}: ${message}` : message,
    };
  }
  if (input && typeof input === "object") {
    const { code, status, message } = input as Failure;
    const text = typeof message === "string" ? message.trim() : "";
    return {
      ...(typeof code === "string" && knownCodes.has(code.trim()) ? { code: code.trim() } : {}),
      ...(typeof status === "number" && Number.isFinite(status) ? { status } : {}),
      message: text,
    };
  }
  return { message: "" };
}

/**
 * The one thing the console calls: a failure in, three plain-language fields out.
 * Platform code first, then the specific message rules, then the HTTP status, then the neutral fallback
 * that hands the raw text back untouched.
 */
export function explainFailure(input: FailureInput): Explanation {
  const failure = normaliseFailure(input);

  if (failure.code && codeExplanations[failure.code]) return codeExplanations[failure.code]!;

  const message = failure.message;
  if (message) {
    for (const rule of messageRules) {
      if (rule.pattern.test(message)) return rule.explanation;
    }
  }

  if (failure.status !== undefined) {
    const byStatus = statusExplanations[failure.status];
    if (byStatus) return byStatus;
    return generic(message || `The server answered with status ${failure.status}.`);
  }

  if (message) return generic(message);
  return generic("No further detail was reported.");
}
