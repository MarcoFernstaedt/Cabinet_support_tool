/* eslint-disable */
// GENERATED from contracts/schemas by contracts/scripts/generate-ts.mjs. Do not edit.
// Types only. Validate data at runtime with the schemas (contracts/load.mjs); these types
// describe data that has already passed validation.

export interface PortRange {
  from: number;
  to: number;
}

/**
 * One Windows firewall rule, as structured fields only. No free-text rule strings.
 */
export interface FirewallRule {
  name: string;
  direction: "in" | "out";
  action: "allow" | "block";
  protocol: "any" | "tcp" | "udp" | "icmpv4";
  /**
   * @maxItems 16
   */
  localPorts?: PortRange[];
  /**
   * @maxItems 16
   */
  remotePorts?: PortRange[];
  /**
   * @maxItems 16
   */
  localAddresses?: string[];
  /**
   * @maxItems 16
   */
  remoteAddresses?: string[];
  /**
   * Absolute local path to a program file. No relative segments, UNC, device or wildcard paths.
   */
  programPath?: string;
  /**
   * @minItems 1
   * @maxItems 3
   */
  profiles: ["domain" | "private" | "public", ...("domain" | "private" | "public")[]];
  enabled: boolean;
}

/**
 * A firewall rule as read back from Windows. Wider than firewallRule because existing rules may use features the platform never writes.
 */
export interface ReportedFirewallRule {
  /**
   * A single line of text with no control characters.
   */
  name: string;
  displayGroup?: string | null;
  direction: "in" | "out";
  action: "allow" | "block";
  /**
   * A single line of text with no control characters.
   */
  protocol?: string;
  /**
   * A single line of text with no control characters.
   */
  localPorts?: string;
  /**
   * A single line of text with no control characters.
   */
  remotePorts?: string;
  /**
   * A single line of text with no control characters.
   */
  localAddresses?: string;
  /**
   * A single line of text with no control characters.
   */
  remoteAddresses?: string;
  programPath?: string | null;
  /**
   * @maxItems 3
   */
  profiles?: ("domain" | "private" | "public")[];
  enabled: boolean;
  /**
   * True for rules whose name starts with MashuraDiag.
   */
  createdByPlatform: boolean;
}

export interface FirewallProfileState {
  profile: "domain" | "private" | "public";
  enabled: boolean;
  defaultInbound: "allow" | "block";
  defaultOutbound: "allow" | "block";
  /**
   * When a temporarily disabled profile turns itself back on; null when no timer is running.
   */
  reenableAt: string | null;
}

export interface Ipv4Settings {
  dhcp: boolean;
  /**
   * @maxItems 16
   */
  addresses: {
    address: string;
    prefixLength: number;
  }[];
  /**
   * @maxItems 8
   */
  gateways: string[];
}

export interface DnsSettings {
  automatic: boolean;
  /**
   * @maxItems 4
   */
  servers: string[];
}

/**
 * What a symptom rule matches: structured fields only, all of which must agree (docs/spec/05-server-spec.md). The phrase is a plain case-insensitive substring of the message; there are no regular expressions.
 */
export interface SymptomMatch {
  kind?: "error" | "firewall_changed" | "smart_warning" | "agent_status" | "security" | "scanner";
  /**
   * The event logs the agent may read, compiled in (docs/spec/04-agent-spec.md, widened in milestone 1 to every channel useful for diagnosis; see docs/spec/09-open-decisions.md). Logs that record sign-ins, credentials, remote sessions, script or command text, or printed document names are never readable: Security, PowerShell, Sysmon, Winlogon, User Profile, TerminalServices, NTLM, Kerberos, CAPI2, AAD and PrintService/Operational are deliberately absent.
   */
  log?:
    | "System"
    | "Application"
    | "Setup"
    | "HardwareEvents"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-Kernel-PnP/Driver Watchdog"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-UserPnp/DeviceInstall"
    | "Microsoft-Windows-DeviceSetupManager/Admin"
    | "Microsoft-Windows-DeviceSetupManager/Operational"
    | "Microsoft-Windows-Biometrics/Operational"
    | "Microsoft-Windows-CodeIntegrity/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Kernel-WHEA/Operational"
    | "Microsoft-Windows-Kernel-Power/Thermal-Operational"
    | "Microsoft-Windows-Kernel-Boot/Operational"
    | "Microsoft-Windows-Kernel-IO/Operational"
    | "Microsoft-Windows-Diagnostics-Performance/Operational"
    | "Microsoft-Windows-Resource-Exhaustion-Detector/Operational"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Storage-Storport/Health"
    | "Microsoft-Windows-Storage-ClassPnP/Operational"
    | "Microsoft-Windows-StorageSpaces-Driver/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-Partition/Diagnostic"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-NCSI/Operational"
    | "Microsoft-Windows-TCPIP/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-Dhcp-Client/Operational"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-WLAN-AutoConfig/Operational"
    | "Microsoft-Windows-SMBClient/Connectivity"
    | "Microsoft-Windows-SMBClient/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-Time-Service/Operational"
    | "Microsoft-Windows-WindowsUpdateClient/Operational"
    | "Microsoft-Windows-Bits-Client/Operational"
    | "Microsoft-Windows-TaskScheduler/Operational"
    | "Microsoft-Windows-PrintService/Admin"
    | "Microsoft-Windows-Windows Defender/Operational"
    | "Microsoft-Windows-GroupPolicy/Operational";
  source?: string;
  eventId?: number;
  level?: "critical" | "error" | "warning" | "information" | "verbose";
  /**
   * Plug and Play hardware ID such as USB\VID_1234&PID_5678.
   */
  hardwareId?: string;
  phrase?: string;
}

/**
 * Each firewall profile's on/off state: what the heartbeat reports and what a client's firewall policy asks for.
 */
export interface FirewallProfileSwitches {
  domain: boolean;
  private: boolean;
  public: boolean;
}

/**
 * One watched service as the broker's watcher sees it (docs/spec/12-milestones-8-to-12.md).
 */
export interface WatchedServiceStatus {
  /**
   * A Windows service's key name (not its display name). Letters, digits, _ . $ - and inner spaces; SQL Server's MSSQL$NAME form included.
   */
  name: string;
  /**
   * running: as it should be; restarted: started again by the watcher in the last 10 minutes; failing: 3 restarts in a row failed; missing: no such service; disabled: its start type is Disabled; refused: the agent never starts it (its own services, remote access); waiting: not checked yet.
   */
  state: "running" | "restarted" | "failing" | "missing" | "disabled" | "refused" | "waiting";
  serviceState:
    | (
        | "running"
        | "stopped"
        | "start_pending"
        | "stop_pending"
        | "paused"
        | "pause_pending"
        | "continue_pending"
        | "unknown"
      )
    | null;
  restartsToday: number;
  consecutiveFailures: number;
  lastRestartAt: string | null;
  /**
   * The last Windows error code a start attempt returned, if any.
   */
  lastError: number | null;
  checkedAt: string | null;
}

/**
 * Services that must always be running; the broker starts them again when they stop.
 *
 * @maxItems 16
 */
export type WatchedServiceNames = string[];

/**
 * What a site's network should look like (set by a Tier 2 or Admin): whether cabinets take their address from DHCP or have fixed ones, the subnet's size, the gateway, and the DNS servers. The diagnosis compares each cabinet with it.
 */
export interface NetworkBaseline {
  addressing: "dhcp" | "static";
  prefixLength: number;
  gateway: string;
  /**
   * @minItems 1
   * @maxItems 4
   */
  dnsServers: [string, ...string[]];
}

/**
 * What an agent release must be signed with, compiled into the agent (docs/spec/07-upgrade-channel.md): the public half of the release signing key, with room for one future key while the key is changed, and the code-signing publisher whose Authenticode signature every agent binary must carry. A publisher is trusted only when its certificate's common name and organization match exactly and its chain ends at the pinned root. Only a signed agent upgrade can change the agent's copy. An empty list means this build accepts no upgrades, and checks its own files against no one.
 */
export interface UpgradeKeys {
  version: number;
  /**
   * @maxItems 2
   */
  keys: {
    /**
     * SHA-256 of the key's DER SubjectPublicKeyInfo, lower-case hex.
     */
    keyId: string;
    name: string;
    /**
     * Base64 of the DER SubjectPublicKeyInfo of an ECDSA P-256 key.
     */
    publicKey: string;
  }[];
  /**
   * @maxItems 2
   */
  publishers: {
    commonName: string;
    organization: string;
    /**
     * SHA-256 of the pinned root certificate (DER).
     */
    root: string;
    rootFile: string;
  }[];
}

/**
 * What a signed agent release contains (docs/spec/07-upgrade-channel.md "Package format"). The build pipeline writes it and has its exact bytes signed by the release key in the KMS; the agent checks that signature against the public key compiled into it before it reads anything else. product stops a signature made for something else from being taken as an agent release.
 */
export interface UpgradeManifest {
  product: "mashura-cabinet-agent";
  /**
   * The version this release installs. Always higher than any earlier release: a rollback ships older code under a higher number.
   */
  version: string;
  /**
   * The oldest installed version this release may upgrade.
   */
  minimumVersion: string;
  /**
   * SHA-256 of the package zip.
   */
  sha256: string;
  sizeBytes: number;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  releasedAt: string;
  notes?: string;
}

/**
 * The detached signature over a release manifest's exact bytes: ECDSA P-256 over the SHA-256 of the manifest, DER-encoded, made by the release key in the KMS. keyId names which of the agent's compiled-in keys made it (the SHA-256 of that key's SubjectPublicKeyInfo), so a second, future key can be added before it is used.
 */
export interface UpgradeSignature {
  /**
   * Lower-case hex SHA-256 digest.
   */
  keyId: string;
  algorithm: "ecdsa-p256-sha256";
  /**
   * Base64 of the DER-encoded ECDSA signature (at most 72 bytes).
   */
  signature: string;
}

/**
 * The Alerts list's filters, from the query string.
 */
export interface AlertFilter {
  severity?: "major" | "minor";
  state?: "open" | "claimed" | "resolved" | "active";
  issueTypeId?: string;
  unrecognized?: "true" | "false";
  clientId?: string;
  siteId?: string;
  cabinetId?: string;
  claimedBy?: string | "me";
}

/**
 * Resolve a claimed alert, with an optional note on what fixed it.
 */
export interface AlertResolve {
  note?: string;
}

/**
 * Approve a pending cabinet: where it belongs and what it is called.
 */
export interface ApproveEnrollment {
  client: string;
  site: string;
  cabinet: string;
  role: "sync" | "satellite" | "standalone";
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * The audit log search, from the query string: by user, cabinet, action and date range, newest first.
 */
export interface AuditFilter {
  user?: string;
  cabinet?: string;
  action?: string;
  /**
   * A date or UTC time from the query string.
   */
  from?: string;
  /**
   * A date or UTC time from the query string.
   */
  to?: string;
  before?: string;
  limit?: string;
}

/**
 * Apply the client's firewall policy to every online, writable cabinet of one site or one client that differs from it (at most 200). Needs a password confirmation token for bulk.firewall_policy on that site or client, bound to these parameters ({scope, id}).
 */
export interface BulkFirewallPolicy {
  scope: "site" | "client";
  id: string;
  stepUpToken: string;
}

/**
 * From the query string: the site or client a bulk change would cover, to preview which cabinets it would change.
 */
export interface BulkScope {
  scope: "site" | "client";
  id: string;
}

/**
 * Marks a cabinet as one of the in-office cabinets, which form batch 2 of every staged agent rollout.
 */
export interface CabinetInOffice {
  inOffice: boolean;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Changes a cabinet's role at its site.
 */
export interface CabinetRole {
  role: "sync" | "satellite" | "standalone";
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * An authenticator code: the second sign-in step, or confirming authenticator setup.
 */
export interface CodeRequest {
  /**
   * A 6-digit authenticator code.
   */
  code: string;
}

/**
 * Run one catalog operation on the cabinet in the URL. Parameters are validated again against the operation's own schema. A write operation also carries a step-up token for that operation on that cabinet.
 */
export interface CommandRequest {
  /**
   * Every operation in the agent catalog (contracts/schemas/operations/catalog.json).
   */
  operation:
    | "system.info"
    | "eventlog.channels"
    | "eventlog.query"
    | "eventlog.get"
    | "devices.list"
    | "drivers.list"
    | "peripheral.status"
    | "updates.status"
    | "disk.smart"
    | "files.list"
    | "network.config"
    | "network.test"
    | "firewall.state"
    | "network.setIp"
    | "network.setDns"
    | "firewall.setProfile"
    | "firewall.applyPolicy"
    | "firewall.setRule"
    | "firewall.restore"
    | "package.install"
    | "driver.uninstall"
    | "services.list"
    | "processes.list"
    | "service.control"
    | "time.status"
    | "time.setZone"
    | "time.sync";
  params: {};
  /**
   * A one-time step-up token bound to this operation on this cabinet. Required for writes, refused for reads.
   */
  stepUpToken?: string;
}

/**
 * Confirms a change to more than one cabinet with the person's password again (docs/spec/12-milestones-8-to-12.md). The token is bound to the action, the scope and the exact parameters.
 */
export interface ConfirmPassword {
  password: string;
  action: "bulk.firewall_policy" | "fleet.job";
  target: string;
  paramsHash: string;
}

/**
 * The crash investigation's window, from the query string: one cabinet (days back) or the fleet incident view (from, to and an optional client). The server limits the window to 90 days.
 */
export interface CrashQuery {
  days?: "1" | "3" | "7" | "14" | "30" | "60" | "90";
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  from?: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  to?: string;
  clientId?: string;
}

/**
 * An Admin turns demo mode on (adds the simulated demo clients, sites and cabinets next to the real ones) or off (deletes all of them). Real cabinets are never touched. reset (with enabled true) deletes the simulated fleet and builds it again from the same scenarios, for a repeatable demonstration. Every change is confirmed with an authenticator code: the step-up token is bound to this exact body.
 */
export interface DemoMode {
  enabled: boolean;
  reset?: true;
  /**
   * A one-time step-up token for demo.change on fleet, bound to this body.
   */
  stepUpToken: string;
}

/**
 * From the query string: an event log entry read from a cabinet, to show which issue it maps to and how many other cabinets reported it.
 */
export interface EventLookup {
  cabinetId: string;
  /**
   * The event logs the agent may read, compiled in (docs/spec/04-agent-spec.md, widened in milestone 1 to every channel useful for diagnosis; see docs/spec/09-open-decisions.md). Logs that record sign-ins, credentials, remote sessions, script or command text, or printed document names are never readable: Security, PowerShell, Sysmon, Winlogon, User Profile, TerminalServices, NTLM, Kerberos, CAPI2, AAD and PrintService/Operational are deliberately absent.
   */
  log:
    | "System"
    | "Application"
    | "Setup"
    | "HardwareEvents"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-Kernel-PnP/Driver Watchdog"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-UserPnp/DeviceInstall"
    | "Microsoft-Windows-DeviceSetupManager/Admin"
    | "Microsoft-Windows-DeviceSetupManager/Operational"
    | "Microsoft-Windows-Biometrics/Operational"
    | "Microsoft-Windows-CodeIntegrity/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Kernel-WHEA/Operational"
    | "Microsoft-Windows-Kernel-Power/Thermal-Operational"
    | "Microsoft-Windows-Kernel-Boot/Operational"
    | "Microsoft-Windows-Kernel-IO/Operational"
    | "Microsoft-Windows-Diagnostics-Performance/Operational"
    | "Microsoft-Windows-Resource-Exhaustion-Detector/Operational"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Storage-Storport/Health"
    | "Microsoft-Windows-Storage-ClassPnP/Operational"
    | "Microsoft-Windows-StorageSpaces-Driver/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-Partition/Diagnostic"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-NCSI/Operational"
    | "Microsoft-Windows-TCPIP/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-Dhcp-Client/Operational"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-WLAN-AutoConfig/Operational"
    | "Microsoft-Windows-SMBClient/Connectivity"
    | "Microsoft-Windows-SMBClient/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-Time-Service/Operational"
    | "Microsoft-Windows-WindowsUpdateClient/Operational"
    | "Microsoft-Windows-Bits-Client/Operational"
    | "Microsoft-Windows-TaskScheduler/Operational"
    | "Microsoft-Windows-PrintService/Admin"
    | "Microsoft-Windows-Windows Defender/Operational"
    | "Microsoft-Windows-GroupPolicy/Operational";
  /**
   * A single line of text with no control characters.
   */
  source: string;
  eventId: string;
}

/**
 * An Admin sets a client's (or the fleet default) firewall policy: each profile on or off. null for a client removes its own policy, so the fleet default applies.
 */
export interface FirewallPolicy {
  policy: {
    domain: "on" | "off";
    private: "on" | "off";
    public: "on" | "off";
  } | null;
  stepUpToken: string;
}

/**
 * Which cabinets the Fleet operations page lists, from the query string: a client, a site, and a problem to narrow to.
 */
export interface FleetCabinetsQuery {
  clientId?: string;
  siteId?: string;
  problem?: "any" | "time_zone_wrong" | "clock_off" | "firewall_drift";
}

/**
 * Starts a fleet operation (docs/spec/13-roadmap.md modules 21 and 45): one fixed operation on up to 200 chosen cabinets, as a job with a fixed target list, run in batches, each cabinet's result and verification recorded. The parameters come from the server: each cabinet's site's zone for time.setZone, its client's policy for firewall.applyPolicy. Confirmed with the password: the token (action fleet.job, target jobId) is bound to {operation, cabinetIds, batchSize}. For network.setDns and network.setIp the server takes each cabinet's change from its latest network diagnosis (at most 30 minutes old); a cabinet without a current finding is skipped.
 */
export interface FleetJob {
  /**
   * Chosen by the console, so the confirmation is bound to this one job.
   */
  jobId: string;
  operation: "time.setZone" | "time.sync" | "firewall.applyPolicy" | "network.setDns" | "network.setIp";
  /**
   * @minItems 1
   * @maxItems 200
   */
  cabinetIds: [string, ...string[]];
  /**
   * How many cabinets are changed at a time; the next batch starts when this one has answered.
   */
  batchSize: number;
  stepUpToken: string;
}

/**
 * Shows what a fleet operation would do on each chosen cabinet, and which it would skip and why, without changing anything.
 */
export interface FleetPreview {
  operation: "time.setZone" | "time.sync" | "firewall.applyPolicy" | "network.setDns" | "network.setIp";
  /**
   * @minItems 1
   * @maxItems 200
   */
  cabinetIds: [string, ...string[]];
}

/**
 * From the query string: the jump-to box's text. Matched literally (wildcards have no meaning) against client, site, cabinet and host names.
 */
export interface FleetSearch {
  q: string;
}

/**
 * Creates or edits an issue type.
 */
export interface IssueType {
  name: string;
  severity: "major" | "minor";
  description: string;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Username and password, the first sign-in step.
 */
export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * Creates or renames a client or site.
 */
export interface NameChange {
  name: string;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Starts the network diagnosis on up to 60 chosen cabinets, or on every active cabinet of one site. Read only: it runs the same reads and tests as one cabinet's diagnosis, as the person who asked.
 */
export type NetworkDiagnosisStart =
  | {
      /**
       * @minItems 1
       * @maxItems 60
       */
      cabinetIds: [string, ...string[]];
    }
  | {
      siteId: string;
    };

/**
 * Starts a software library upload: what the package is. The file itself follows in a second request, and is checked (hash, signature, trusted publisher) before anyone can approve it.
 */
export interface PackageUpload {
  name: string;
  version: string;
  vendor: string;
  packageType: "driver" | "msi";
  /**
   * @maxItems 16
   */
  hardwareIds: string[];
  notes?: string;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Change the signed-in user's password.
 */
export interface PasswordChange {
  currentPassword: string;
  /**
   * At least 12 characters.
   */
  newPassword: string;
}

/**
 * An Admin changes platform settings. Only the settings sent change.
 */
export interface PlatformSettings {
  offlineAlertDays?: number;
  sessionIdleMinutes?: number;
  sessionAbsoluteHours?: number;
  retention?: {
    eventsDays?: number;
    commandsDays?: number;
    alertsDays?: number;
    firewallDays?: number;
    /**
     * Network diagnoses and their findings.
     */
    diagnosesDays?: number;
    /**
     * Boot records used for reboot-loop detection and crash timelines.
     */
    bootsDays?: number;
    /**
     * Fleet operation jobs and their per-cabinet results (the commands and the audit log stay).
     */
    jobsDays?: number;
  };
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Adds a signed agent release to the update store (docs/spec/07-upgrade-channel.md step 3): the manifest exactly as the pipeline signed it, and its detached signature. The server checks the signature against the release keys it knows of; the package zip follows in a second request and must match the manifest's hash and size. None of this is the protection: each agent checks everything again against its own compiled-in key.
 */
export interface ReleaseCreate {
  /**
   * Base64 of the manifest's exact bytes.
   */
  manifest: string;
  signature: UpgradeSignature;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Starts a staged rollout of one release (docs/spec/07-upgrade-channel.md "Staged rollout"): batch 1 is the one cabinet named here, batch 2 the in-office cabinets, batch 3 about 5 percent of the rest of the fleet, batch 4 everyone else. A batch must reach successRatePercent before the next starts; failures above failureLimitPercent of a batch pause the rollout on their own.
 */
export interface RolloutStart {
  /**
   * Semantic version of the agent.
   */
  version: string;
  /**
   * The one cabinet in batch 1.
   */
  pilotCabinetId: string;
  successRatePercent: number;
  failureLimitPercent: number;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * The rules list's filters, from the query string.
 */
export interface RuleFilter {
  state?: "proposed" | "live" | "disabled" | "expired" | "rejected";
  issueTypeId?: string;
}

/**
 * Asks how many events across the fleet in the last 30 days a rule would have matched, and on how many cabinets.
 */
export interface RulePreview {
  match: SymptomMatch;
}

/**
 * Map to issue: a new symptom rule for an existing issue type, or (Admins only) for a new issue type created with it. A Tier 2 user's rule waits for an Admin; an Admin's goes live at once.
 */
export type RuleProposal = {
  issueTypeId?: string;
  /**
   * Admins only: create this issue type and map the error to it in one step.
   */
  newIssueType?: {
    name: string;
    severity: "major" | "minor";
    description: string;
  };
  match: SymptomMatch;
  /**
   * How serious this symptom is, overriding the issue type's own: major alerts show on the home page and in the Alerts tab, minor ones only on their cabinet. Omitted: the issue type's severity.
   */
  severity?: "major" | "minor";
  /**
   * Move matching open unrecognized alerts under the issue when the rule goes live.
   */
  regroup: boolean;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
} & {
  [k: string]: unknown | undefined;
};

/**
 * Put a rule back to one of its earlier versions.
 */
export interface RuleRollback {
  version: number;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * The fingerprint scanner's hardware IDs for the fleet default, a client, a site or one cabinet; the most specific one set applies. null removes that level's setting. An ID may be a whole hardware ID (USB\\VID_1234&PID_5678) or a vendor prefix (USB\\VID_1234), which matches every model from that vendor. With none set anywhere, cabinets find the scanner themselves (the Biometric device class).
 */
export interface ScannerSettings {
  hardwareIds: [string, ...string[]] | null;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * The security alerts list's filter, from the query string.
 */
export interface SecurityAlertFilter {
  state?: "open" | "resolved" | "all";
}

/**
 * An Admin closes a security alert, saying what was found.
 */
export interface SecurityAlertResolve {
  note: string;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Creates a site in a client.
 */
export interface SiteCreate {
  clientId: string;
  name: string;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Sets a site's network baseline, or clears it with null. Confirmed with an authenticator code bound to this exact baseline. Nothing changes on a cabinet; the network diagnosis compares cabinets with it.
 */
export interface SiteNetworkBaseline {
  baseline: NetworkBaseline | null;
  stepUpToken: string;
}

/**
 * Sets the Windows time zone a site's cabinets should use (Tier 2 and up), or clears it with null. Cabinets in another zone get a minor alert; nothing changes on a cabinet until someone corrects it.
 */
export interface SiteTimeZone {
  timeZone:
    | (
        | "Eastern Standard Time"
        | "Central Standard Time"
        | "Mountain Standard Time"
        | "US Mountain Standard Time"
        | "Pacific Standard Time"
        | "Alaskan Standard Time"
        | "Hawaiian Standard Time"
      )
    | null;
}

/**
 * An action that needs nothing but its step-up token.
 */
export interface StepUpOnly {
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Asks for a step-up token for one action on one target, with a fresh authenticator code, optionally bound to the exact parameters (docs/spec/12-milestones-8-to-12.md confirmation levels).
 */
export interface StepUpRequest {
  /**
   * A 6-digit authenticator code.
   */
  code: string;
  action:
    | "enrollment.approve"
    | "enrollment.reject"
    | "token.create"
    | "demo.change"
    | "cabinet.revoke"
    | "settings.scanner"
    | "cabinet.scanner"
    | "site.sync"
    | "rule.propose"
    | "rule.approve"
    | "rule.reject"
    | "rule.disable"
    | "rule.rollback"
    | "network.setIp"
    | "network.setDns"
    | "firewall.restore"
    | "package.install"
    | "driver.uninstall"
    | "package.upload"
    | "package.approve"
    | "package.retire"
    | "writes.pause"
    | "writes.resume"
    | "user.create"
    | "user.update"
    | "user.delete"
    | "user.password.reset"
    | "user.totp.reset"
    | "user.resume_writes"
    | "client.create"
    | "client.rename"
    | "client.remove"
    | "site.create"
    | "site.rename"
    | "site.remove"
    | "cabinet.role"
    | "issue_type.create"
    | "issue_type.update"
    | "settings.update"
    | "security_alert.resolve"
    | "rule.suppress"
    | "rule.renew"
    | "cabinet.in_office"
    | "release.add"
    | "rollout.start"
    | "rollout.pause"
    | "rollout.resume"
    | "rollout.stop"
    | "client.scanner"
    | "site.scanner"
    | "client.sync"
    | "settings.sync"
    | "client.firewall_policy"
    | "fleet.firewall_policy"
    | "site.network_baseline";
  /**
   * The ID the action applies to, or 'fleet'.
   */
  target: string | "fleet";
  /**
   * SHA-256 (lowercase hex) of the canonical JSON of the exact parameters the person confirmed: keys sorted at every level, no spaces. Required for a write to a cabinet; the token then works only for those parameters.
   */
  paramsHash?: string;
}

/**
 * An Admin marks a known harmless event as ignore. A written reason is required; it expires after 90 days unless renewed.
 */
export interface SuppressionCreate {
  match: SymptomMatch;
  reason: string;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Default TCP ports for testing the sync cabinet: a client's (for all its sites) or the fleet's. null removes that level's setting. A site's own ports, when set, win.
 */
export interface SyncPorts {
  ports: number[] | null;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * A site's sync cabinet: a private IPv4 address, and at most 4 TCP ports. ports null uses the client's default ports, else the fleet default. Each cabinet also refuses an address that is not on its own network.
 */
export interface SyncSettings {
  address: string | null;
  ports: number[] | null;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * An Admin creates an account. The server makes a temporary password, shown once.
 */
export interface UserCreate {
  username: string;
  name: string;
  role: "tier1" | "tier2" | "admin";
  /**
   * Write commands allowed per hour before the user's writes pause.
   */
  writeLimit?: number;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * An Admin changes an account's role, hourly write limit or status. At least one change.
 */
export interface UserUpdate {
  role?: "tier1" | "tier2" | "admin";
  /**
   * Write commands allowed per hour before the user's writes pause.
   */
  writeLimit?: number;
  status?: "active" | "disabled";
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Tier 2 and up set the services one level (fleet, client, site or cabinet) keeps running; null removes that level's list so the level above applies. A confirmation click; no code.
 */
export interface WatchedServices {
  names: WatchedServiceNames | null;
}

/**
 * Pauses or resumes write operations fleet-wide or for one client. Reads keep working.
 */
export interface WritePause {
  paused: boolean;
  reason?: string;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Command envelope: one operation for one cabinet, issued by one person (docs/spec/03-protocol.md).
 */
export interface Command {
  commandId: string;
  cabinetId: string;
  /**
   * Every operation in the agent catalog (contracts/schemas/operations/catalog.json).
   */
  operation:
    | "system.info"
    | "eventlog.channels"
    | "eventlog.query"
    | "eventlog.get"
    | "devices.list"
    | "drivers.list"
    | "peripheral.status"
    | "updates.status"
    | "disk.smart"
    | "files.list"
    | "network.config"
    | "network.test"
    | "firewall.state"
    | "network.setIp"
    | "network.setDns"
    | "firewall.setProfile"
    | "firewall.applyPolicy"
    | "firewall.setRule"
    | "firewall.restore"
    | "package.install"
    | "driver.uninstall"
    | "services.list"
    | "processes.list"
    | "service.control"
    | "time.status"
    | "time.setZone"
    | "time.sync";
  params: {};
  issuedBy: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  issuedAt: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  expiresAt: string;
}

/**
 * Long-poll response: waiting commands for this cabinet, or an empty list after up to 25 seconds.
 */
export interface CommandsResponse {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  serverTime: string;
  /**
   * @maxItems 50
   */
  commands: Command[];
}

/**
 * POST /agent/v1/enroll: the only call accepted without a client certificate.
 */
export interface EnrollRequest {
  csr: string;
  bootstrapToken: string;
  fingerprints: {
    /**
     * Windows computer name or DNS host name.
     */
    hostname: string;
    serialNumber: string | null;
    /**
     * @maxItems 16
     */
    macAddresses: string[];
    provisionedClient: string | null;
    provisionedSite: string | null;
    /**
     * UTC time, ISO 8601, always ending in Z.
     */
    onlineSince: string;
    /**
     * A single line of text with no control characters.
     */
    osVersion: string;
    /**
     * Semantic version of the agent.
     */
    agentVersion: string;
  };
}

/**
 * Reply to an enrollment request: it waits in the pending queue.
 */
export interface EnrollResponse {
  requestId: string;
  status: "pending";
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  serverTime: string;
}

/**
 * GET /agent/v1/enroll/{requestId}: pending, rejected, or the issued certificate.
 */
export interface EnrollStatus {
  requestId: string;
  status: "pending" | "rejected" | "issued";
  certificate?: string;
  caChain?: string;
  cabinetId?: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  serverTime: string;
}

/**
 * Events sent together, up to 100 per request.
 */
export interface EventBatch {
  /**
   * @minItems 1
   * @maxItems 100
   */
  events: [Event, ...Event[]];
}

/**
 * Agent-originated event: detected errors and changes (docs/spec/03-protocol.md). kind scanner comes from the fingerprint scanner watcher and carries the device and its state instead of a log record. kind service comes from the broker's service watcher; detail.fields carries service (its name), change (restarted, failing, recovered, missing, disabled) and, when known, errorCode. kind change is a system change the agent records as it happens, so it is known even if the cabinet later cannot boot: an update installed, a driver or service installed, software installed or removed, Windows starting or shutting down, a restart and who asked for it. It carries its log record like error.
 */
export interface Event {
  eventId: string;
  kind: "error" | "firewall_changed" | "smart_warning" | "agent_status" | "security" | "scanner" | "service" | "change";
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  occurredAt: string;
  source?: {
    /**
     * The event logs the agent may read, compiled in (docs/spec/04-agent-spec.md, widened in milestone 1 to every channel useful for diagnosis; see docs/spec/09-open-decisions.md). Logs that record sign-ins, credentials, remote sessions, script or command text, or printed document names are never readable: Security, PowerShell, Sysmon, Winlogon, User Profile, TerminalServices, NTLM, Kerberos, CAPI2, AAD and PrintService/Operational are deliberately absent.
     */
    log:
      | "System"
      | "Application"
      | "Setup"
      | "HardwareEvents"
      | "Microsoft-Windows-Kernel-PnP/Configuration"
      | "Microsoft-Windows-Kernel-PnP/Driver Watchdog"
      | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
      | "Microsoft-Windows-UserPnp/DeviceInstall"
      | "Microsoft-Windows-DeviceSetupManager/Admin"
      | "Microsoft-Windows-DeviceSetupManager/Operational"
      | "Microsoft-Windows-Biometrics/Operational"
      | "Microsoft-Windows-CodeIntegrity/Operational"
      | "Microsoft-Windows-Kernel-WHEA/Errors"
      | "Microsoft-Windows-Kernel-WHEA/Operational"
      | "Microsoft-Windows-Kernel-Power/Thermal-Operational"
      | "Microsoft-Windows-Kernel-Boot/Operational"
      | "Microsoft-Windows-Kernel-IO/Operational"
      | "Microsoft-Windows-Diagnostics-Performance/Operational"
      | "Microsoft-Windows-Resource-Exhaustion-Detector/Operational"
      | "Microsoft-Windows-Storage-Storport/Operational"
      | "Microsoft-Windows-Storage-Storport/Health"
      | "Microsoft-Windows-Storage-ClassPnP/Operational"
      | "Microsoft-Windows-StorageSpaces-Driver/Operational"
      | "Microsoft-Windows-Ntfs/Operational"
      | "Microsoft-Windows-Partition/Diagnostic"
      | "Microsoft-Windows-NetworkProfile/Operational"
      | "Microsoft-Windows-NCSI/Operational"
      | "Microsoft-Windows-TCPIP/Operational"
      | "Microsoft-Windows-Dhcp-Client/Admin"
      | "Microsoft-Windows-Dhcp-Client/Operational"
      | "Microsoft-Windows-DNS-Client/Operational"
      | "Microsoft-Windows-WLAN-AutoConfig/Operational"
      | "Microsoft-Windows-SMBClient/Connectivity"
      | "Microsoft-Windows-SMBClient/Operational"
      | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
      | "Microsoft-Windows-Time-Service/Operational"
      | "Microsoft-Windows-WindowsUpdateClient/Operational"
      | "Microsoft-Windows-Bits-Client/Operational"
      | "Microsoft-Windows-TaskScheduler/Operational"
      | "Microsoft-Windows-PrintService/Admin"
      | "Microsoft-Windows-Windows Defender/Operational"
      | "Microsoft-Windows-GroupPolicy/Operational";
    /**
     * A single line of text with no control characters.
     */
    source: string;
    eventId: number;
    level: "critical" | "error" | "warning" | "information" | "verbose";
    recordId: number;
    /**
     * Plug and Play hardware ID such as USB\VID_1234&PID_5678.
     */
    hardwareId?: string;
    deviceInstanceId?: string;
  };
  commandId?: string;
  severityHint: "major" | "minor";
  detail: {
    /**
     * Multi-line text such as an event message, size-capped.
     */
    message?: string;
    fields?: {
      [k: string]: string | undefined;
    };
  };
  device?: {
    /**
     * @minItems 1
     * @maxItems 16
     */
    hardwareIds: [string, ...string[]];
    deviceInstanceId?: string;
    /**
     * A single line of text with no control characters.
     */
    name?: string;
    state: "disconnected" | "device_error" | "driver_missing" | "recovered";
    problemCode?: number;
  };
}

/**
 * The server's answer to a heartbeat: its time, the settings the agent's background monitors use, and, when this cabinet is in the current batch of a running rollout, the agent version it may upgrade to. Data only; the server can never send a command this way, and an offered upgrade is installed only if it passes every check against keys the server never holds.
 */
export interface HeartbeatResponse {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  serverTime: string;
  scanner: {
    /**
     * The scanner's hardware IDs from the console: the cabinet's own, else its site's, else its client's, else the fleet default. Whole IDs or vendor prefixes (USB\\VID_1234). null when none is set anywhere: the agent then finds the scanner itself by its Biometric device class.
     */
    hardwareIds: [string, ...string[]] | null;
  };
  /**
   * An agent release this cabinet is offered. The agent downloads it and the broker verifies it (docs/spec/07-upgrade-channel.md); the agent ignores an offer that is not newer than itself.
   */
  upgrade?: {
    /**
     * Semantic version of the agent.
     */
    version: string;
  };
  /**
   * The services this cabinet must keep running: the cabinet's own list, else its site's, else its client's, else the fleet's (docs/spec/12-milestones-8-to-12.md). Empty when none is set.
   */
  watchedServices?: {
    names: WatchedServiceNames;
  };
}

/**
 * Sent every 60 seconds.
 */
export interface Heartbeat {
  /**
   * Semantic version of the agent.
   */
  agentVersion: string;
  uptimeSeconds: number;
  readOnlyMode: boolean;
  /**
   * Agent clock minus the last server time seen; provisional field.
   */
  clockSkewSeconds?: number;
  firewallProfiles?: FirewallProfileSwitches;
  /**
   * The cabinet's Windows time zone, compared with its site's time zone. Absent from agents before the time operations.
   */
  timeZoneId?: string;
}

/**
 * POST /agent/v1/renew: a new CSR, authenticated by the current certificate.
 */
export interface RenewRequest {
  csr: string;
}

/**
 * The renewed certificate.
 */
export interface RenewResponse {
  certificate: string;
  caChain: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  serverTime: string;
}

/**
 * Result envelope: the answer to one command. output is present only when succeeded; error only when failed or rejected. The server validates output against the operation's output schema using its own command record.
 */
export interface Result {
  commandId: string;
  status: "succeeded" | "failed" | "rejected";
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  startedAt: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  finishedAt: string;
  output?: {};
  error?: {
    code:
      | (
          | "unknown_operation"
          | "invalid_params"
          | "expired"
          | "replayed"
          | "wrong_cabinet"
          | "read_only_mode"
          | "rate_limited"
          | "hash_mismatch"
          | "signature_invalid"
          | "publisher_not_trusted"
          | "verification_failed"
        )
      | ("execution_failed" | "timeout" | "not_found" | "unavailable" | "safety_net_rollback");
    message: string;
  };
}

/**
 * Response to heartbeat, results and events. Every response carries the server's own time so the agent can detect drift.
 */
export interface ServerAck {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  serverTime: string;
}

/**
 * GET /agent/v1/updates/{version}: the release's manifest exactly as signed (base64, so not one byte changes in transit) and its detached signature. The package zip itself is GET /agent/v1/updates/{version}/package. The server answers only a cabinet the current batch of a running rollout has offered this version to. The agent trusts none of it until the broker has checked the signature against its own compiled-in key.
 */
export interface UpdateResponse {
  /**
   * Semantic version of the agent.
   */
  version: string;
  /**
   * Base64 of the manifest's exact bytes (at most 4 KB).
   */
  manifest: string;
  signature: UpgradeSignature;
}

/**
 * POST /agent/v1/upgrade-status: how an offered upgrade ended on this cabinet (docs/spec/07-upgrade-channel.md step 7). succeeded: the new version is running and has checked in. refused: a check failed and nothing was installed; check names exactly which. rolled_back: it was installed but did not check in within 5 minutes (or could not be put in place), so the updater restored the old version. failed: it could not be attempted (the download failed, the broker was unreachable).
 */
export interface UpgradeStatus {
  /**
   * The version that was offered.
   */
  version: string;
  /**
   * The version that was running when the upgrade started.
   */
  fromVersion: string;
  outcome: "succeeded" | "refused" | "rolled_back" | "failed";
  /**
   * Which step of an agent upgrade failed (docs/spec/07-upgrade-channel.md), in the order they run: download; manifest_signature (against the compiled-in key); manifest (does not match its contract or is not for this product); package_hash; version (not newer than the running one, or the running one is older than the release's minimum); authenticode (a binary is not signed by the agent's publisher); install (the files could not be put in place); check_in (the new version did not reach the server within 5 minutes).
   */
  check?:
    | "download"
    | "manifest_signature"
    | "manifest"
    | "package_hash"
    | "version"
    | "authenticode"
    | "install"
    | "check_in";
  message: string;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface SystemInfoParams {}

export interface SystemInfoOutput {
  /**
   * Windows computer name or DNS host name.
   */
  hostname: string;
  /**
   * A single line of text with no control characters.
   */
  osVersion: string;
  /**
   * A single line of text with no control characters.
   */
  osBuild: string;
  uptimeSeconds: number;
  /**
   * Semantic version of the agent.
   */
  agentVersion: string;
  readOnlyMode: boolean;
  cabinetRole: ("sync" | "satellite" | "standalone") | null;
  serialNumber: string | null;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface EventlogChannelsParams {}

export interface EventlogChannelsOutput {
  /**
   * @maxItems 64
   */
  channels: {
    /**
     * The event logs the agent may read, compiled in (docs/spec/04-agent-spec.md, widened in milestone 1 to every channel useful for diagnosis; see docs/spec/09-open-decisions.md). Logs that record sign-ins, credentials, remote sessions, script or command text, or printed document names are never readable: Security, PowerShell, Sysmon, Winlogon, User Profile, TerminalServices, NTLM, Kerberos, CAPI2, AAD and PrintService/Operational are deliberately absent.
     */
    log:
      | "System"
      | "Application"
      | "Setup"
      | "HardwareEvents"
      | "Microsoft-Windows-Kernel-PnP/Configuration"
      | "Microsoft-Windows-Kernel-PnP/Driver Watchdog"
      | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
      | "Microsoft-Windows-UserPnp/DeviceInstall"
      | "Microsoft-Windows-DeviceSetupManager/Admin"
      | "Microsoft-Windows-DeviceSetupManager/Operational"
      | "Microsoft-Windows-Biometrics/Operational"
      | "Microsoft-Windows-CodeIntegrity/Operational"
      | "Microsoft-Windows-Kernel-WHEA/Errors"
      | "Microsoft-Windows-Kernel-WHEA/Operational"
      | "Microsoft-Windows-Kernel-Power/Thermal-Operational"
      | "Microsoft-Windows-Kernel-Boot/Operational"
      | "Microsoft-Windows-Kernel-IO/Operational"
      | "Microsoft-Windows-Diagnostics-Performance/Operational"
      | "Microsoft-Windows-Resource-Exhaustion-Detector/Operational"
      | "Microsoft-Windows-Storage-Storport/Operational"
      | "Microsoft-Windows-Storage-Storport/Health"
      | "Microsoft-Windows-Storage-ClassPnP/Operational"
      | "Microsoft-Windows-StorageSpaces-Driver/Operational"
      | "Microsoft-Windows-Ntfs/Operational"
      | "Microsoft-Windows-Partition/Diagnostic"
      | "Microsoft-Windows-NetworkProfile/Operational"
      | "Microsoft-Windows-NCSI/Operational"
      | "Microsoft-Windows-TCPIP/Operational"
      | "Microsoft-Windows-Dhcp-Client/Admin"
      | "Microsoft-Windows-Dhcp-Client/Operational"
      | "Microsoft-Windows-DNS-Client/Operational"
      | "Microsoft-Windows-WLAN-AutoConfig/Operational"
      | "Microsoft-Windows-SMBClient/Connectivity"
      | "Microsoft-Windows-SMBClient/Operational"
      | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
      | "Microsoft-Windows-Time-Service/Operational"
      | "Microsoft-Windows-WindowsUpdateClient/Operational"
      | "Microsoft-Windows-Bits-Client/Operational"
      | "Microsoft-Windows-TaskScheduler/Operational"
      | "Microsoft-Windows-PrintService/Admin"
      | "Microsoft-Windows-Windows Defender/Operational"
      | "Microsoft-Windows-GroupPolicy/Operational";
    enabled: boolean;
    entryCount: number | null;
    sizeBytes: number | null;
    newestEntryAt: string | null;
    /**
     * False when this channel does not exist on this Windows build.
     */
    available: boolean;
  }[];
}

export interface EventlogQueryParams {
  /**
   * The event logs the agent may read, compiled in (docs/spec/04-agent-spec.md, widened in milestone 1 to every channel useful for diagnosis; see docs/spec/09-open-decisions.md). Logs that record sign-ins, credentials, remote sessions, script or command text, or printed document names are never readable: Security, PowerShell, Sysmon, Winlogon, User Profile, TerminalServices, NTLM, Kerberos, CAPI2, AAD and PrintService/Operational are deliberately absent.
   */
  log:
    | "System"
    | "Application"
    | "Setup"
    | "HardwareEvents"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-Kernel-PnP/Driver Watchdog"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-UserPnp/DeviceInstall"
    | "Microsoft-Windows-DeviceSetupManager/Admin"
    | "Microsoft-Windows-DeviceSetupManager/Operational"
    | "Microsoft-Windows-Biometrics/Operational"
    | "Microsoft-Windows-CodeIntegrity/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Kernel-WHEA/Operational"
    | "Microsoft-Windows-Kernel-Power/Thermal-Operational"
    | "Microsoft-Windows-Kernel-Boot/Operational"
    | "Microsoft-Windows-Kernel-IO/Operational"
    | "Microsoft-Windows-Diagnostics-Performance/Operational"
    | "Microsoft-Windows-Resource-Exhaustion-Detector/Operational"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Storage-Storport/Health"
    | "Microsoft-Windows-Storage-ClassPnP/Operational"
    | "Microsoft-Windows-StorageSpaces-Driver/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-Partition/Diagnostic"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-NCSI/Operational"
    | "Microsoft-Windows-TCPIP/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-Dhcp-Client/Operational"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-WLAN-AutoConfig/Operational"
    | "Microsoft-Windows-SMBClient/Connectivity"
    | "Microsoft-Windows-SMBClient/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-Time-Service/Operational"
    | "Microsoft-Windows-WindowsUpdateClient/Operational"
    | "Microsoft-Windows-Bits-Client/Operational"
    | "Microsoft-Windows-TaskScheduler/Operational"
    | "Microsoft-Windows-PrintService/Admin"
    | "Microsoft-Windows-Windows Defender/Operational"
    | "Microsoft-Windows-GroupPolicy/Operational";
  /**
   * @minItems 1
   * @maxItems 5
   */
  levels?: [
    "critical" | "error" | "warning" | "information" | "verbose",
    ...("critical" | "error" | "warning" | "information" | "verbose")[]
  ];
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  from?: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  to?: string;
  source?: string;
  /**
   * @minItems 1
   * @maxItems 20
   */
  eventIds?: [number, ...number[]];
  /**
   * Paging cursor: return entries older than this record.
   */
  beforeRecordId?: number;
  pageSize?: number;
}

export interface EventlogQueryOutput {
  /**
   * The event logs the agent may read, compiled in (docs/spec/04-agent-spec.md, widened in milestone 1 to every channel useful for diagnosis; see docs/spec/09-open-decisions.md). Logs that record sign-ins, credentials, remote sessions, script or command text, or printed document names are never readable: Security, PowerShell, Sysmon, Winlogon, User Profile, TerminalServices, NTLM, Kerberos, CAPI2, AAD and PrintService/Operational are deliberately absent.
   */
  log:
    | "System"
    | "Application"
    | "Setup"
    | "HardwareEvents"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-Kernel-PnP/Driver Watchdog"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-UserPnp/DeviceInstall"
    | "Microsoft-Windows-DeviceSetupManager/Admin"
    | "Microsoft-Windows-DeviceSetupManager/Operational"
    | "Microsoft-Windows-Biometrics/Operational"
    | "Microsoft-Windows-CodeIntegrity/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Kernel-WHEA/Operational"
    | "Microsoft-Windows-Kernel-Power/Thermal-Operational"
    | "Microsoft-Windows-Kernel-Boot/Operational"
    | "Microsoft-Windows-Kernel-IO/Operational"
    | "Microsoft-Windows-Diagnostics-Performance/Operational"
    | "Microsoft-Windows-Resource-Exhaustion-Detector/Operational"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Storage-Storport/Health"
    | "Microsoft-Windows-Storage-ClassPnP/Operational"
    | "Microsoft-Windows-StorageSpaces-Driver/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-Partition/Diagnostic"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-NCSI/Operational"
    | "Microsoft-Windows-TCPIP/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-Dhcp-Client/Operational"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-WLAN-AutoConfig/Operational"
    | "Microsoft-Windows-SMBClient/Connectivity"
    | "Microsoft-Windows-SMBClient/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-Time-Service/Operational"
    | "Microsoft-Windows-WindowsUpdateClient/Operational"
    | "Microsoft-Windows-Bits-Client/Operational"
    | "Microsoft-Windows-TaskScheduler/Operational"
    | "Microsoft-Windows-PrintService/Admin"
    | "Microsoft-Windows-Windows Defender/Operational"
    | "Microsoft-Windows-GroupPolicy/Operational";
  /**
   * @maxItems 500
   */
  entries: {
    recordId: number;
    /**
     * UTC time, ISO 8601, always ending in Z.
     */
    time: string;
    level: "critical" | "error" | "warning" | "information" | "verbose";
    /**
     * A single line of text with no control characters.
     */
    source: string;
    eventId: number;
    firstLine: string;
  }[];
  nextBeforeRecordId: number | null;
  truncated: boolean;
}

export interface EventlogGetParams {
  /**
   * The event logs the agent may read, compiled in (docs/spec/04-agent-spec.md, widened in milestone 1 to every channel useful for diagnosis; see docs/spec/09-open-decisions.md). Logs that record sign-ins, credentials, remote sessions, script or command text, or printed document names are never readable: Security, PowerShell, Sysmon, Winlogon, User Profile, TerminalServices, NTLM, Kerberos, CAPI2, AAD and PrintService/Operational are deliberately absent.
   */
  log:
    | "System"
    | "Application"
    | "Setup"
    | "HardwareEvents"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-Kernel-PnP/Driver Watchdog"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-UserPnp/DeviceInstall"
    | "Microsoft-Windows-DeviceSetupManager/Admin"
    | "Microsoft-Windows-DeviceSetupManager/Operational"
    | "Microsoft-Windows-Biometrics/Operational"
    | "Microsoft-Windows-CodeIntegrity/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Kernel-WHEA/Operational"
    | "Microsoft-Windows-Kernel-Power/Thermal-Operational"
    | "Microsoft-Windows-Kernel-Boot/Operational"
    | "Microsoft-Windows-Kernel-IO/Operational"
    | "Microsoft-Windows-Diagnostics-Performance/Operational"
    | "Microsoft-Windows-Resource-Exhaustion-Detector/Operational"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Storage-Storport/Health"
    | "Microsoft-Windows-Storage-ClassPnP/Operational"
    | "Microsoft-Windows-StorageSpaces-Driver/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-Partition/Diagnostic"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-NCSI/Operational"
    | "Microsoft-Windows-TCPIP/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-Dhcp-Client/Operational"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-WLAN-AutoConfig/Operational"
    | "Microsoft-Windows-SMBClient/Connectivity"
    | "Microsoft-Windows-SMBClient/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-Time-Service/Operational"
    | "Microsoft-Windows-WindowsUpdateClient/Operational"
    | "Microsoft-Windows-Bits-Client/Operational"
    | "Microsoft-Windows-TaskScheduler/Operational"
    | "Microsoft-Windows-PrintService/Admin"
    | "Microsoft-Windows-Windows Defender/Operational"
    | "Microsoft-Windows-GroupPolicy/Operational";
  recordId: number;
}

export interface EventlogGetOutput {
  /**
   * The event logs the agent may read, compiled in (docs/spec/04-agent-spec.md, widened in milestone 1 to every channel useful for diagnosis; see docs/spec/09-open-decisions.md). Logs that record sign-ins, credentials, remote sessions, script or command text, or printed document names are never readable: Security, PowerShell, Sysmon, Winlogon, User Profile, TerminalServices, NTLM, Kerberos, CAPI2, AAD and PrintService/Operational are deliberately absent.
   */
  log:
    | "System"
    | "Application"
    | "Setup"
    | "HardwareEvents"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-Kernel-PnP/Driver Watchdog"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-UserPnp/DeviceInstall"
    | "Microsoft-Windows-DeviceSetupManager/Admin"
    | "Microsoft-Windows-DeviceSetupManager/Operational"
    | "Microsoft-Windows-Biometrics/Operational"
    | "Microsoft-Windows-CodeIntegrity/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Kernel-WHEA/Operational"
    | "Microsoft-Windows-Kernel-Power/Thermal-Operational"
    | "Microsoft-Windows-Kernel-Boot/Operational"
    | "Microsoft-Windows-Kernel-IO/Operational"
    | "Microsoft-Windows-Diagnostics-Performance/Operational"
    | "Microsoft-Windows-Resource-Exhaustion-Detector/Operational"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Storage-Storport/Health"
    | "Microsoft-Windows-Storage-ClassPnP/Operational"
    | "Microsoft-Windows-StorageSpaces-Driver/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-Partition/Diagnostic"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-NCSI/Operational"
    | "Microsoft-Windows-TCPIP/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-Dhcp-Client/Operational"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-WLAN-AutoConfig/Operational"
    | "Microsoft-Windows-SMBClient/Connectivity"
    | "Microsoft-Windows-SMBClient/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-Time-Service/Operational"
    | "Microsoft-Windows-WindowsUpdateClient/Operational"
    | "Microsoft-Windows-Bits-Client/Operational"
    | "Microsoft-Windows-TaskScheduler/Operational"
    | "Microsoft-Windows-PrintService/Admin"
    | "Microsoft-Windows-Windows Defender/Operational"
    | "Microsoft-Windows-GroupPolicy/Operational";
  recordId: number;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  time: string;
  level: "critical" | "error" | "warning" | "information" | "verbose";
  /**
   * A single line of text with no control characters.
   */
  source: string;
  eventId: number;
  taskCategory: string | null;
  /**
   * @maxItems 32
   */
  keywords: string[];
  opcode: string | null;
  processId: number | null;
  threadId: number | null;
  computer: string | null;
  /**
   * Multi-line text such as an event message, size-capped.
   */
  message: string;
  /**
   * @maxItems 128
   */
  eventData: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    value: string;
  }[];
  deviceInstanceId: string | null;
  /**
   * The event's XML, capped at 64 KB. Same character rules as longText, with a larger limit.
   */
  rawXml: string;
}

export interface DevicesListParams {
  problemsOnly?: boolean;
}

export interface DevicesListOutput {
  /**
   * @maxItems 5000
   */
  devices: {
    instanceId: string;
    class: string | null;
    /**
     * A single line of text with no control characters.
     */
    name: string;
    /**
     * A single line of text with no control characters.
     */
    status: string;
    errorCode: number | null;
    errorText: string | null;
    /**
     * @maxItems 32
     */
    hardwareIds: string[];
    driver: {
      /**
       * A single line of text with no control characters.
       */
      name: string;
      version: string | null;
      provider: string | null;
    } | null;
  }[];
  truncated: boolean;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface DriversListParams {}

export interface DriversListOutput {
  /**
   * @maxItems 5000
   */
  drivers: {
    /**
     * A single line of text with no control characters.
     */
    publishedName: string;
    originalName: string | null;
    version: string | null;
    date: string | null;
    provider: string | null;
    className: string | null;
    signer: string | null;
  }[];
  truncated: boolean;
}

/**
 * The scanner's hardware IDs as set in the console (fleet default or per cabinet). When absent, the agent uses its local configuration.
 */
export interface PeripheralStatusParams {
  /**
   * @minItems 1
   * @maxItems 16
   */
  hardwareIds?: [string, ...string[]];
}

/**
 * The fingerprint scanner, found by the hardware IDs in the agent's local configuration, with an automated troubleshooting checklist. When no IDs are configured, candidates lists likely scanners so support can identify the right one.
 */
export interface PeripheralStatusOutput {
  configured: boolean;
  connected: boolean;
  name: string | null;
  status: string | null;
  errorCode: number | null;
  errorText: string | null;
  /**
   * @maxItems 32
   */
  hardwareIds: string[];
  driver: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    version: string | null;
    date: string | null;
    signer: string | null;
  } | null;
  /**
   * Where Windows sees it plugged in, e.g. Port_#0002.Hub_#0003. Changes when it moves to another USB port.
   */
  locationInfo: string | null;
  /**
   * @maxItems 16
   */
  checks: {
    check:
      | "device_present"
      | "no_device_error"
      | "driver_installed"
      | "driver_signed"
      | "usb_power_saving"
      | "recent_reconnects"
      | "usb_controller_errors"
      | "biometric_service";
    outcome: "pass" | "warn" | "fail" | "unknown";
    /**
     * A single line of text with no control characters.
     */
    summary: string;
  }[];
  /**
   * Likely fingerprint scanners: biometric-class devices and USB devices named as fingerprint or biometric readers.
   *
   * @maxItems 32
   */
  candidates: {
    instanceId: string;
    /**
     * A single line of text with no control characters.
     */
    name: string;
    class: string | null;
    connected: boolean;
    status: string | null;
    /**
     * @maxItems 32
     */
    hardwareIds: string[];
  }[];
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface UpdatesStatusParams {}

export interface UpdatesStatusOutput {
  lastCheckAt: string | null;
  lastInstallAt: string | null;
  lastInstallResult: ("succeeded" | "succeeded_with_errors" | "failed" | "aborted" | "in_progress" | "unknown") | null;
  /**
   * @maxItems 500
   */
  installed: {
    /**
     * A single line of text with no control characters.
     */
    title: string;
    kb: string | null;
    installedAt: string | null;
    result: "succeeded" | "succeeded_with_errors" | "failed" | "aborted" | "in_progress" | "unknown";
    errorCode: number | null;
  }[];
  /**
   * @maxItems 500
   */
  pending: {
    /**
     * A single line of text with no control characters.
     */
    title: string;
    kb: string | null;
    classification: string | null;
    isSecurity: boolean;
  }[];
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface DiskSmartParams {}

export interface DiskSmartOutput {
  /**
   * @maxItems 32
   */
  drives: {
    model: string | null;
    serialNumber: string | null;
    health: "healthy" | "warning" | "failing" | "unknown";
    predictFailure: boolean | null;
    temperatureCelsius: number | null;
    powerOnHours: number | null;
    reallocatedSectors: number | null;
    pendingSectors: number | null;
    uncorrectableErrors: number | null;
    wearPercent: number | null;
  }[];
}

export interface FilesListParams {
  /**
   * Absolute path on C:. No relative segments, alternate streams, UNC or device paths.
   */
  path: string;
  page?: number;
  pageSize?: number;
}

export interface FilesListOutput {
  /**
   * A single line of text with no control characters.
   */
  path: string;
  page: number;
  /**
   * @maxItems 500
   */
  entries: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    type: "file" | "directory";
    sizeBytes: number | null;
    modifiedAt: string | null;
  }[];
  hasMore: boolean;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface NetworkConfigParams {}

export interface NetworkConfigOutput {
  /**
   * @maxItems 64
   */
  adapters: {
    /**
     * Windows network interface index.
     */
    interfaceIndex: number;
    /**
     * A single line of text with no control characters.
     */
    name: string;
    description: string | null;
    type: "ethernet" | "wifi" | "other";
    connected: boolean;
    linkSpeedBps: number | null;
    macAddress: string | null;
    ipv4: Ipv4Settings;
    /**
     * @maxItems 16
     */
    ipv6Addresses: string[];
    dns: DnsSettings;
    dnsSuffix: string | null;
  }[];
}

export interface NetworkTestParams {
  target: "gateway" | "dns_server" | "sync_cabinet" | "platform_server";
  method: "ping" | "dns" | "tcp";
  /**
   * Which configured DNS server (0-3) when target is dns_server.
   */
  dnsServerIndex?: number;
  /**
   * TCP only; must also be in the agent's local allowed-port list.
   */
  port?: number;
  /**
   * The site's sync cabinet as set in the console. The agent accepts it only if it is a private IPv4 address on one of the cabinet's own connected networks.
   */
  syncAddress?: string;
  /**
   * TCP ports the site's settings allow for the sync cabinet, at most 4. Used only with target sync_cabinet.
   *
   * @minItems 1
   * @maxItems 4
   */
  syncPorts?: [number, ...number[]];
}

export interface NetworkTestOutput {
  target: "gateway" | "dns_server" | "sync_cabinet" | "platform_server";
  method: "ping" | "dns" | "tcp";
  resolvedTarget: string | null;
  success: boolean;
  latencyMs: number | null;
  /**
   * @maxItems 16
   */
  resolvedAddresses: string[];
  error: string | null;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface FirewallStateParams {}

export interface FirewallStateOutput {
  /**
   * @minItems 3
   * @maxItems 3
   */
  profiles: [FirewallProfileState, FirewallProfileState, FirewallProfileState, ...FirewallProfileState[]];
  /**
   * @maxItems 10000
   */
  rules: ReportedFirewallRule[];
  rulesTruncated: boolean;
  /**
   * @maxItems 20
   */
  snapshots: {
    snapshotId: string;
    /**
     * UTC time, ISO 8601, always ending in Z.
     */
    takenAt: string;
    commandId: string | null;
  }[];
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface ServicesListParams {}

export interface ServicesListOutput {
  /**
   * @maxItems 1000
   */
  services: {
    /**
     * A Windows service's key name (not its display name). Letters, digits, _ . $ - and inner spaces; SQL Server's MSSQL$NAME form included.
     */
    name: string;
    /**
     * A single line of text with no control characters.
     */
    displayName: string;
    state:
      | "running"
      | "stopped"
      | "start_pending"
      | "stop_pending"
      | "paused"
      | "pause_pending"
      | "continue_pending"
      | "unknown";
    startType: "automatic" | "automatic_delayed" | "manual" | "disabled" | "boot" | "system" | "unknown";
    account: string | null;
    processId: number | null;
    executablePath: string | null;
    description: string | null;
    recovery: {
      firstFailure: "none" | "restart" | "reboot" | "run_program";
      secondFailure: "none" | "restart" | "reboot" | "run_program";
      subsequentFailures: "none" | "restart" | "reboot" | "run_program";
      resetPeriodSeconds: number;
    } | null;
  }[];
  /**
   * @maxItems 16
   */
  watched: WatchedServiceStatus[];
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface ProcessesListParams {}

export interface ProcessesListOutput {
  /**
   * @maxItems 2000
   */
  processes: {
    processId: number;
    /**
     * A single line of text with no control characters.
     */
    name: string;
    executablePath: string | null;
    /**
     * Share of the whole machine (all cores) over the sample.
     */
    cpuPercent: number;
    workingSetBytes: number;
    privateBytes: number;
    threads: number;
    handles: number;
    startTime: string | null;
    sessionId: number;
    account: string | null;
  }[];
  sampleMilliseconds: number;
  truncated: boolean;
}

export interface NetworkSetIpParams {
  /**
   * Windows network interface index.
   */
  interfaceIndex: number;
  mode: "dhcp" | "static";
  address?: string;
  prefixLength?: number;
  gateway?: string;
}

export interface NetworkSetIpOutput {
  /**
   * Windows network interface index.
   */
  interfaceIndex: number;
  before: Ipv4Settings;
  after: Ipv4Settings;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  safetyNetDeadline: string;
}

export interface NetworkSetDnsParams {
  /**
   * Windows network interface index.
   */
  interfaceIndex: number;
  mode: "automatic" | "static";
  /**
   * @minItems 1
   * @maxItems 4
   */
  servers?: [string, ...string[]];
}

export interface NetworkSetDnsOutput {
  /**
   * Windows network interface index.
   */
  interfaceIndex: number;
  before: DnsSettings;
  after: DnsSettings;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  safetyNetDeadline: string;
}

export interface FirewallSetProfileParams {
  profile: "domain" | "private" | "public";
  enabled: boolean;
  defaultInbound: "allow" | "block";
  defaultOutbound: "allow" | "block";
  durationMinutes?: number;
  noTimeLimit?: true;
}

export interface FirewallSetProfileOutput {
  profile: "domain" | "private" | "public";
  before: FirewallProfileState;
  after: FirewallProfileState;
  snapshotId: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  safetyNetDeadline: string;
}

export interface FirewallApplyPolicyParams {
  profiles: FirewallProfileSwitches;
}

export interface FirewallApplyPolicyOutput {
  /**
   * @minItems 3
   * @maxItems 3
   */
  before: [FirewallProfileState, FirewallProfileState, FirewallProfileState, ...FirewallProfileState[]];
  /**
   * @minItems 3
   * @maxItems 3
   */
  after: [FirewallProfileState, FirewallProfileState, FirewallProfileState, ...FirewallProfileState[]];
  /**
   * The profiles whose on/off state changed; empty when the cabinet already matched.
   *
   * @maxItems 3
   */
  changed: ("domain" | "private" | "public")[];
  snapshotId: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  safetyNetDeadline: string;
}

export interface FirewallSetRuleParams {
  change: "create" | "update" | "enable" | "disable" | "delete";
  /**
   * The existing rule to change (all changes except create).
   */
  ruleName?: string;
  rule?: FirewallRule;
}

export interface FirewallSetRuleOutput {
  change: "create" | "update" | "enable" | "disable" | "delete";
  before: ReportedFirewallRule | null;
  after: ReportedFirewallRule | null;
  snapshotId: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  safetyNetDeadline: string;
}

export interface FirewallRestoreParams {
  snapshotId: string;
}

export interface FirewallRestoreOutput {
  restoredSnapshotId: string;
  preRestoreSnapshotId: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  restoredAt: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  safetyNetDeadline: string;
}

export interface PackageInstallParams {
  packageId: string;
  packageType: "driver" | "msi";
  /**
   * Lower-case hex SHA-256 digest.
   */
  sha256: string;
}

export interface PackageInstallOutput {
  packageId: string;
  packageType: "driver" | "msi";
  checks: {
    hash: "passed" | "failed" | "not_run";
    signature: "passed" | "failed" | "not_run";
    publisher: "passed" | "failed" | "not_run";
  };
  signer: string | null;
  installed: boolean;
  exitCode: number | null;
  rebootRequired: boolean;
}

export interface DriverUninstallParams {
  publishedName: string;
}

export interface DriverUninstallOutput {
  /**
   * A single line of text with no control characters.
   */
  publishedName: string;
  removed: boolean;
  rebootRequired: boolean;
}

export interface ServiceControlParams {
  /**
   * A Windows service's key name (not its display name). Letters, digits, _ . $ - and inner spaces; SQL Server's MSSQL$NAME form included.
   */
  name: string;
  action: "start" | "stop" | "restart";
}

export interface ServiceControlOutput {
  /**
   * A Windows service's key name (not its display name). Letters, digits, _ . $ - and inner spaces; SQL Server's MSSQL$NAME form included.
   */
  name: string;
  action: "start" | "stop" | "restart";
  before:
    | "running"
    | "stopped"
    | "start_pending"
    | "stop_pending"
    | "paused"
    | "pause_pending"
    | "continue_pending"
    | "unknown";
  after:
    | "running"
    | "stopped"
    | "start_pending"
    | "stop_pending"
    | "paused"
    | "pause_pending"
    | "continue_pending"
    | "unknown";
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface TimeStatusParams {}

export interface TimeStatusOutput {
  /**
   * A Windows time zone ID as a cabinet reports it; any zone can be reported, only timeZoneId zones can be set.
   */
  timeZoneId: string;
  /**
   * A single line of text with no control characters.
   */
  timeZoneName: string;
  utcOffsetMinutes: number;
  daylightSavingNow: boolean;
  /**
   * The cabinet's local wall-clock time, without a zone.
   */
  localTime: string;
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  utcTime: string;
  timeService: "running" | "stopped" | "not_installed" | "unknown";
  sync: {
    /**
     * synced: Windows Time has synchronized at least once; never_synced: it has not; unknown: the status could not be read.
     */
    state: "synced" | "never_synced" | "unknown";
    source: string | null;
    lastSuccessfulSync: string | null;
  };
  /**
   * Group Policy sets Windows Time's source; the platform never changes the source.
   */
  policyManaged: boolean;
}

export interface TimeSetZoneParams {
  /**
   * A Windows time zone the platform may set (docs/spec/13-roadmap.md module 21): the United States zones, with Arizona (US Mountain Standard Time, no daylight saving) separate from Mountain.
   */
  timeZoneId:
    | "Eastern Standard Time"
    | "Central Standard Time"
    | "Mountain Standard Time"
    | "US Mountain Standard Time"
    | "Pacific Standard Time"
    | "Alaskan Standard Time"
    | "Hawaiian Standard Time";
}

export interface TimeSetZoneOutput {
  /**
   * A Windows time zone ID as a cabinet reports it; any zone can be reported, only timeZoneId zones can be set.
   */
  before: string;
  /**
   * A Windows time zone ID as a cabinet reports it; any zone can be reported, only timeZoneId zones can be set.
   */
  after: string;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface TimeSyncParams {}

export interface TimeSyncOutput {
  /**
   * synced: Windows Time synchronized; failed: it tried and could not (no source answered); service_stopped: Windows Time is not running, so nothing was tried.
   */
  result: "synced" | "failed" | "service_stopped";
  /**
   * A single line of text with no control characters.
   */
  message: string;
  lastSuccessfulSyncBefore: string | null;
  lastSuccessfulSyncAfter: string | null;
}

export type OperationKind = "read" | "write";
export interface CatalogEntry {
  name: OperationName;
  kind: OperationKind;
  minimumRole: "tier1" | "tier2" | "admin";
  confirm: "none" | "click" | "code";
  expirySeconds: number;
  rateClass: "read" | "write" | "network_test";
  safetyNet?: boolean;
}
export type OperationName = "system.info" | "eventlog.channels" | "eventlog.query" | "eventlog.get" | "devices.list" | "drivers.list" | "peripheral.status" | "updates.status" | "disk.smart" | "files.list" | "network.config" | "network.test" | "firewall.state" | "services.list" | "processes.list" | "network.setIp" | "network.setDns" | "firewall.setProfile" | "firewall.applyPolicy" | "firewall.setRule" | "firewall.restore" | "package.install" | "driver.uninstall" | "service.control" | "time.status" | "time.setZone" | "time.sync";

/** A command whose params are typed for its operation. */
export type TypedCommand<O extends OperationName = OperationName> = O extends OperationName
  ? Omit<Command, "operation" | "params"> & { operation: O; params: OperationTypes[O]["params"] }
  : never;

/** Parameter and output types for each operation, keyed by operation name. */
export interface OperationTypes {
  "system.info": { params: SystemInfoParams; output: SystemInfoOutput };
  "eventlog.channels": { params: EventlogChannelsParams; output: EventlogChannelsOutput };
  "eventlog.query": { params: EventlogQueryParams; output: EventlogQueryOutput };
  "eventlog.get": { params: EventlogGetParams; output: EventlogGetOutput };
  "devices.list": { params: DevicesListParams; output: DevicesListOutput };
  "drivers.list": { params: DriversListParams; output: DriversListOutput };
  "peripheral.status": { params: PeripheralStatusParams; output: PeripheralStatusOutput };
  "updates.status": { params: UpdatesStatusParams; output: UpdatesStatusOutput };
  "disk.smart": { params: DiskSmartParams; output: DiskSmartOutput };
  "files.list": { params: FilesListParams; output: FilesListOutput };
  "network.config": { params: NetworkConfigParams; output: NetworkConfigOutput };
  "network.test": { params: NetworkTestParams; output: NetworkTestOutput };
  "firewall.state": { params: FirewallStateParams; output: FirewallStateOutput };
  "services.list": { params: ServicesListParams; output: ServicesListOutput };
  "processes.list": { params: ProcessesListParams; output: ProcessesListOutput };
  "network.setIp": { params: NetworkSetIpParams; output: NetworkSetIpOutput };
  "network.setDns": { params: NetworkSetDnsParams; output: NetworkSetDnsOutput };
  "firewall.setProfile": { params: FirewallSetProfileParams; output: FirewallSetProfileOutput };
  "firewall.applyPolicy": { params: FirewallApplyPolicyParams; output: FirewallApplyPolicyOutput };
  "firewall.setRule": { params: FirewallSetRuleParams; output: FirewallSetRuleOutput };
  "firewall.restore": { params: FirewallRestoreParams; output: FirewallRestoreOutput };
  "package.install": { params: PackageInstallParams; output: PackageInstallOutput };
  "driver.uninstall": { params: DriverUninstallParams; output: DriverUninstallOutput };
  "service.control": { params: ServiceControlParams; output: ServiceControlOutput };
  "time.status": { params: TimeStatusParams; output: TimeStatusOutput };
  "time.setZone": { params: TimeSetZoneParams; output: TimeSetZoneOutput };
  "time.sync": { params: TimeSyncParams; output: TimeSyncOutput };
}
