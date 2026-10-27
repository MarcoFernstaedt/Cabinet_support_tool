// Every platform failure turned into something a non-engineer can act on (src/lib/error-explanations.ts).
// The code list below is the exact output of
//   grep -rhoE 'new Refused\("[a-z_]+"' server/src | sort -u
// so a code added to the server without an explanation here fails the first test instead of reaching the
// console as "That didn't work". The rest holds the HTTP, network and installer cases to being specific,
// and holds the fallback to never inventing a cause.
import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORM_CODES, explainFailure, formatExplanation, normaliseFailure } from "../src/lib/error-explanations.ts";

/** Every refusal code the server can send, straight from the grep in the task. */
const DISCOVERED_CODES = [
  "already_claimed", "already_pending", "already_renewed", "already_resolved", "bad_item", "busy",
  "cabinet_offline", "certificate_refused", "demo_client", "duplicate_item", "duplicate_key",
  "enrollment_refused", "fix_not_for_this_issue", "forbidden", "has_cabinets", "hash_mismatch",
  "invalid_address", "invalid_code", "invalid_json", "invalid_manifest", "invalid_output", "invalid_params",
  "invalid_ports", "choose_sync_cabinet", "invalid_sync_cabinet", "not_a_satellite", "not_a_sync_cabinet", "scanner_for_existing_client", "sync_not_allowed",
  "invalid_request", "invalid_result", "invalid_runbook", "invalid_window", "job_exists", "last_admin",
  "name_taken", "no_approved_baseline", "no_configuration", "no_file_paths", "not_a_draft", "not_allowed",
  "not_approved", "not_awaiting_package", "not_deleted", "not_found", "not_live", "not_paused", "not_pending",
  "not_searchable", "not_uploading", "not_yours", "not_yourself", "one_site_only", "own_proposal",
  "package_not_approved", "pilot_not_eligible", "query_timeout", "query_too_slow", "rate_limited",
  "read_only_cabinet", "real_cabinet_in_demo_client", "release_changed", "release_not_ready",
  "rename_not_allowed", "renew_too_early", "result_not_expected", "result_over_cap", "rollout_active",
  "rule_impossible", "rule_too_broad", "same_person", "search_too_slow", "setup_not_started",
  "signature_invalid", "signed_out", "sign_in_incomplete", "stale_base", "step_up_required", "too_large",
  "too_many_cabinets", "too_many_items", "too_many_notes", "too_many_proposals", "totp_required",
  "unavailable", "unknown_command", "unknown_keyword", "unknown_operation", "usage", "username_deleted",
  "username_taken", "version_exists", "version_not_newer", "weak_password", "writes_paused",
  "writes_paused_for_you", "wrong_category", "wrong_stage",
] as const;

const GENERIC_TITLE = "Request failed";
const STATUSES = [400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504];

/** Sentence boundaries only count when a capital starts the next one, so "TLS 1.2" is not split. */
const sentenceCount = (text: string): number => text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(s => s.trim()).length;

test("every code the server can refuse with gets its own explanation", () => {
  const missing = DISCOVERED_CODES.filter(code => !PLATFORM_CODES.includes(code));
  assert.deepEqual(missing, [], `codes with no entry would fall through to the generic text: ${missing.join(", ")}`);
  assert.equal(PLATFORM_CODES.length, DISCOVERED_CODES.length, "an entry that is not a real code should be removed");

  for (const code of DISCOVERED_CODES) {
    const explained = explainFailure({ code, message: `refused: ${code}` });
    assert.notEqual(explained.title, GENERIC_TITLE, `${code} fell through to the generic text`);
    assert.ok(explained.title.length > 0 && explained.detail.length > 0 && explained.fix.length > 0, `${code} has an empty field`);
  }
});

test("a code wins over the raw message that came with it", () => {
  const explained = explainFailure({ code: "cabinet_offline", status: 409, message: "ECONNREFUSED 10.0.0.4:8443" });
  assert.equal(explained.title, "Cabinet is not connected", "the message must not override a known code");
});

test("an unknown code keeps the raw text and admits it does not know", () => {
  const raw = "some_future_code: the sparkle module refused";
  const explained = explainFailure({ code: "some_future_code", message: raw });
  assert.equal(explained.title, GENERIC_TITLE);
  assert.equal(explained.detail, raw, "the raw text is the detail, so nothing is lost");
  assert.match(explained.fix, /Tier 2/, "an unknown failure has to be handed to a person");

  const bare = explainFailure({ code: "not_a_real_code_at_all", message: "" });
  assert.equal(bare.title, GENERIC_TITLE);
  assert.equal(bare.detail, "No further detail was reported.");
  assert.match(bare.fix, /Tier 2/);
});

test("every HTTP status the console can receive says what happened", () => {
  for (const status of STATUSES) {
    const explained = explainFailure({ status, message: "" });
    assert.notEqual(explained.title, GENERIC_TITLE, `status ${status} fell through`);
    assert.ok(explained.fix.length > 0, `status ${status} has no fix`);
    assert.ok(explained.detail.includes(String(status)) === false, "the status number is not the explanation");
  }
  assert.match(explainFailure({ status: 401, message: "Unauthorized" }).fix, /[Ss]ign in/);
  assert.match(explainFailure({ status: 403, message: "Forbidden" }).fix, /Admin/, "a permission fix names who can do it");
  assert.match(explainFailure({ status: 429, message: "Too Many Requests" }).fix, /[Ww]ait/);
});

test("a status the platform does not know still hands the text over", () => {
  const explained = explainFailure({ status: 418, message: "I am a teapot" });
  assert.equal(explained.title, GENERIC_TITLE);
  assert.equal(explained.detail, "I am a teapot");
  assert.match(explained.fix, /Tier 2/);
});

test("network failures before any server answers are explained as network failures", () => {
  const samples = [
    ["TypeError: fetch failed", /reach the server/],
    ["Failed to fetch", /reach the server/],
    ["connect ECONNREFUSED 127.0.0.1:8443", /refused the connection/],
    ["getaddrinfo ENOTFOUND cab.example.com", /name could not be found/],
    ["getaddrinfo EAI_AGAIN cab.example.com", /name could not be found/],
    ["The operation timed out after 30000ms", /did not answer in time/],
    ["ETIMEDOUT", /did not answer in time/],
    ["AbortError: The user aborted a request.", /did not answer in time/],
    ["self-signed certificate in certificate chain", /not trusted/],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", /not trusted/],
  ] as const;
  for (const [message, expected] of samples) {
    const explained = explainFailure({ message });
    assert.match(explained.title + " " + explained.detail, expected, `not explained as a network failure: ${message}`);
    assert.notEqual(explained.title, GENERIC_TITLE, `${message} fell through to the generic text`);
  }
});

test("installer failures name the one-click installer, never a manual install line", () => {
  const damaged = explainFailure("At C:\\Agent\\Install-CabinetAgent.ps1:42 char:20\n+ Unexpected token '}' in expression or statement.\nParserError:");
  assert.match(damaged.title, /damaged/, "on 5.1 a parse error means the file was altered");
  assert.match(damaged.fix, /new installer/);

  const policy = explainFailure("File C:\\Agent\\Install-CabinetAgent.ps1 cannot be loaded because running scripts is disabled on this system.");
  assert.match(policy.fix, /Install-CabinetAgent\.cmd/, "the .cmd starts the script with the policy bypassed");

  const notFound = explainFailure("The term 'Cabinet.Agent.Network.exe' is not recognized as the name of a cmdlet, function, script file, or operable program.");
  assert.match(notFound.fix, /same folder/i);

  const tls = explainFailure("Exception calling \"GetResponse\": The request was aborted: Could not create SSL/TLS secure channel.");
  assert.match(tls.title, /TLS 1\.2/);
  assert.match(tls.fix, /TLS 1\.2/);

  const unreachable = explainFailure("The Cabinet Agent service is installed but cannot connect to the platform server: No connection could be made because the target machine actively refused it. (10061)");
  assert.match(unreachable.title, /installed but cannot reach/, "an installed agent that cannot connect is not a failed install");
  assert.match(unreachable.fix, /firewall/i);
  assert.match(unreachable.fix, /do not reinstall/i);

  const all = [damaged, policy, notFound, tls, unreachable].map(e => `${e.title} ${e.detail} ${e.fix}`).join(" ");
  assert.doesNotMatch(all, /install line|pwsh|PowerShell 7/, "the old manual install steps are gone");
});

test("normaliseFailure accepts a code, a status, a message, an Error and the object the caller passes", () => {
  assert.deepEqual(normaliseFailure("not_found"), { code: "not_found", message: "" });
  assert.deepEqual(normaliseFailure("  429 "), { message: "429" }, "a number in a string is a message, not a status");
  assert.deepEqual(normaliseFailure(503), { status: 503, message: "" });
  assert.deepEqual(normaliseFailure("fetch failed"), { message: "fetch failed" });
  assert.deepEqual(normaliseFailure({ code: "busy", status: 409, message: "later" }), { code: "busy", status: 409, message: "later" });

  const refused = Object.assign(new Error("log line only"), { code: "hash_mismatch", status: 409 });
  assert.deepEqual(normaliseFailure(refused), { code: "hash_mismatch", status: 409, message: "log line only" });

  const abort = new Error("The user aborted a request.");
  abort.name = "AbortError";
  assert.equal(normaliseFailure(abort).code, "abort");
  assert.match(explainFailure(abort).title, /did not answer in time/);

  const unknownError = Object.assign(new Error("boom"), { code: "EUNKNOWNTHING" });
  assert.equal(normaliseFailure(unknownError).code, undefined, "an unknown Error code must not be treated as a platform code");
  assert.match(normaliseFailure(unknownError).message, /EUNKNOWNTHING/, "the raw code stays in the text so nothing is lost");
});

test("bare strings the caller already has are explained, not rejected", () => {
  assert.equal(explainFailure("already_claimed").title, "Someone else claimed it first");
  assert.match(explainFailure("ENOTFOUND").title, /name could not be found/);
  assert.equal(explainFailure(404).title, "Page or item not found");
});

test("no explanation is empty, is a wall of text, or uses more than two sentences per field", () => {
  const inputs = [
    ...DISCOVERED_CODES.map(code => ({ code, message: `refused: ${code}` })),
    ...STATUSES.map(status => ({ status, message: "" })),
    { message: "fetch failed" },
    { message: "connect ECONNREFUSED 127.0.0.1:1" },
    { message: "some failure nobody has seen before" },
    { code: "unknown_code", message: "unknown_code: something new" },
  ];
  for (const input of inputs) {
    const explained = explainFailure(input);
    const where = JSON.stringify(input);
    for (const [field, value] of Object.entries(explained)) {
      assert.ok(value.trim().length > 0, `${field} is empty for ${where}`);
      assert.ok(!value.includes("\n"), `${field} has a line break for ${where}`);
      assert.ok(sentenceCount(value) <= 2, `${field} is more than two sentences for ${where}: ${value}`);
      assert.ok(value.length <= 220, `${field} is too long to read at a glance for ${where}`);
    }
  }
});

test("the fix says who can act when the failure is permission-bound", () => {
  for (const input of [{ code: "forbidden", message: "" }, { status: 403, message: "" }, { code: "not_approved", message: "" }]) {
    assert.match(explainFailure(input).fix, /Admin|Tier 2/, `no one to ask in the fix for ${JSON.stringify(input)}`);
  }
});

test("the one line a screen shows carries the title, what happened, and the fix", () => {
  const explained = explainFailure({ code: "forbidden", message: "" });
  const line = formatExplanation(explained);
  assert.ok(line.startsWith(`${explained.title}.`), "the line starts with the title");
  assert.ok(line.includes(explained.detail), "the line says what happened");
  assert.ok(line.endsWith(explained.fix), "the line ends with what to do next");
  assert.equal(/\s\s/.test(line), false, "no double spaces when a part is missing");
  assert.equal(/undefined|NaN|\[object/.test(line), false, "no raw value reaches a technician");
});

test("a known code never renders the hand-it-to-a-person line", () => {
  const known = formatExplanation(explainFailure({ code: "forbidden", message: "" }));
  const unknown = formatExplanation(explainFailure({ code: "some_future_code", message: "the sparkle module refused" }));
  assert.notEqual(known, unknown, "a code with its own entry must not fall through");
  assert.equal(known.includes("Copy this text"), false);
});

test("the line names the fields a contract check refused and the server's reason once", () => {
  const explained = explainFailure({ code: "weak_password", message: "" });
  assert.ok(formatExplanation(explained, { issues: ["password (minLength)", "password (notTheOldOne)"] }).includes("Check: password (minLength), password (notTheOldOne)."));

  const raw = "0.2.2 is already published";
  assert.equal(formatExplanation(explained, { reason: raw }).includes(raw), true, "the reason is shown");
  const generic = explainFailure({ message: raw });
  const line = formatExplanation(generic, { reason: raw });
  assert.equal(line.split(raw).length - 1, 1, "the reason is not repeated when it is already the detail");
});

test("an explanation sends people to the role that can actually do it", () => {
  // Only an Admin resumes writes, approves another Admin's package or baseline, and resets an authenticator.
  for (const code of ["writes_paused", "writes_paused_for_you", "same_person", "own_proposal", "no_approved_baseline"]) {
    const fix = explainFailure({ code, message: "" }).fix;
    assert.match(fix, /Admin/, code);
    assert.doesNotMatch(fix, /Tier 2/, code);
  }
  assert.match(explainFailure({ code: "totp_required", message: "" }).fix, /ask an Admin to reset it/);
  // already_claimed is only ever an alert someone else claimed (server/src/services/alerts.ts), never a cabinet.
  assert.match(explainFailure({ code: "already_claimed", message: "" }).detail, /claimed this alert/);
});
