// Runtime validation against the shared JSON Schema contracts.
// Every agent and console input passes through one of these validators before
// any other code touches it (docs/spec/STANDING-INSTRUCTIONS.md).
import { createAjv, readCatalog, ref } from "@mashura/cabinet-contracts/load";
import type {
  BulkFirewallPolicy,
  BulkScope,
  CatalogEntry,
  ConfirmPassword,
  FirewallPolicy,
  WatchedServices,
  DemoMode,
  CrashQuery,
  HealthQuery,
  SystemHealthQuery,
  DriveHealthReport,
  ReadingSearch,
  Command,
  CommandsResponse,
  EnrollRequest,
  EnrollResponse,
  EnrollStatus,
  Event,
  EventBatch,
  Heartbeat,
  OperationName,
  OperationTypes,
  RenewRequest,
  RenewResponse,
  Result,
  ServerAck,
  LoginRequest,
  CodeRequest,
  PasswordChange,
  StepUpRequest,
  CommandRequest,
  ScannerSettings,
  SyncSettings,
  ApproveEnrollment,
  StepUpOnly,
  HeartbeatResponse,
  UserCreate,
  UserReactivate,
  UsersQuery,
  UserUpdate,
  NameChange,
  SiteCreate,
  CabinetRole,
  SiteTimeZone,
  SiteNetworkBaseline,
  NetworkDiagnosisStart,
  FleetJob,
  FleetPreview,
  FleetCabinetsQuery,
  IssueType,
  PlatformSettings,
  AuditFilter,
  SecurityAlertFilter,
  SignInFilter,
  SecurityAlertResolve,
  SuppressionCreate,
  SymptomMatch,
  RulePreview,
  RuleProposal,
  RuleRollback,
  AlertResolve,
  KnownFixCreate,
  KnownFixQuery,
  ActivityReportQuery,
  KnownFixReject,
  AlertFilter,
  EventLookup,
  FleetSearch,
  RuleFilter,
  PackageUpload,
  WritePause,
  UpgradeKeys,
  UpgradeManifest,
  UpgradeSignature,
  UpgradeStatus,
  UpdateResponse,
  ReleaseCreate,
  RolloutStart,
  CabinetInOffice,
  SyncPorts,
} from "@mashura/cabinet-contracts/types";

export type * from "@mashura/cabinet-contracts/types";

/** One validation problem: where it is and what rule failed. Never the submitted value. */
export interface ContractIssue {
  path: string;
  rule: string;
}

export class ContractError extends Error {
  readonly schema: string;
  readonly issues: readonly ContractIssue[];
  constructor(schema: string, issues: readonly ContractIssue[]) {
    super(`Input does not match ${schema}`);
    this.name = "ContractError";
    this.schema = schema;
    this.issues = issues;
  }
}

const ajv = createAjv();

export interface Validator<T> {
  /** Type guard: true when data matches the schema. */
  is(data: unknown): data is T;
  /** Returns the data typed, or throws ContractError. */
  parse(data: unknown): T;
}

function validator<T>(name: string, id: string): Validator<T> {
  const check = ajv.getSchema(id);
  if (!check) throw new Error(`Contract schema not found: ${id}`);
  return {
    is: (data: unknown): data is T => check(data) === true,
    parse(data: unknown): T {
      if (check(data) === true) return data as T;
      // Report locations and failed keywords only. Values could be secrets
      // (bootstrap tokens) or hostile payloads, so they are never echoed.
      const issues = (check.errors ?? []).slice(0, 20).map(e => ({ path: e.instancePath || "/", rule: e.keyword }));
      throw new ContractError(name, issues);
    },
  };
}

const envelope = (file: string) => ref(`envelopes/${file}.schema.json`);

export const envelopes = {
  command: validator<Command>("command", envelope("command")),
  result: validator<Result>("result", envelope("result")),
  event: validator<Event>("event", envelope("event")),
  eventBatch: validator<EventBatch>("event-batch", envelope("event-batch")),
  heartbeat: validator<Heartbeat>("heartbeat", envelope("heartbeat")),
  serverAck: validator<ServerAck>("server-ack", envelope("server-ack")),
  commandsResponse: validator<CommandsResponse>("commands-response", envelope("commands-response")),
  enrollRequest: validator<EnrollRequest>("enroll-request", envelope("enroll-request")),
  enrollResponse: validator<EnrollResponse>("enroll-response", envelope("enroll-response")),
  enrollStatus: validator<EnrollStatus>("enroll-status", envelope("enroll-status")),
  renewRequest: validator<RenewRequest>("renew-request", envelope("renew-request")),
  renewResponse: validator<RenewResponse>("renew-response", envelope("renew-response")),
  heartbeatResponse: validator<HeartbeatResponse>("heartbeat-response", envelope("heartbeat-response")),
  upgradeStatus: validator<UpgradeStatus>("upgrade-status", envelope("upgrade-status")),
  updateResponse: validator<UpdateResponse>("update-response", envelope("update-response")),
} as const;

/** The release files (docs/spec/07-upgrade-channel.md) and the keys they are checked against. */
export const releaseFiles = {
  manifest: validator<UpgradeManifest>("upgrade-manifest", ref("agent/upgrade-manifest.schema.json")),
  signature: validator<UpgradeSignature>("upgrade-signature", ref("agent/upgrade-signature.schema.json")),
  keys: validator<UpgradeKeys>("upgrade-keys", ref("agent/upgrade-keys.schema.json")),
} as const;

/** Shared definitions checked on their own, such as a stored rule's match. */
export const commonDefs = {
  symptomMatch: validator<SymptomMatch>("symptomMatch", ref("common.schema.json", "symptomMatch")),
} as const;

const consoleBody = (file: string) => ref(`console/${file}.schema.json`);

/** Console request bodies. */
export type { KnownFixCreate };

export const consoleBodies = {
  login: validator<LoginRequest>("login-request", consoleBody("login-request")),
  code: validator<CodeRequest>("code-request", consoleBody("code-request")),
  passwordChange: validator<PasswordChange>("password-change", consoleBody("password-change")),
  stepUp: validator<StepUpRequest>("step-up-request", consoleBody("step-up-request")),
  confirmPassword: validator<ConfirmPassword>("confirm-password", consoleBody("confirm-password")),
  firewallPolicy: validator<FirewallPolicy>("firewall-policy", consoleBody("firewall-policy")),
  bulkFirewallPolicy: validator<BulkFirewallPolicy>("bulk-firewall-policy", consoleBody("bulk-firewall-policy")),
  bulkScope: validator<BulkScope>("bulk-scope", consoleBody("bulk-scope")),
  watchedServices: validator<WatchedServices>("watched-services", consoleBody("watched-services")),
  demoMode: validator<DemoMode>("demo-mode", consoleBody("demo-mode")),
  crashQuery: validator<CrashQuery>("crash-query", consoleBody("crash-query")),
  readingSearch: validator<ReadingSearch>("reading-search", consoleBody("reading-search")),
  healthQuery: validator<HealthQuery>("health-query", consoleBody("health-query")),
  command: validator<CommandRequest>("command-request", consoleBody("command-request")),
  scanner: validator<ScannerSettings>("scanner-settings", consoleBody("scanner-settings")),
  sync: validator<SyncSettings>("sync-settings", consoleBody("sync-settings")),
  approve: validator<ApproveEnrollment>("approve-enrollment", consoleBody("approve-enrollment")),
  stepUpOnly: validator<StepUpOnly>("step-up-only", consoleBody("step-up-only")),
  rulePreview: validator<RulePreview>("rule-preview", consoleBody("rule-preview")),
  ruleProposal: validator<RuleProposal>("rule-proposal", consoleBody("rule-proposal")),
  ruleRollback: validator<RuleRollback>("rule-rollback", consoleBody("rule-rollback")),
  alertResolve: validator<AlertResolve>("alert-resolve", consoleBody("alert-resolve")),
  knownFixCreate: validator<KnownFixCreate>("known-fix-create", consoleBody("known-fix-create")),
  knownFixReject: validator<KnownFixReject>("known-fix-reject", consoleBody("known-fix-reject")),
  knownFixQuery: validator<KnownFixQuery>("known-fix-query", consoleBody("known-fix-query")),
  activityReportQuery: validator<ActivityReportQuery>("activity-report-query", consoleBody("activity-report-query")),
  alertFilter: validator<AlertFilter>("alert-filter", consoleBody("alert-filter")),
  eventLookup: validator<EventLookup>("event-lookup", consoleBody("event-lookup")),
  fleetSearch: validator<FleetSearch>("fleet-search", consoleBody("fleet-search")),
  ruleFilter: validator<RuleFilter>("rule-filter", consoleBody("rule-filter")),
  packageUpload: validator<PackageUpload>("package-upload", consoleBody("package-upload")),
  writePause: validator<WritePause>("write-pause", consoleBody("write-pause")),
  userCreate: validator<UserCreate>("user-create", consoleBody("user-create")),
  userReactivate: validator<UserReactivate>("user-reactivate", consoleBody("user-reactivate")),
  usersQuery: validator<UsersQuery>("users-query", consoleBody("users-query")),
  userUpdate: validator<UserUpdate>("user-update", consoleBody("user-update")),
  nameChange: validator<NameChange>("name-change", consoleBody("name-change")),
  siteCreate: validator<SiteCreate>("site-create", consoleBody("site-create")),
  cabinetRole: validator<CabinetRole>("cabinet-role", consoleBody("cabinet-role")),
  siteTimeZone: validator<SiteTimeZone>("site-time-zone", consoleBody("site-time-zone")),
  siteNetworkBaseline: validator<SiteNetworkBaseline>("site-network-baseline", consoleBody("site-network-baseline")),
  networkDiagnosisStart: validator<NetworkDiagnosisStart>("network-diagnosis-start", consoleBody("network-diagnosis-start")),
  fleetJob: validator<FleetJob>("fleet-job", consoleBody("fleet-job")),
  fleetPreview: validator<FleetPreview>("fleet-preview", consoleBody("fleet-preview")),
  fleetCabinetsQuery: validator<FleetCabinetsQuery>("fleet-cabinets-query", consoleBody("fleet-cabinets-query")),
  issueType: validator<IssueType>("issue-type", consoleBody("issue-type")),
  platformSettings: validator<PlatformSettings>("platform-settings", consoleBody("platform-settings")),
  auditFilter: validator<AuditFilter>("audit-filter", consoleBody("audit-filter")),
  systemHealthQuery: validator<SystemHealthQuery>("system-health-query", consoleBody("system-health-query")),
  securityAlertFilter: validator<SecurityAlertFilter>("security-alert-filter", consoleBody("security-alert-filter")),
  signInFilter: validator<SignInFilter>("sign-in-filter", consoleBody("sign-in-filter")),
  securityAlertResolve: validator<SecurityAlertResolve>("security-alert-resolve", consoleBody("security-alert-resolve")),
  suppressionCreate: validator<SuppressionCreate>("suppression-create", consoleBody("suppression-create")),
  releaseCreate: validator<ReleaseCreate>("release-create", consoleBody("release-create")),
  rolloutStart: validator<RolloutStart>("rollout-start", consoleBody("rollout-start")),
  cabinetInOffice: validator<CabinetInOffice>("cabinet-in-office", consoleBody("cabinet-in-office")),
  syncPorts: validator<SyncPorts>("sync-ports", consoleBody("sync-ports")),
} as const;

/** The compiled-in operation catalog, keyed by name. */
export const catalog: ReadonlyMap<OperationName, CatalogEntry> = new Map(
  readCatalog().operations.map(entry => [entry.name, entry]),
);

export function isOperationName(value: unknown): value is OperationName {
  return typeof value === "string" && catalog.has(value as OperationName);
}

type OperationValidators = {
  [O in OperationName]: { params: Validator<OperationTypes[O]["params"]>; output: Validator<OperationTypes[O]["output"]> };
};

export const operations = Object.fromEntries(
  [...catalog.keys()].map(name => [
    name,
    {
      params: validator(`${name} params`, ref(`operations/${name}.schema.json`, "params")),
      output: validator(`${name} output`, ref(`operations/${name}.schema.json`, "output")),
    },
  ]),
) as OperationValidators;
