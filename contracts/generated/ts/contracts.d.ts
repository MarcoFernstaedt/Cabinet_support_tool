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
 * One program a cabinet may be asked to start, stop or restart (docs/spec/13-roadmap.md: process.end and app.restart with a per-client allowlist). An application, or a service with its key name. The path is the whole executable path: it is what the cabinet checks the running program against, exactly, before it acts on it.
 */
export interface ApprovedAppEntry {
  /**
   * How a request names one entry of an approved-applications list: app: followed by the entry's short name. Never a PID, a service name alone or a command line (a PID points at a running program but cannot be stored: Windows reuses them).
   */
  key: string;
  kind: "application" | "service";
  /**
   * What the operator called it (a display name, never the thing that is matched on).
   */
  name: string;
  /**
   * Absolute local path to a program file. No relative segments, UNC, device or wildcard paths.
   */
  path: string;
  /**
   * A Windows service's key name (not its display name). Letters, digits, _ . $ - and inner spaces; SQL Server's MSSQL$NAME form included.
   */
  serviceName?: string;
}

/**
 * An approved-applications list: at most 32 entries, one per key. Empty means this level approves nothing; the level above applies only when no list is set at all.
 *
 * @maxItems 32
 */
export type ApprovedAppEntries = ApprovedAppEntry[];

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
 * A firewall policy: each Windows firewall profile on or off. Set for the fleet, a client or a site; the most specific level with a policy applies (docs/spec/05-server-spec.md "Site policies").
 */
export interface FirewallProfilePolicy {
  domain: "on" | "off";
  private: "on" | "off";
  public: "on" | "off";
}

/**
 * A new site's own policies, confirmed with its first approval. A field left out or null means the site sets none and inherits: the client's firewall policy, else the fleet's; the client's time zone, else the fleet's. The network standard is set later from what the site's cabinets report.
 */
export interface SitePolicies {
  firewall?: FirewallProfilePolicy | null;
  timeZone?:
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
 * One physical drive's own health report: Windows' verdict, the drive's failure prediction, and its wear and error counters.
 */
export interface DriveHealthReport {
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
}

export interface ConfigItem {
  /**
   * A stable name for one item in a category: adapter:Ethernet, service:Spooler, rule:Allow Sync, time. Never an index.
   */
  key: string;
  values: {
    /**
     * One value of an item: short text, a whole number, true or false, nothing, or a short list of texts.
     */
    [k: string]: (string | number | boolean | null | string[]) | undefined;
  };
}

export interface ConfigSnapshotCategory {
  /**
   * A part of a cabinet's configuration that is collected, compared with baselines and watched for change.
   */
  category:
    | "network"
    | "services"
    | "drivers"
    | "updates"
    | "firewall"
    | "time"
    | "devices"
    | "applications"
    | "hosts"
    | "tasks"
    | "system";
  /**
   * SHA-256 of the canonical JSON of a category's items sorted by key, as 64 lower-case hex digits. The server recomputes it and refuses a snapshot whose hash does not match.
   */
  hash: string;
  /**
   * True when the cabinet had more items than the cap and the rest were left out.
   */
  truncated: boolean;
  /**
   * @maxItems 2000
   */
  items: ConfigItem[];
}

/**
 * Whether a client uses a fingerprint scanner. On: the scanner's service (added to the client's approved list, waiting for a signature when signing is on, and to its watched services) and, optionally, the client's scanner hardware IDs (null leaves them as they are; the agent then finds the scanner itself). Off: nothing else.
 */
export interface ClientScannerChoice {
  enabled: boolean;
  /**
   * The fingerprint scanner's Windows service, as an approved-list entry: a service with its key name and the exact program path it runs.
   */
  service?: ApprovedAppEntry & {
    kind: "service";
  };
  hardwareIds?: [string, ...string[]] | null;
}

/**
 * The public halves of the Admin list-signing keys, compiled into the agent (contracts/trust/approved-list) the way the release keys are: only a signed agent upgrade can change them, and the server has no say. At most two keys: the one in use and the next one while the key is changed. An empty list means this build does not check list signatures yet, and treats the approved list as it did before signing existed.
 */
export interface ApprovedListKeys {
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
}

/**
 * The detached signature over an approved-list document's exact bytes: ECDSA P-256 over the SHA-256 of the document, DER-encoded, made with the Admin's list-signing key on the Admin's own computer (Sign-ApprovedList.ps1). keyId names which of the agent's compiled-in list keys made it (the SHA-256 of that key's SubjectPublicKeyInfo), so a second key can be added before the first is retired. The same shape as a release signature, but a different key: the release key never signs a list, and the list key never signs a release.
 */
export interface ApprovedListSignature {
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
 * One level's approved programs as an Admin signs them (docs/spec/09-open-decisions.md, "Signing the approved list"). The server writes these exact bytes when an Admin saves a list; the Admin signs the bytes on their own computer with the list-signing key (Sign-ApprovedList.ps1), and the cabinet's broker checks that signature against the keys compiled into the agent before it reads anything in the document. The product field keeps a signature over this document from ever being mistaken for any other signed file.
 */
export interface ApprovedList {
  product: "mashura-approved-list";
  /**
   * The level the Admin set the list for. Shown to the person signing it; the cabinet does not choose between levels from it.
   */
  level: "fleet" | "client" | "site" | "cabinet";
  /**
   * The client, site or cabinet id; null for the fleet.
   */
  scopeId: string | null;
  /**
   * The level's version: it steps up by one on every change.
   */
  version: number;
  /**
   * When the Admin saved the list on the server.
   */
  issuedAt: string;
  entries: ApprovedAppEntries;
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
 * What the signed-in person did, as case notes: optionally one cabinet, over the last few hours. Always the caller's own activity.
 */
export interface ActivityReportQuery {
  cabinetId?: string;
  hours?: "1" | "4" | "8" | "24" | "72" | "168";
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
 * Resolve a claimed alert. All parts are optional: a note, the cause (what was really wrong) and the fix (one of the issue type's known fixes, or typed). The server counts which fix resolved each issue type's alerts and shows 'usually fixed by' first on the next alert.
 */
export interface AlertResolve {
  note?: string;
  /**
   * What was wrong, in the person's words (up to 500 characters).
   */
  cause?: string;
  fix?:
    | {
        kind: "known";
        fixId: string;
      }
    | {
        kind: "text";
        text: string;
      };
  /**
   * With a typed fix: also keep it as a known fix for the alert's issue type (an Admin approves it first unless the person may approve fixes).
   */
  saveFix?: boolean;
}

/**
 * Asks one cabinet to start, stop or restart a service, or to end one process, by naming an entry of that cabinet's approved-applications list and an action (docs/spec/13-roadmap.md milestone 10). The service name, the program's path and the command line are never in the request: the server looks them up from the entry it was given, so what a caller names and what runs cannot drift apart. A process is named by the ID the cabinet itself reported last, which the server resolves to the program running under it and matches against the entry's own path before anything is issued; the ID is a pointer, never the thing that is checked. The step-up token is bound to this exact entry, this action and this cabinet: the canonical hash of everything below except the token itself.
 */
export interface AppControl {
  /**
   * The cabinet to ask.
   */
  cabinetId: string;
  /**
   * One entry of this cabinet's approved list, exactly as it is stored. Its most specific level's list is the only list consulted, so an entry approved for another level or another cabinet is not found here.
   */
  entryKey: string;
  /**
   * What to ask for. Deliberately not an enum: the server decides what the entry's kind allows and refuses the rest with a code and a sentence a Tier 2 can act on, so a later change (restarting an application) needs no new body.
   */
  action: string;
  /**
   * Only with action end: the process ID from the cabinet's own last processes.list reading, never one the caller picked. The server refuses an ID the cabinet never reported, and refuses a program that is not the entry's own path.
   */
  processId?: number;
  /**
   * A one-time step-up token, bound to the action named here, this cabinet, and the canonical hash of the rest of this body.
   */
  stepUpToken: string;
}

/**
 * Query string of GET /api/admin/enrollments/:id/baseline and /site-policies: the client and site an approval would use, so the approval can show which approved baseline would apply and which firewall policy and time zone the site would inherit. Reading it changes nothing; the approval checks everything again.
 */
export interface ApproveEnrollmentBaseline {
  client: string;
  site: string;
}

/**
 * Approve a pending cabinet: where it belongs, what it is called, its role, and the baseline it is judged against. A satellite may name the sync cabinet it reaches (an active sync cabinet at the same site); left out, it is linked to the site's only sync cabinet, or stays incomplete until one is assigned. Every approval carries a baseline decision.
 */
export interface ApproveEnrollment {
  client: string;
  site: string;
  cabinet: string;
  role: "sync" | "satellite" | "standalone";
  /**
   * The sync cabinet this satellite reaches. Only a satellite names one.
   */
  syncCabinetId?: string;
  scanner?: ClientScannerChoice;
  sitePolicies?: SitePolicies;
  /**
   * The baseline decision every approval needs (docs/spec/15-baselines-and-config.md "Baselines at enrollment"). inherited: an approved baseline already applies (fleet, client or site level), and the server checks that one does. attach: copy the named approved baseline version to the cabinet's site as the site's baseline. capture: the cabinet's first full configuration report becomes the site's baseline draft, which is then reviewed and approved with the two-person rule.
   */
  baseline:
    | {
        use: "inherited";
      }
    | {
        use: "attach";
        versionId: string;
      }
    | {
        use: "capture";
      };
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * The applications and services a cabinet may be asked to control (docs/spec/13-roadmap.md: process.end and app.restart with a per-client allowlist). One entry pins the exact program: the executable path is written by an owner and never by a Tier 1 or Tier 2 account, by the console's write path or by the agent. A server administrator sets the list for the fleet, a client, a site or a cabinet through the device-settings route, with step-up and an audit entry. entries null removes that level's list so the level above applies; an empty list means control nothing at this level.
 */
export interface ApprovedApps {
  /**
   * The level the list is set for. The most specific level with a list wins whole for a cabinet.
   */
  level: "fleet" | "client" | "site" | "cabinet";
  /**
   * The client, site or cabinet id; null for the fleet (level fleet).
   */
  id: string | null;
  /**
   * At most 32 approved programs, one per key. An application is pinned by its executable path alone; a service is pinned by its registered executable path AND its service name, so a service that has been replaced by something else of the same name is not controlled by mistake. null removes this level's list so the level above applies; an empty list means control nothing at this level.
   */
  entries: ApprovedAppEntries | null;
  /**
   * A one-time step-up token bound to this exact action, level and these exact entries.
   */
  stepUpToken: string;
}

/**
 * An Admin's signature for one level's approved list (docs/spec/09-open-decisions.md "Signing the approved list"): the file Sign-ApprovedList.ps1 wrote, for the version the console offered. The server checks it over the exact document it offered for that level and version, with a key the agents hold, before the list goes into force. No step-up code: the signature is the Admin's confirmation, made on their own computer.
 */
export interface ApprovedListSign {
  level: "fleet" | "client" | "site" | "cabinet";
  /**
   * The client, site or cabinet id; null for the fleet.
   */
  id: string | null;
  /**
   * The version the signature is for, as the console offered it.
   */
  version: number;
  signature: ApprovedListSignature;
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
 * Makes a draft from what a cabinet reports now. Nothing is approved by capturing: the draft is reviewed, pruned and proposed like any other.
 */
export interface BaselineCapture {
  cabinetId: string;
  scope: BaselineScope;
  description: string;
  /**
   * @minItems 1
   * @maxItems 11
   */
  categories?: [
    (
      | "network"
      | "services"
      | "drivers"
      | "updates"
      | "firewall"
      | "time"
      | "devices"
      | "applications"
      | "hosts"
      | "tasks"
      | "system"
    ),
    ...(
      | "network"
      | "services"
      | "drivers"
      | "updates"
      | "firewall"
      | "time"
      | "devices"
      | "applications"
      | "hosts"
      | "tasks"
      | "system"
    )[]
  ];
}

/**
 * What a baseline expects: items by category and key, and what counts as healthy.
 */
export interface BaselineContent {
  /**
   * @maxItems 5000
   */
  items: {
    /**
     * A part of a cabinet's configuration that is collected, compared with baselines and watched for change.
     */
    category:
      | "network"
      | "services"
      | "drivers"
      | "updates"
      | "firewall"
      | "time"
      | "devices"
      | "applications"
      | "hosts"
      | "tasks"
      | "system";
    /**
     * A stable name for one item in a category: adapter:Ethernet, service:Spooler, rule:Allow Sync, time. Never an index.
     */
    key: string;
    /**
     * match: the listed fields must equal these values; present: the item must exist; absent: it must not; ignore: cancels an expectation inherited from a wider scope.
     */
    mode: "match" | "present" | "absent" | "ignore";
    expect?: {
      /**
       * One value of an item: short text, a whole number, true or false, nothing, or a short list of texts.
       */
      [k: string]: (string | number | boolean | null | string[]) | undefined;
    };
    /**
     * Health depends on this item meeting its expectation.
     */
    required?: boolean;
    severity?: "minor" | "major";
    note?: string;
  }[];
  health?: {
    maxOfflineMinutes?: number;
    requireRequiredItems?: boolean;
    requireNoCriticalAlerts?: boolean;
  };
}

/**
 * An Admin approves or rejects a proposed baseline version, with the reason in writing; confirmed with an authenticator code bound to this note.
 */
export interface BaselineDecision {
  note: string;
  stepUpToken: string;
}

/**
 * Creates a draft version of the baseline for a scope (the baseline itself is created with its first version).
 */
export interface BaselineDraft {
  scope: BaselineScope;
  description: string;
  content: BaselineContent;
  compat?: {
    /**
     * @maxItems 20
     */
    osBuilds?: string[];
    /**
     * @maxItems 20
     */
    models?: string[];
  };
}

/**
 * Copies the approved content of one scope's baseline into a draft for another scope.
 */
export interface BaselineImport {
  from: BaselineScope;
  to: BaselineScope;
  description: string;
}

/**
 * Where a baseline applies: the whole fleet, a cabinet model, a client, a site or one cabinet. A model is named by its text; the others by their ID.
 */
export interface BaselineScope {
  kind: "global" | "model" | "client" | "site" | "cabinet";
  id: null | string;
}

/**
 * Edits a draft version: its description or its content.
 */
export interface BaselineUpdate {
  description?: string;
  content?: BaselineContent;
}

/**
 * Which baselines the list shows.
 */
export interface BaselinesQuery {
  scopeKind?: "global" | "model" | "client" | "site" | "cabinet";
  scopeId?: string;
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
 * The query string of a cabinet's configuration changes and history: how many days, which category, a text to look for, and whether to show only changes that go against the baseline.
 */
export interface CabinetHistoryQuery {
  days?: string;
  limit?: string;
  /**
   * A part of a cabinet's configuration that is collected, compared with baselines and watched for change.
   */
  category?:
    | "network"
    | "services"
    | "drivers"
    | "updates"
    | "firewall"
    | "time"
    | "devices"
    | "applications"
    | "hosts"
    | "tasks"
    | "system";
  q?: string;
  violations?: "true" | "false";
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
 * Sets the address a sync cabinet's satellites reach: a private IPv4 address that a report never replaces. null goes back to the address the cabinet reports itself.
 */
export interface CabinetSyncAddress {
  address: string | null;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Assigns a satellite to a sync cabinet at its own site, or unassigns it (null), which leaves its enrollment incomplete.
 */
export interface CabinetSyncCabinet {
  syncCabinetId: string | null;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * A case note on a cabinet, optionally tied to one of its alerts: what was found, what was done, what is left. Plain text, up to 2,000 characters. Never put passwords or patient data in a note.
 */
export interface CaseNoteCreate {
  body: string;
  alertId?: string;
}

/**
 * A cabinet's case notes, newest first; optionally only those tied to one alert.
 */
export interface CaseNoteQuery {
  alertId?: string;
}

/**
 * An Admin removes the text of a case note (a password or personal data was pasted into it). The note stays, marked removed, with the reason; the audit log keeps who did it.
 */
export interface CaseNoteRedact {
  reason: string;
}

/**
 * Switches a client's fingerprint scanner on or off (Admin, authenticator code bound to this exact body).
 */
export interface ClientScanner {
  scanner: ClientScannerChoice;
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
    | "usb.ports"
    | "drivers.list"
    | "peripheral.status"
    | "updates.status"
    | "disk.smart"
    | "files.list"
    | "network.config"
    | "network.test"
    | "network.trace"
    | "system.performance"
    | "network.listeners"
    | "firewall.state"
    | "network.setIp"
    | "network.setDns"
    | "firewall.setProfile"
    | "firewall.applyPolicy"
    | "firewall.setRule"
    | "firewall.restore"
    | "package.install"
    | "driver.uninstall"
    | "updates.uninstall"
    | "services.list"
    | "processes.list"
    | "service.control"
    | "service.setStartType"
    | "time.status"
    | "time.setZone"
    | "time.sync"
    | "network.renewLease"
    | "network.flushDns"
    | "system.security"
    | "software.list"
    | "startup.list"
    | "sessions.list"
    | "shares.list"
    | "reliability.list"
    | "disk.folders"
    | "dns.cache"
    | "power.status"
    | "system.restart"
    | "process.end"
    | "system.checkHealth"
    | "power.set"
    | "system.hardware"
    | "system.identity"
    | "network.hosts"
    | "config.snapshot";
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
 * Error trends (query string): the cabinets and events per day over the last 30 days for each issue type and each unrecognized error, marked new or rising. Filter by client, by mark, or to the unrecognized errors only.
 */
export interface ErrorTrendQuery {
  clientId?: string;
  mark?: "new" | "rising" | "all";
  unrecognized?: "true" | "false";
  days?: "7" | "14" | "30";
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
 * A request for an encrypted evidence package: how many days back and the passphrase it is encrypted with. The passphrase is used once to derive the key and is never stored or logged.
 */
export interface EvidenceExport {
  days: "1" | "3" | "7" | "14" | "30" | "60" | "90";
  passphrase: string;
}

/**
 * An Admin sets the fleet default, a client's or a site's firewall policy: each profile on or off. null for a client or site removes its own policy, so the level above applies (site → client → fleet).
 */
export interface FirewallPolicy {
  policy: FirewallProfilePolicy | null;
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
 * One difference from the baselines, seen across the fleet: an item and, when named, one of its fields, over all cabinets, one client or one site.
 */
export interface FleetDifferenceGroupQuery {
  /**
   * A part of a cabinet's configuration that is collected, compared with baselines and watched for change.
   */
  category:
    | "network"
    | "services"
    | "drivers"
    | "updates"
    | "firewall"
    | "time"
    | "devices"
    | "applications"
    | "hosts"
    | "tasks"
    | "system";
  /**
   * A stable name for one item in a category: adapter:Ethernet, service:Spooler, rule:Allow Sync, time. Never an index.
   */
  itemKey: string;
  field?: string;
  clientId?: string;
  siteId?: string;
}

/**
 * Which cabinets the fleet's differences from their baselines are counted over: all, one client or one site.
 */
export interface FleetDifferencesQuery {
  clientId?: string;
  siteId?: string;
}

/**
 * Starts a fleet operation (docs/spec/13-roadmap.md modules 21 and 45): one fixed operation on up to 200 chosen cabinets, as a job with a fixed target list, run in batches, each cabinet's result and verification recorded. The parameters come from the server: each cabinet's site's zone for time.setZone, its client's policy for firewall.applyPolicy. Confirmed with the password: the token (action fleet.job, target jobId) is bound to {operation, cabinetIds, batchSize}. For network.setDns and network.setIp the server takes each cabinet's change from its latest network diagnosis (at most 30 minutes old); a cabinet without a current finding is skipped.
 */
export interface FleetJob {
  /**
   * Chosen by the console, so the confirmation is bound to this one job.
   */
  jobId: string;
  operation:
    "time.setZone" | "time.sync" | "firewall.applyPolicy" | "network.setDns" | "network.setIp" | "network.renewLease";
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
  operation:
    "time.setZone" | "time.sync" | "firewall.applyPolicy" | "network.setDns" | "network.setIp" | "network.renewLease";
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
 * How far back a cabinet's load samples are wanted, from the query string.
 */
export interface HealthQuery {
  hours?: "6" | "24" | "72" | "168" | "336";
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
 * Saves what fixed a problem, with the problem it fixes (a finding of the diagnosis, or an issue type) and the cabinet it was seen on. The server records that cabinet's environment itself; the console does not send it. Matching is exact, never a pattern.
 */
export interface KnownFixCreate {
  title: string;
  solution: string;
  cabinetId: string;
  symptom:
    | {
        kind: "finding";
        key: string;
      }
    | {
        kind: "issue";
        issueTypeId: string;
      };
  /**
   * The alert this fix was saved from, if any. Resolving that alert then carries the fix's note into its resolution.
   */
  alertId?: string;
}

/**
 * Known fixes for a problem: by diagnosis finding key or by issue type, with the cabinet to compare the environment with. With neither, every known fix.
 */
export interface KnownFixQuery {
  findingKey?: string;
  issueTypeId?: string;
  cabinetId?: string;
}

/**
 * Rejects a submitted known fix, with an optional reason the submitter can read.
 */
export interface KnownFixReject {
  /**
   * A single line of text with no control characters.
   */
  reason?: string;
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
  /**
   * How the agents pace themselves: the heartbeat answer carries these values (docs/spec/03-protocol.md Protocol 1.1).
   */
  agents?: {
    /**
     * Seconds between heartbeats.
     */
    heartbeatSeconds?: number;
    /**
     * How long the server holds a command poll.
     */
    pollSeconds?: number;
    /**
     * Pause between event batches while an agent catches up after an outage.
     */
    eventsPaceMs?: number;
  };
}

/**
 * A search of the latest stored reading of one kind across the fleet, from the query string. q is plain text matched as a part of a name (never a pattern), or for power.status, system.security and system.identity one of their fixed keywords. The server limits what comes back.
 */
export interface ReadingSearch {
  operation:
    | "software.list"
    | "startup.list"
    | "shares.list"
    | "sessions.list"
    | "dns.cache"
    | "power.status"
    | "system.security"
    | "system.hardware"
    | "system.identity"
    | "network.hosts";
  q: string;
  clientId?: string;
  siteId?: string;
}

/**
 * Adds a signed agent release to the update store (docs/spec/07-upgrade-channel.md step 3): the manifest exactly as the pipeline signed it, and its detached signature. The server checks the signature against the release keys it knows of; the package zip follows in a second request and must match the manifest's hash and size. None of this is the protection: each agent checks everything again against its own compiled-in key. A release is one version for one Windows architecture (docs/platform/second-architecture.md): the architecture is declared here, and the package's own programs are read to make sure it really is that one, because it cannot live in the signed manifest - that schema is closed and every already-installed agent validates it.
 */
export interface ReleaseCreate {
  /**
   * Base64 of the manifest's exact bytes.
   */
  manifest: string;
  signature: UpgradeSignature;
  /**
   * Which Windows this release's programs are built for. The package that follows must really be built for it - the server reads the .exe programs inside the zip - and the release is only ever offered to cabinets of this same architecture.
   */
  architecture: "windows-x64" | "windows-x86";
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * Starts a staged rollout of one release (docs/spec/07-upgrade-channel.md "Staged rollout"): batch 1 is the one cabinet named here, batch 2 the in-office cabinets, batch 3 about 5 percent of the rest of the fleet, batch 4 everyone else. A batch must reach successRatePercent before the next starts; failures above failureLimitPercent of a batch pause the rollout on their own. A release is one version for one Windows architecture (docs/platform/second-architecture.md), so the version alone does not name one: the architecture does, and only cabinets built for it are ever targets - the others could not run the package at all.
 */
export interface RolloutStart {
  /**
   * Semantic version of the agent.
   */
  version: string;
  /**
   * Which Windows the release being rolled out is for. Cabinets of the other architecture are left out of every batch and counted in the audit as wrongArchitecture, so a rollout can never offer a package a cabinet cannot run.
   */
  architecture: "windows-x64" | "windows-x86";
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
 * A runbook for an issue type or a diagnosis finding: ordered steps a support person follows, each with an optional read-only check and an optional one-click fix. Tier 2 proposes; an Admin approves with an authenticator code. At most 12 steps and 5 links; the server also limits the total text to 4,000 characters.
 */
export interface RunbookPropose {
  target:
    | {
        kind: "issue";
        issueTypeId: string;
      }
    | {
        kind: "finding";
        key: string;
      };
  title: string;
  /**
   * @minItems 1
   * @maxItems 12
   */
  steps: [
    {
      title: string;
      detail?: string;
      /**
       * A read-only operation the person can run from the step. The server accepts reads only, with parameters that fit the operation's own schema.
       */
      check?: {
        /**
         * Every operation in the agent catalog (contracts/schemas/operations/catalog.json).
         */
        operation:
          | "system.info"
          | "eventlog.channels"
          | "eventlog.query"
          | "eventlog.get"
          | "devices.list"
          | "usb.ports"
          | "drivers.list"
          | "peripheral.status"
          | "updates.status"
          | "disk.smart"
          | "files.list"
          | "network.config"
          | "network.test"
          | "network.trace"
          | "system.performance"
          | "network.listeners"
          | "firewall.state"
          | "network.setIp"
          | "network.setDns"
          | "firewall.setProfile"
          | "firewall.applyPolicy"
          | "firewall.setRule"
          | "firewall.restore"
          | "package.install"
          | "driver.uninstall"
          | "updates.uninstall"
          | "services.list"
          | "processes.list"
          | "service.control"
          | "service.setStartType"
          | "time.status"
          | "time.setZone"
          | "time.sync"
          | "network.renewLease"
          | "network.flushDns"
          | "system.security"
          | "software.list"
          | "startup.list"
          | "sessions.list"
          | "shares.list"
          | "reliability.list"
          | "disk.folders"
          | "dns.cache"
          | "power.status"
          | "system.restart"
          | "process.end"
          | "system.checkHealth"
          | "power.set"
          | "system.hardware"
          | "system.identity"
          | "network.hosts"
          | "config.snapshot";
        params: {};
      };
      /**
       * A change the person can make from the step with one click. The server accepts only catalog writes confirmed by a click; the person's role, the write pause and the cabinet's own rules still decide whether it runs.
       */
      fix?: {
        /**
         * Every operation in the agent catalog (contracts/schemas/operations/catalog.json).
         */
        operation:
          | "system.info"
          | "eventlog.channels"
          | "eventlog.query"
          | "eventlog.get"
          | "devices.list"
          | "usb.ports"
          | "drivers.list"
          | "peripheral.status"
          | "updates.status"
          | "disk.smart"
          | "files.list"
          | "network.config"
          | "network.test"
          | "network.trace"
          | "system.performance"
          | "network.listeners"
          | "firewall.state"
          | "network.setIp"
          | "network.setDns"
          | "firewall.setProfile"
          | "firewall.applyPolicy"
          | "firewall.setRule"
          | "firewall.restore"
          | "package.install"
          | "driver.uninstall"
          | "updates.uninstall"
          | "services.list"
          | "processes.list"
          | "service.control"
          | "service.setStartType"
          | "time.status"
          | "time.setZone"
          | "time.sync"
          | "network.renewLease"
          | "network.flushDns"
          | "system.security"
          | "software.list"
          | "startup.list"
          | "sessions.list"
          | "shares.list"
          | "reliability.list"
          | "disk.folders"
          | "dns.cache"
          | "power.status"
          | "system.restart"
          | "process.end"
          | "system.checkHealth"
          | "power.set"
          | "system.hardware"
          | "system.identity"
          | "network.hosts"
          | "config.snapshot";
        params: {};
        label: string;
      };
    },
    ...{
      title: string;
      detail?: string;
      /**
       * A read-only operation the person can run from the step. The server accepts reads only, with parameters that fit the operation's own schema.
       */
      check?: {
        /**
         * Every operation in the agent catalog (contracts/schemas/operations/catalog.json).
         */
        operation:
          | "system.info"
          | "eventlog.channels"
          | "eventlog.query"
          | "eventlog.get"
          | "devices.list"
          | "usb.ports"
          | "drivers.list"
          | "peripheral.status"
          | "updates.status"
          | "disk.smart"
          | "files.list"
          | "network.config"
          | "network.test"
          | "network.trace"
          | "system.performance"
          | "network.listeners"
          | "firewall.state"
          | "network.setIp"
          | "network.setDns"
          | "firewall.setProfile"
          | "firewall.applyPolicy"
          | "firewall.setRule"
          | "firewall.restore"
          | "package.install"
          | "driver.uninstall"
          | "updates.uninstall"
          | "services.list"
          | "processes.list"
          | "service.control"
          | "service.setStartType"
          | "time.status"
          | "time.setZone"
          | "time.sync"
          | "network.renewLease"
          | "network.flushDns"
          | "system.security"
          | "software.list"
          | "startup.list"
          | "sessions.list"
          | "shares.list"
          | "reliability.list"
          | "disk.folders"
          | "dns.cache"
          | "power.status"
          | "system.restart"
          | "process.end"
          | "system.checkHealth"
          | "power.set"
          | "system.hardware"
          | "system.identity"
          | "network.hosts"
          | "config.snapshot";
        params: {};
      };
      /**
       * A change the person can make from the step with one click. The server accepts only catalog writes confirmed by a click; the person's role, the write pause and the cabinet's own rules still decide whether it runs.
       */
      fix?: {
        /**
         * Every operation in the agent catalog (contracts/schemas/operations/catalog.json).
         */
        operation:
          | "system.info"
          | "eventlog.channels"
          | "eventlog.query"
          | "eventlog.get"
          | "devices.list"
          | "usb.ports"
          | "drivers.list"
          | "peripheral.status"
          | "updates.status"
          | "disk.smart"
          | "files.list"
          | "network.config"
          | "network.test"
          | "network.trace"
          | "system.performance"
          | "network.listeners"
          | "firewall.state"
          | "network.setIp"
          | "network.setDns"
          | "firewall.setProfile"
          | "firewall.applyPolicy"
          | "firewall.setRule"
          | "firewall.restore"
          | "package.install"
          | "driver.uninstall"
          | "updates.uninstall"
          | "services.list"
          | "processes.list"
          | "service.control"
          | "service.setStartType"
          | "time.status"
          | "time.setZone"
          | "time.sync"
          | "network.renewLease"
          | "network.flushDns"
          | "system.security"
          | "software.list"
          | "startup.list"
          | "sessions.list"
          | "shares.list"
          | "reliability.list"
          | "disk.folders"
          | "dns.cache"
          | "power.status"
          | "system.restart"
          | "process.end"
          | "system.checkHealth"
          | "power.set"
          | "system.hardware"
          | "system.identity"
          | "network.hosts"
          | "config.snapshot";
        params: {};
        label: string;
      };
    }[]
  ];
  /**
   * @maxItems 5
   */
  links?: {
    label: string;
    url: string;
  }[];
}

/**
 * Runbooks for an issue type or a finding (query string). With neither, the runbooks in the given state (default: approved).
 */
export interface RunbookQuery {
  issueTypeId?: string;
  findingKey?: string;
  state?: "proposed" | "approved" | "rejected" | "retired";
}

/**
 * The fingerprint scanner's hardware IDs for the fleet default, a client, a site or one cabinet; the most specific one set applies. null removes that level's setting. An ID may be a whole hardware ID (USB\\VID_1234&PID_5678) or a vendor prefix (USB\\VID_1234), which matches every model from that vendor. With none set anywhere, cabinets find the scanner themselves (the Biometric device class).
 */
export interface ScannerSettings {
  hardwareIds: [string, ...string[]] | null;
  /**
   * Optional: a one-time step-up token bound to this exact action. These settings change no cabinet by themselves, so no code is required; a token, if sent, is consumed.
   */
  stepUpToken?: string;
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
 * The sign-in list's filter, from the query string: all recent sign-ins, or only those from a network or device the account had not used before.
 */
export interface SignInFilter {
  scope?: "all" | "new";
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
  /**
   * Optional: a one-time step-up token bound to this exact action. These settings change no cabinet by themselves, so no code is required; a token, if sent, is consumed.
   */
  stepUpToken?: string;
}

/**
 * Sets the Windows time zone for a site (Tier 2 and up), a client's default (Tier 2 and up) or the fleet default (Admin), or clears it with null so the level above applies (site → client → fleet). Cabinets in another zone than the one that applies get a minor alert; nothing changes on a cabinet until someone corrects it.
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
    | "updates.uninstall"
    | "system.restart"
    | "process.end"
    | "service.control"
    | "service.setStartType"
    | "package.upload"
    | "package.approve"
    | "package.retire"
    | "writes.pause"
    | "writes.resume"
    | "user.create"
    | "user.update"
    | "user.delete"
    | "user.reactivate"
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
    | "cabinet.sync_cabinet"
    | "cabinet.sync_address"
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
    | "client.fingerprint_scanner"
    | "site.scanner"
    | "client.sync"
    | "settings.sync"
    | "client.firewall_policy"
    | "fleet.firewall_policy"
    | "site.firewall_policy"
    | "site.network_baseline"
    | "runbook.approve"
    | "runbook.reject"
    | "runbook.retire"
    | "baseline.approve"
    | "baseline.reject"
    | "settings.apps"
    | "client.apps"
    | "site.apps"
    | "cabinet.apps"
    | "settings.usb-policy"
    | "client.usb-policy"
    | "site.usb-policy"
    | "cabinet.usb-policy"
    | "settings.filefacts"
    | "client.filefacts"
    | "site.filefacts"
    | "cabinet.filefacts";
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
 * The System health page's request. It takes no parameters; anything in the query string is refused.
 */
export interface SystemHealthQuery {}

/**
 * The triage queue (query string): what needs attention first across the fleet, optionally for one client or site, looking back 7, 14 or 30 days.
 */
export interface TriageQuery {
  clientId?: string;
  siteId?: string;
  days?: "7" | "14" | "30";
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
 * An Admin brings a deleted account back, with the reason in writing; the reason goes into the audit log. The server makes a new temporary password, shown once.
 */
export interface UserReactivate {
  reason: string;
  /**
   * A one-time step-up token bound to this exact action.
   */
  stepUpToken: string;
}

/**
 * An Admin changes an account's role, hourly write limit, status, or whether a Tier 2 may approve known fixes. At least one change.
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
  /**
   * Whether this person may approve the known fixes members submit. An Admin always may; for a Tier 2 it is granted here.
   */
  canApproveFixes?: boolean;
}

/**
 * The query string of the Admin user list: whether to include deleted accounts.
 */
export interface UsersQuery {
  deleted?: "true" | "false";
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
    | "usb.ports"
    | "drivers.list"
    | "peripheral.status"
    | "updates.status"
    | "disk.smart"
    | "files.list"
    | "network.config"
    | "network.test"
    | "network.trace"
    | "system.performance"
    | "network.listeners"
    | "firewall.state"
    | "network.setIp"
    | "network.setDns"
    | "firewall.setProfile"
    | "firewall.applyPolicy"
    | "firewall.setRule"
    | "firewall.restore"
    | "package.install"
    | "driver.uninstall"
    | "updates.uninstall"
    | "services.list"
    | "processes.list"
    | "service.control"
    | "service.setStartType"
    | "time.status"
    | "time.setZone"
    | "time.sync"
    | "network.renewLease"
    | "network.flushDns"
    | "system.security"
    | "software.list"
    | "startup.list"
    | "sessions.list"
    | "shares.list"
    | "reliability.list"
    | "disk.folders"
    | "dns.cache"
    | "power.status"
    | "system.restart"
    | "process.end"
    | "system.checkHealth"
    | "power.set"
    | "system.hardware"
    | "system.identity"
    | "network.hosts"
    | "config.snapshot";
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
 * Long-poll response: waiting commands for this cabinet, or an empty list after up to pollSeconds (default 25). A command stays leased to the agent until the agent acknowledges it (the next poll's ack list) or posts its result; one not acknowledged within 30 seconds is offered again, and the agent answers a repeat from its own result store.
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
  /**
   * How long the server holds the next poll, chosen by the server (load, NAT behaviour). The agent uses its default (25) when absent.
   */
  pollSeconds?: number;
  /**
   * The server is shutting down or shedding load: wait this long (already randomised by the server) before the next request.
   */
  reconnectAfterMs?: number;
}

/**
 * Configuration categories that changed since the agent last reported them (change-only), oldest first, each with when the agent looked. Up to 8 per request; a cabinet that was offline sends what it kept, and says when it had to drop older ones.
 */
export interface ConfigUpload {
  /**
   * @minItems 1
   * @maxItems 8
   */
  snapshots: [
    {
      /**
       * UTC time, ISO 8601, always ending in Z.
       */
      observedAt: string;
      /**
       * A part of a cabinet's configuration that is collected, compared with baselines and watched for change.
       */
      category:
        | "network"
        | "services"
        | "drivers"
        | "updates"
        | "firewall"
        | "time"
        | "devices"
        | "applications"
        | "hosts"
        | "tasks"
        | "system";
      /**
       * SHA-256 of the canonical JSON of a category's items sorted by key, as 64 lower-case hex digits. The server recomputes it and refuses a snapshot whose hash does not match.
       */
      hash: string;
      truncated: boolean;
      /**
       * True when the agent dropped older snapshots of this category before this one (its queue was full), so changes in between are unknown.
       */
      gapBefore?: boolean;
      /**
       * @maxItems 2000
       */
      items: ConfigItem[];
    },
    ...{
      /**
       * UTC time, ISO 8601, always ending in Z.
       */
      observedAt: string;
      /**
       * A part of a cabinet's configuration that is collected, compared with baselines and watched for change.
       */
      category:
        | "network"
        | "services"
        | "drivers"
        | "updates"
        | "firewall"
        | "time"
        | "devices"
        | "applications"
        | "hosts"
        | "tasks"
        | "system";
      /**
       * SHA-256 of the canonical JSON of a category's items sorted by key, as 64 lower-case hex digits. The server recomputes it and refuses a snapshot whose hash does not match.
       */
      hash: string;
      truncated: boolean;
      /**
       * True when the agent dropped older snapshots of this category before this one (its queue was full), so changes in between are unknown.
       */
      gapBefore?: boolean;
      /**
       * @maxItems 2000
       */
      items: ConfigItem[];
    }[]
  ];
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
    /**
     * Which Windows this installer's agent programs are built for: what the cabinet is approved and later updated as. Absent from agents built before the second architecture, which are all win-x64.
     */
    architecture?: "windows-x64" | "windows-x86";
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
    /**
     * false when the cabinet's client does not use a fingerprint scanner: the agent does not look for one and reports nothing about it. Left out, the agent watches as before. Sent only to agents that know it (0.3.1 and later): the answer's contract is closed, so an older agent would refuse it.
     */
    watch?: boolean;
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
  /**
   * The programs this cabinet may be asked to start, stop or restart: the cabinet's own list, else its site's, else its client's, else the fleet's. Empty when none is set. The agent keeps its own copy and acts only on these, re-checking the program it finds at the entry's exact path. Absent from an older server's answer, which leaves the agent with an empty list.
   */
  approvedApps?: {
    entries: ApprovedAppEntries;
    /**
     * The same list as an Admin signed it (docs/spec/09-open-decisions.md "Signing the approved list"): base64 of the signed document's exact bytes and the detached signature over them. An agent built with a list-signing key acts only on this, and only once the signature verifies; entries is kept for agents built before signing. Sent only to agents from 0.3.0 on, since an older agent refuses a field it does not know.
     */
    signed?: {
      /**
       * Base64 of the document's exact bytes (at most 32 KB).
       */
      document: string;
      signature: ApprovedListSignature;
    };
  };
  /**
   * Server-directed pacing. The server raises these under load or for cabinets on poor links; the agent clamps them to the given ranges and uses its defaults when absent.
   */
  intervals?: {
    /**
     * Seconds between heartbeats (presence also comes from the long poll).
     */
    heartbeatSeconds?: number;
    /**
     * How long a long poll is held.
     */
    pollSeconds?: number;
    /**
     * Pause between event batches while draining a backlog.
     */
    eventsPaceMs?: number;
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
  /**
   * Which Windows the installed agent programs are built for, so an update is offered for the same one and never for the other. Absent from agents built before the second architecture, which are all win-x64.
   */
  architecture?: "windows-x64" | "windows-x86";
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
  /**
   * A small sample of how loaded the cabinet is, for trends: processor use since the last heartbeat, memory in use, and free space on the system drive. Absent until the agent has two readings to compare, and from older agents.
   */
  health?: {
    cpuPercent: number;
    memoryUsedPercent: number;
    diskFreePercent: number;
    /**
     * Each physical drive's own health report, sent once after the agent's daily drive check (not with every heartbeat), so the server can keep a history and see a drive getting worse before it fails. The same fields as the disk.smart read.
     *
     * @maxItems 32
     */
    drives?: DriveHealthReport[];
  };
  /**
   * Present, and true, only when this agent was built to accept agent upgrades whose programs are not code-signed (a development build with no code-signing publisher compiled in). The console marks such a cabinet: whoever holds the release key alone decides what it runs. Absent from every production build.
   */
  unsignedUpgrades?: true;
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
  drives: DriveHealthReport[];
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
    /**
     * Optional: what the adapter's DHCP lease, size limits and traffic counters say. A reading that failed is null. Newer agents also send the interface metric, admin status, driver, NetBIOS setting and the Windows network profile; each is optional and null when it could not be read.
     */
    details?: {
      dhcpServer: string | null;
      leaseObtained: string | null;
      leaseExpires: string | null;
      mtu: number | null;
      statistics: {
        bytesReceived: number;
        bytesSent: number;
        receiveErrors: number;
        sendErrors: number;
        receiveDiscards: number;
        sendDiscards: number;
      } | null;
      interfaceMetric?: number | null;
      adminStatus?: ("up" | "down" | "testing") | null;
      driver?: {
        provider: string | null;
        version: string | null;
        date: string | null;
      } | null;
      netbios?: ("default" | "enabled" | "disabled") | null;
      networkProfile?: {
        name: string | null;
        category: "public" | "private" | "domain";
      } | null;
      wifi?: {
        ssid: string | null;
        signalDbm: number | null;
      } | null;
    };
  }[];
  /**
   * Optional: the cabinet's IPv4 routes other than loopback, multicast and host routes (at most 128).
   *
   * @maxItems 128
   */
  routes?: {
    destination: string;
    prefixLength: number;
    nextHop: string;
    metric: number;
    /**
     * Windows network interface index.
     */
    interfaceIndex: number;
  }[];
  /**
   * Optional: the cabinet's ARP table, the other machines it has talked to on its networks lately (at most 64).
   *
   * @maxItems 64
   */
  neighbors?: {
    /**
     * Windows network interface index.
     */
    interfaceIndex: number;
    address: string;
    macAddress: string | null;
    state: "reachable" | "stale" | "incomplete" | "unreachable" | "other";
  }[];
  proxy?: {
    winHttp: string | null;
    userProxyEnabled: boolean | null;
    userProxyServer: string | null;
  } | null;
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
  /**
   * Ping or TCP only: how many attempts to make, 1 to 20 for ping and 1 to 10 for TCP (default 1). With more than one, the output carries loss and jitter (for TCP, how many connections were made and how long each took).
   */
  count?: number;
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
  /**
   * Optional: ping only, when more than one request was sent.
   */
  statistics?: null | {
    sent: number;
    received: number;
    lossPercent: number;
    minMs: number | null;
    avgMs: number | null;
    maxMs: number | null;
    jitterMs: number | null;
  };
}

export interface NetworkTraceParams {
  target: "gateway" | "dns_server" | "sync_cabinet" | "platform_server";
  dnsServerIndex?: number;
  /**
   * The site's sync cabinet as set in the console; accepted only if it is a private IPv4 address on one of the cabinet's own connected networks.
   */
  syncAddress?: string;
  /**
   * How far to go before giving up (default 12).
   */
  maxHops?: number;
}

export interface NetworkTraceOutput {
  target: "gateway" | "dns_server" | "sync_cabinet" | "platform_server";
  resolvedTarget: string | null;
  reached: boolean;
  /**
   * @maxItems 20
   */
  hops: {
    hop: number;
    address: string | null;
    /**
     * One entry per probe; null for a probe that got no reply.
     *
     * @minItems 1
     * @maxItems 3
     */
    rttMs: [number | null, ...(number | null)[]];
  }[];
  error: string | null;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface SystemPerformanceParams {}

export interface SystemPerformanceOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  cpu: {
    usedPercent: number;
    logicalProcessors: number;
    queueLength: number | null;
  };
  memory: {
    totalBytes: number;
    availableBytes: number;
    committedBytes: number | null;
    commitLimitBytes: number | null;
    pagesPerSecond: number | null;
  };
  /**
   * @maxItems 32
   */
  volumes: {
    drive: string;
    label: string | null;
    fileSystem: string | null;
    sizeBytes: number;
    freeBytes: number;
  }[];
  /**
   * @maxItems 32
   */
  physicalDisks: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    busyPercent: number;
    queueLength: number;
    readsPerSecond: number;
    writesPerSecond: number;
  }[];
  /**
   * @maxItems 8
   */
  byCpu: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    id: number;
    cpuPercent: number;
    workingSetBytes: number;
  }[];
  /**
   * @maxItems 8
   */
  byMemory: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    id: number;
    cpuPercent: number;
    workingSetBytes: number;
  }[];
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface NetworkListenersParams {}

export interface NetworkListenersOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 300
   */
  listeners: {
    protocol: "tcp";
    /**
     * A single line of text with no control characters.
     */
    address: string;
    port: number;
    processId: number | null;
    process: string | null;
  }[];
  /**
   * @maxItems 100
   */
  established: {
    /**
     * A single line of text with no control characters.
     */
    remoteAddress: string;
    remotePort: number;
    processId: number | null;
    process: string | null;
  }[];
  counts: {
    established: number;
    timeWait: number;
    listening: number;
  };
  truncated: boolean;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface UsbPortsParams {}

export interface UsbPortsOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 500
   */
  devices: {
    instanceId: string;
    /**
     * A single line of text with no control characters.
     */
    name: string;
    kind: "hub" | "device";
    location: string | null;
    hubNumber: number | null;
    portNumber: number | null;
    present: boolean;
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
  }[];
  truncated: boolean;
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

export interface UpdatesUninstallParams {
  kb: string;
}

export interface UpdatesUninstallOutput {
  kb: string;
  removed: boolean;
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

export interface ServiceSetStartTypeParams {
  /**
   * A Windows service's key name (not its display name). Letters, digits, _ . $ - and inner spaces; SQL Server's MSSQL$NAME form included.
   */
  name: string;
  startType: "automatic" | "automatic_delayed" | "manual" | "disabled";
}

export interface ServiceSetStartTypeOutput {
  /**
   * A Windows service's key name (not its display name). Letters, digits, _ . $ - and inner spaces; SQL Server's MSSQL$NAME form included.
   */
  name: string;
  before: "automatic" | "automatic_delayed" | "manual" | "disabled" | "boot" | "system" | "unknown";
  after: "automatic" | "automatic_delayed" | "manual" | "disabled" | "boot" | "system" | "unknown";
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

export interface NetworkRenewLeaseParams {
  /**
   * Windows network interface index.
   */
  interfaceIndex: number;
  /**
   * Give the current lease back first, then ask for a new one (like ipconfig /release then /renew). Without it the cabinet asks to renew the lease it has.
   */
  release?: boolean;
}

export interface NetworkRenewLeaseOutput {
  /**
   * Windows network interface index.
   */
  interfaceIndex: number;
  /**
   * renewed: the DHCP server answered and the adapter has a lease; failed: it asked and no lease came back; not_dhcp: the adapter has a fixed address, so nothing was asked.
   */
  result: "renewed" | "failed" | "not_dhcp";
  /**
   * A single line of text with no control characters.
   */
  message: string;
  addressBefore: string | null;
  addressAfter: string | null;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface NetworkFlushDnsParams {}

export interface NetworkFlushDnsOutput {
  flushed: boolean;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface SystemSecurityParams {}

export interface SystemSecurityOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  pendingReboot: {
    pending: boolean;
    /**
     * @maxItems 8
     */
    reasons: string[];
  };
  defender: {
    enabled: boolean;
    realTimeProtection: boolean;
    signatureAgeDays: number | null;
    lastQuickScan: string | null;
    lastFullScan: string | null;
    /**
     * @maxItems 20
     */
    threats: {
      /**
       * A single line of text with no control characters.
       */
      name: string;
      detectedAt: string | null;
      active: boolean;
    }[];
  } | null;
  /**
   * @maxItems 26
   */
  bitlocker: {
    /**
     * A single line of text with no control characters.
     */
    volume: string;
    protection: "on" | "off" | "unknown";
    percentEncrypted: number | null;
  }[];
  activation: {
    licensed: boolean;
    /**
     * A single line of text with no control characters.
     */
    status: string;
    edition: string | null;
  } | null;
  /**
   * @maxItems 50
   */
  certificates: {
    /**
     * A single line of text with no control characters.
     */
    store: string;
    /**
     * A single line of text with no control characters.
     */
    subject: string;
    /**
     * UTC time, ISO 8601, always ending in Z.
     */
    notAfter: string;
    daysLeft: number;
    expired: boolean;
  }[];
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface SoftwareListParams {}

export interface SoftwareListOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 1500
   */
  programs: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    version: string | null;
    publisher: string | null;
    installedOn: string | null;
  }[];
  /**
   * @maxItems 500
   */
  hotfixes: {
    /**
     * A single line of text with no control characters.
     */
    id: string;
    description: string | null;
    installedOn: string | null;
  }[];
  truncated: boolean;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface StartupListParams {}

export interface StartupListOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 300
   */
  startup: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    /**
     * A single line of text with no control characters.
     */
    command: string;
    /**
     * A single line of text with no control characters.
     */
    location: string;
  }[];
  /**
   * @maxItems 500
   */
  tasks: {
    /**
     * A single line of text with no control characters.
     */
    path: string;
    /**
     * A single line of text with no control characters.
     */
    name: string;
    state: "ready" | "running" | "disabled" | "queued" | "unknown";
    lastRun: string | null;
    lastResult: number | null;
    nextRun: string | null;
  }[];
  truncated: boolean;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface SessionsListParams {}

export interface SessionsListOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 50
   */
  sessions: {
    id: number;
    /**
     * A single line of text with no control characters.
     */
    user: string;
    state: "active" | "connected" | "disconnected" | "idle" | "other";
    type: "console" | "remote";
    logonTime: string | null;
  }[];
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface SharesListParams {}

export interface SharesListOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 200
   */
  shares: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    path: string | null;
    description: string | null;
    kind: "disk" | "print" | "ipc" | "admin" | "other";
  }[];
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface ReliabilityListParams {}

export interface ReliabilityListOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 300
   */
  records: {
    /**
     * UTC time, ISO 8601, always ending in Z.
     */
    at: string;
    /**
     * A single line of text with no control characters.
     */
    source: string;
    product: string | null;
    eventId: number | null;
    kind: "app_crash" | "app_hang" | "windows_failure" | "update_failure" | "other";
    /**
     * A single line of text with no control characters.
     */
    message: string;
  }[];
  truncated: boolean;
}

export interface DiskFoldersParams {
  /**
   * Absolute path on C:. No relative segments, alternate streams, UNC or device paths.
   */
  path: string;
}

export interface DiskFoldersOutput {
  /**
   * A single line of text with no control characters.
   */
  path: string;
  /**
   * @maxItems 25
   */
  folders: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    sizeBytes: number;
    files: number;
  }[];
  totalBytes: number;
  partial: boolean;
  elapsedMs: number;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface DnsCacheParams {}

export interface DnsCacheOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 500
   */
  entries: {
    /**
     * A single line of text with no control characters.
     */
    name: string;
    /**
     * A single line of text with no control characters.
     */
    type: string;
    /**
     * A single line of text with no control characters.
     */
    data: string;
    ttlSeconds: number;
  }[];
  truncated: boolean;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface PowerStatusParams {}

export interface PowerStatusOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * A single line of text with no control characters.
   */
  plan: string;
  fastStartup: boolean | null;
  hibernate: boolean | null;
  usbSelectiveSuspend: {
    pluggedIn: boolean | null;
    onBattery: boolean | null;
  } | null;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface SystemHardwareParams {}

export interface SystemHardwareOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  manufacturer: string | null;
  model: string | null;
  bios: {
    vendor: string | null;
    version: string | null;
    date: string | null;
  };
  cpu: {
    model: string | null;
    logicalCores: number | null;
  };
  memory: {
    totalBytes: number | null;
    moduleCount: number | null;
    /**
     * @maxItems 32
     */
    modules: {
      slot: string | null;
      capacityBytes: number | null;
      speedMhz: number | null;
    }[];
  };
  tpm: {
    present: boolean;
    enabled: boolean | null;
    version: string | null;
  } | null;
  secureBoot: ("on" | "off" | "unsupported") | null;
  lastBoot: string | null;
  /**
   * @maxItems 16
   */
  monitors: {
    name: string | null;
    width: number | null;
    height: number | null;
  }[];
  /**
   * @maxItems 32
   */
  ports: {
    /**
     * A single line of text with no control characters.
     */
    port: string;
    deviceName: string | null;
    driverProvider: string | null;
    driverVersion: string | null;
  }[];
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface SystemIdentityParams {}

export interface SystemIdentityOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  joinType: "domain" | "workgroup" | "unknown";
  name: string | null;
  domainControllerFound: boolean | null;
  localAdministrators: {
    /**
     * @maxItems 64
     */
    names: string[];
    truncated: boolean;
  } | null;
  autoLogon: {
    enabled: boolean;
    userName: string | null;
  } | null;
  groupPolicyLastApplied: string | null;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface NetworkHostsParams {}

export interface NetworkHostsOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 500
   */
  entries: {
    /**
     * IPv4 or IPv6 address as reported by Windows (read operations only).
     */
    address: string;
    /**
     * @minItems 1
     * @maxItems 16
     */
    names: [string, ...string[]];
  }[];
  truncated: boolean;
}

export interface ConfigSnapshotParams {
  /**
   * @minItems 1
   * @maxItems 11
   */
  categories?: [
    (
      | "network"
      | "services"
      | "drivers"
      | "updates"
      | "firewall"
      | "time"
      | "devices"
      | "applications"
      | "hosts"
      | "tasks"
      | "system"
    ),
    ...(
      | "network"
      | "services"
      | "drivers"
      | "updates"
      | "firewall"
      | "time"
      | "devices"
      | "applications"
      | "hosts"
      | "tasks"
      | "system"
    )[]
  ];
}

export interface ConfigSnapshotOutput {
  /**
   * UTC time, ISO 8601, always ending in Z.
   */
  takenAt: string;
  /**
   * @maxItems 11
   */
  categories: ConfigSnapshotCategory[];
}

export interface SystemRestartParams {
  mode: "restart" | "shutdown" | "cancel";
  delaySeconds?: number;
  /**
   * Shown on the cabinet's screen: a single line of text with no control characters.
   */
  message?: string;
}

export interface SystemRestartOutput {
  mode: "restart" | "shutdown" | "cancel";
  delaySeconds: number | null;
  scheduledFor: string | null;
}

export interface ProcessEndParams {
  processId: number;
  /**
   * A single line of text with no control characters.
   */
  name: string;
}

export interface ProcessEndOutput {
  processId: number;
  /**
   * A single line of text with no control characters.
   */
  name: string;
  ended: boolean;
}

/**
 * Operations that take no parameters accept only an empty object.
 */
export interface SystemCheckHealthParams {}

export interface SystemCheckHealthOutput {
  state: "healthy" | "repairable" | "corrupt" | "unknown";
  /**
   * A single line of text with no control characters.
   */
  summary: string;
  exitCode: number;
  elapsedMs: number;
}

export interface PowerSetParams {
  setting: "usb_selective_suspend" | "fast_startup";
  enabled: boolean;
}

export interface PowerSetOutput {
  setting: "usb_selective_suspend" | "fast_startup";
  before: boolean | null;
  after: boolean | null;
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
export type OperationName = "system.info" | "eventlog.channels" | "eventlog.query" | "eventlog.get" | "devices.list" | "drivers.list" | "peripheral.status" | "updates.status" | "disk.smart" | "files.list" | "network.config" | "network.test" | "network.trace" | "system.performance" | "network.listeners" | "usb.ports" | "firewall.state" | "services.list" | "processes.list" | "network.setIp" | "network.setDns" | "firewall.setProfile" | "firewall.applyPolicy" | "firewall.setRule" | "firewall.restore" | "package.install" | "updates.uninstall" | "driver.uninstall" | "service.control" | "service.setStartType" | "time.status" | "time.setZone" | "time.sync" | "network.renewLease" | "network.flushDns" | "system.security" | "software.list" | "startup.list" | "sessions.list" | "shares.list" | "reliability.list" | "disk.folders" | "dns.cache" | "power.status" | "system.hardware" | "system.identity" | "network.hosts" | "config.snapshot" | "system.restart" | "process.end" | "system.checkHealth" | "power.set";

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
  "network.trace": { params: NetworkTraceParams; output: NetworkTraceOutput };
  "system.performance": { params: SystemPerformanceParams; output: SystemPerformanceOutput };
  "network.listeners": { params: NetworkListenersParams; output: NetworkListenersOutput };
  "usb.ports": { params: UsbPortsParams; output: UsbPortsOutput };
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
  "updates.uninstall": { params: UpdatesUninstallParams; output: UpdatesUninstallOutput };
  "driver.uninstall": { params: DriverUninstallParams; output: DriverUninstallOutput };
  "service.control": { params: ServiceControlParams; output: ServiceControlOutput };
  "service.setStartType": { params: ServiceSetStartTypeParams; output: ServiceSetStartTypeOutput };
  "time.status": { params: TimeStatusParams; output: TimeStatusOutput };
  "time.setZone": { params: TimeSetZoneParams; output: TimeSetZoneOutput };
  "time.sync": { params: TimeSyncParams; output: TimeSyncOutput };
  "network.renewLease": { params: NetworkRenewLeaseParams; output: NetworkRenewLeaseOutput };
  "network.flushDns": { params: NetworkFlushDnsParams; output: NetworkFlushDnsOutput };
  "system.security": { params: SystemSecurityParams; output: SystemSecurityOutput };
  "software.list": { params: SoftwareListParams; output: SoftwareListOutput };
  "startup.list": { params: StartupListParams; output: StartupListOutput };
  "sessions.list": { params: SessionsListParams; output: SessionsListOutput };
  "shares.list": { params: SharesListParams; output: SharesListOutput };
  "reliability.list": { params: ReliabilityListParams; output: ReliabilityListOutput };
  "disk.folders": { params: DiskFoldersParams; output: DiskFoldersOutput };
  "dns.cache": { params: DnsCacheParams; output: DnsCacheOutput };
  "power.status": { params: PowerStatusParams; output: PowerStatusOutput };
  "system.hardware": { params: SystemHardwareParams; output: SystemHardwareOutput };
  "system.identity": { params: SystemIdentityParams; output: SystemIdentityOutput };
  "network.hosts": { params: NetworkHostsParams; output: NetworkHostsOutput };
  "config.snapshot": { params: ConfigSnapshotParams; output: ConfigSnapshotOutput };
  "system.restart": { params: SystemRestartParams; output: SystemRestartOutput };
  "process.end": { params: ProcessEndParams; output: ProcessEndOutput };
  "system.checkHealth": { params: SystemCheckHealthParams; output: SystemCheckHealthOutput };
  "power.set": { params: PowerSetParams; output: PowerSetOutput };
}
