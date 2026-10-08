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
    | "firewall.setRule"
    | "firewall.restore"
    | "package.install"
    | "driver.uninstall";
  params: {};
  /**
   * A one-time step-up token bound to this operation on this cabinet. Required for writes, refused for reads.
   */
  stepUpToken?: string;
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
  requireTotpForAll?: boolean;
  retention?: {
    eventsDays?: number;
    commandsDays?: number;
    alertsDays?: number;
    firewallDays?: number;
  };
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
 * The fingerprint scanner's hardware IDs: the fleet default, or one cabinet's override (null removes the override).
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
 * An action that needs nothing but its step-up token.
 */
export interface StepUpOnly {
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Asks for a step-up token for one action on one target, with a fresh authenticator code (docs/spec/02-security-model.md control 8).
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
    | "firewall.setProfile"
    | "firewall.setRule"
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
    | "rule.renew";
  /**
   * The ID the action applies to, or 'fleet'.
   */
  target: string | "fleet";
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
 * A site's sync cabinet: a private IPv4 address and at most 4 TCP ports. Each cabinet also refuses an address that is not on its own network.
 */
export interface SyncSettings {
  address: string | null;
  /**
   * @maxItems 4
   */
  ports: number[];
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
    | "firewall.setRule"
    | "firewall.restore"
    | "package.install"
    | "driver.uninstall";
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
 * Agent-originated event: detected errors and changes (docs/spec/03-protocol.md). kind scanner comes from the fingerprint scanner watcher and carries the device and its state instead of a log record.
 */
export interface Event {
  eventId: string;
  kind: "error" | "firewall_changed" | "smart_warning" | "agent_status" | "security" | "scanner";
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
 * The server's answer to a heartbeat: its time, and the settings the agent's background monitors use. Data only; the server can never send a command this way.
 */
export interface HeartbeatResponse {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  serverTime: string;
  scanner: {
    /**
     * The scanner's hardware IDs set in the console for this cabinet (its own, else the fleet default); null when none.
     */
    hardwareIds: [string, ...string[]] | null;
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

export type OperationKind = "read" | "write";
export interface CatalogEntry {
  name: OperationName;
  kind: OperationKind;
  minimumRole: "tier1" | "tier2" | "admin";
  stepUp: boolean;
  expirySeconds: number;
  rateClass: "read" | "write" | "network_test";
  safetyNet?: boolean;
}
export type OperationName = "system.info" | "eventlog.channels" | "eventlog.query" | "eventlog.get" | "devices.list" | "drivers.list" | "peripheral.status" | "updates.status" | "disk.smart" | "files.list" | "network.config" | "network.test" | "firewall.state" | "network.setIp" | "network.setDns" | "firewall.setProfile" | "firewall.setRule" | "firewall.restore" | "package.install" | "driver.uninstall";

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
  "network.setIp": { params: NetworkSetIpParams; output: NetworkSetIpOutput };
  "network.setDns": { params: NetworkSetDnsParams; output: NetworkSetDnsOutput };
  "firewall.setProfile": { params: FirewallSetProfileParams; output: FirewallSetProfileOutput };
  "firewall.setRule": { params: FirewallSetRuleParams; output: FirewallSetRuleOutput };
  "firewall.restore": { params: FirewallRestoreParams; output: FirewallRestoreOutput };
  "package.install": { params: PackageInstallParams; output: PackageInstallOutput };
  "driver.uninstall": { params: DriverUninstallParams; output: DriverUninstallOutput };
}
