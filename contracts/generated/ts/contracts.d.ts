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
 * Agent-originated event: detected errors and changes (docs/spec/03-protocol.md).
 */
export interface Event {
  eventId: string;
  kind: "error" | "firewall_changed" | "smart_warning" | "agent_status" | "security";
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  occurredAt: string;
  source?: {
    /**
     * The event logs the agent may read (docs/spec/04-agent-spec.md). The Security log is never readable and is deliberately absent.
     */
    log:
      | "System"
      | "Application"
      | "Setup"
      | "Microsoft-Windows-Kernel-PnP/Configuration"
      | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
      | "Microsoft-Windows-Kernel-WHEA/Errors"
      | "Microsoft-Windows-Storage-Storport/Operational"
      | "Microsoft-Windows-Ntfs/Operational"
      | "Microsoft-Windows-NetworkProfile/Operational"
      | "Microsoft-Windows-Dhcp-Client/Admin"
      | "Microsoft-Windows-DNS-Client/Operational"
      | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
      | "Microsoft-Windows-WindowsUpdateClient/Operational";
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
   * @maxItems 13
   */
  channels: {
    /**
     * The event logs the agent may read (docs/spec/04-agent-spec.md). The Security log is never readable and is deliberately absent.
     */
    log:
      | "System"
      | "Application"
      | "Setup"
      | "Microsoft-Windows-Kernel-PnP/Configuration"
      | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
      | "Microsoft-Windows-Kernel-WHEA/Errors"
      | "Microsoft-Windows-Storage-Storport/Operational"
      | "Microsoft-Windows-Ntfs/Operational"
      | "Microsoft-Windows-NetworkProfile/Operational"
      | "Microsoft-Windows-Dhcp-Client/Admin"
      | "Microsoft-Windows-DNS-Client/Operational"
      | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
      | "Microsoft-Windows-WindowsUpdateClient/Operational";
    enabled: boolean;
    entryCount: number | null;
    sizeBytes: number | null;
    newestEntryAt: string | null;
  }[];
}

export interface EventlogQueryParams {
  /**
   * The event logs the agent may read (docs/spec/04-agent-spec.md). The Security log is never readable and is deliberately absent.
   */
  log:
    | "System"
    | "Application"
    | "Setup"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-WindowsUpdateClient/Operational";
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
   * The event logs the agent may read (docs/spec/04-agent-spec.md). The Security log is never readable and is deliberately absent.
   */
  log:
    | "System"
    | "Application"
    | "Setup"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-WindowsUpdateClient/Operational";
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
   * The event logs the agent may read (docs/spec/04-agent-spec.md). The Security log is never readable and is deliberately absent.
   */
  log:
    | "System"
    | "Application"
    | "Setup"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-WindowsUpdateClient/Operational";
  recordId: number;
}

export interface EventlogGetOutput {
  /**
   * The event logs the agent may read (docs/spec/04-agent-spec.md). The Security log is never readable and is deliberately absent.
   */
  log:
    | "System"
    | "Application"
    | "Setup"
    | "Microsoft-Windows-Kernel-PnP/Configuration"
    | "Microsoft-Windows-DriverFrameworks-UserMode/Operational"
    | "Microsoft-Windows-Kernel-WHEA/Errors"
    | "Microsoft-Windows-Storage-Storport/Operational"
    | "Microsoft-Windows-Ntfs/Operational"
    | "Microsoft-Windows-NetworkProfile/Operational"
    | "Microsoft-Windows-Dhcp-Client/Admin"
    | "Microsoft-Windows-DNS-Client/Operational"
    | "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    | "Microsoft-Windows-WindowsUpdateClient/Operational";
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
 * Operations that take no parameters accept only an empty object.
 */
export interface PeripheralStatusParams {}

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
