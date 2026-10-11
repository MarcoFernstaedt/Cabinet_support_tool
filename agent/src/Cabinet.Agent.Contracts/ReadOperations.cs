using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

// Read operations (docs/spec/04-agent-spec.md). Shapes match
// contracts/schemas/operations/<name>.schema.json exactly.

public sealed record SystemInfoOutput
{
    public required string Hostname { get; init; }
    public required string OsVersion { get; init; }
    public required string OsBuild { get; init; }
    public required long UptimeSeconds { get; init; }
    public required string AgentVersion { get; init; }
    public required bool ReadOnlyMode { get; init; }
    public required CabinetRole? CabinetRole { get; init; }
    public required string? SerialNumber { get; init; }
}

public sealed record ChannelInfo
{
    public required string Log { get; init; }
    public required bool Enabled { get; init; }
    public required bool Available { get; init; }
    public required long? EntryCount { get; init; }
    public required long? SizeBytes { get; init; }
    public required DateTimeOffset? NewestEntryAt { get; init; }
}

public sealed record EventlogChannelsOutput
{
    public required IReadOnlyList<ChannelInfo> Channels { get; init; }
}

public sealed record EventlogQueryParams
{
    public required string Log { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<EventLevel>? Levels { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public DateTimeOffset? From { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public DateTimeOffset? To { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Source { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<int>? EventIds { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public long? BeforeRecordId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? PageSize { get; init; }
}

public sealed record EventSummary
{
    public required long RecordId { get; init; }
    public required DateTimeOffset Time { get; init; }
    public required EventLevel Level { get; init; }
    public required string Source { get; init; }
    public required int EventId { get; init; }
    public required string FirstLine { get; init; }
}

public sealed record EventlogQueryOutput
{
    public required string Log { get; init; }
    public required IReadOnlyList<EventSummary> Entries { get; init; }
    public required long? NextBeforeRecordId { get; init; }
    public required bool Truncated { get; init; }
}

public sealed record EventlogGetParams
{
    public required string Log { get; init; }
    public required long RecordId { get; init; }
}

public sealed record EventDataField
{
    public required string Name { get; init; }
    public required string Value { get; init; }
}

public sealed record EventlogGetOutput
{
    public required string Log { get; init; }
    public required long RecordId { get; init; }
    public required DateTimeOffset Time { get; init; }
    public required EventLevel Level { get; init; }
    public required string Source { get; init; }
    public required int EventId { get; init; }
    public required string? TaskCategory { get; init; }
    public required IReadOnlyList<string> Keywords { get; init; }
    public required string? Opcode { get; init; }
    public required long? ProcessId { get; init; }
    public required long? ThreadId { get; init; }
    public required string? Computer { get; init; }
    public required string Message { get; init; }
    public required IReadOnlyList<EventDataField> EventData { get; init; }
    public required string? DeviceInstanceId { get; init; }
    public required string RawXml { get; init; }
}

public sealed record DevicesListParams
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? ProblemsOnly { get; init; }
}

public sealed record DeviceDriver
{
    public required string Name { get; init; }
    public required string? Version { get; init; }
    public required string? Provider { get; init; }
}

public sealed record DeviceInfo
{
    public required string InstanceId { get; init; }
    public required string? Class { get; init; }
    public required string Name { get; init; }
    public required string Status { get; init; }
    public required long? ErrorCode { get; init; }
    public required string? ErrorText { get; init; }
    public required IReadOnlyList<string> HardwareIds { get; init; }
    public required DeviceDriver? Driver { get; init; }
}

public sealed record DevicesListOutput
{
    public required IReadOnlyList<DeviceInfo> Devices { get; init; }
    public required bool Truncated { get; init; }
}

public sealed record DriverInfo
{
    public required string PublishedName { get; init; }
    public required string? OriginalName { get; init; }
    public required string? Version { get; init; }
    public required DateTimeOffset? Date { get; init; }
    public required string? Provider { get; init; }
    public required string? ClassName { get; init; }
    public required string? Signer { get; init; }
}

public sealed record DriversListOutput
{
    public required IReadOnlyList<DriverInfo> Drivers { get; init; }
    public required bool Truncated { get; init; }
}

public sealed record PeripheralStatusParams
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<string>? HardwareIds { get; init; }
}

public sealed record PeripheralDriver
{
    public required string Name { get; init; }
    public required string? Version { get; init; }
    public required DateTimeOffset? Date { get; init; }
    public required string? Signer { get; init; }
}

public sealed record PeripheralStatusOutput
{
    public required bool Configured { get; init; }
    public required bool Connected { get; init; }
    public required string? Name { get; init; }
    public required string? Status { get; init; }
    public required long? ErrorCode { get; init; }
    public required string? ErrorText { get; init; }
    public required IReadOnlyList<string> HardwareIds { get; init; }
    public required PeripheralDriver? Driver { get; init; }
    public required string? LocationInfo { get; init; }
    public required IReadOnlyList<PeripheralCheck> Checks { get; init; }
    public required IReadOnlyList<PeripheralCandidate> Candidates { get; init; }
}

public enum PeripheralCheckId
{
    DevicePresent, NoDeviceError, DriverInstalled, DriverSigned, UsbPowerSaving, RecentReconnects, UsbControllerErrors, BiometricService,
}

public enum PeripheralCheckOutcome { Pass, Warn, Fail, Unknown }

public sealed record PeripheralCheck
{
    public required PeripheralCheckId Check { get; init; }
    public required PeripheralCheckOutcome Outcome { get; init; }
    public required string Summary { get; init; }
}

public sealed record PeripheralCandidate
{
    public required string InstanceId { get; init; }
    public required string Name { get; init; }
    public required string? Class { get; init; }
    public required bool Connected { get; init; }
    public required string? Status { get; init; }
    public required IReadOnlyList<string> HardwareIds { get; init; }
}

public enum UpdateResult { Succeeded, SucceededWithErrors, Failed, Aborted, InProgress, Unknown }

public sealed record InstalledUpdate
{
    public required string Title { get; init; }
    public required string? Kb { get; init; }
    public required DateTimeOffset? InstalledAt { get; init; }
    public required UpdateResult Result { get; init; }
    public required long? ErrorCode { get; init; }
}

public sealed record PendingUpdate
{
    public required string Title { get; init; }
    public required string? Kb { get; init; }
    public required string? Classification { get; init; }
    public required bool IsSecurity { get; init; }
}

public sealed record UpdatesStatusOutput
{
    public required DateTimeOffset? LastCheckAt { get; init; }
    public required DateTimeOffset? LastInstallAt { get; init; }
    public required UpdateResult? LastInstallResult { get; init; }
    public required IReadOnlyList<InstalledUpdate> Installed { get; init; }
    public required IReadOnlyList<PendingUpdate> Pending { get; init; }
}

public enum DriveHealth { Healthy, Warning, Failing, Unknown }

public sealed record DriveSmart
{
    public required string? Model { get; init; }
    public required string? SerialNumber { get; init; }
    public required DriveHealth Health { get; init; }
    public required bool? PredictFailure { get; init; }
    public required int? TemperatureCelsius { get; init; }
    public required long? PowerOnHours { get; init; }
    public required long? ReallocatedSectors { get; init; }
    public required long? PendingSectors { get; init; }
    public required long? UncorrectableErrors { get; init; }
    public required int? WearPercent { get; init; }
}

public sealed record DiskSmartOutput
{
    public required IReadOnlyList<DriveSmart> Drives { get; init; }
}

public sealed record FilesListParams
{
    public required string Path { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Page { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? PageSize { get; init; }
}

public enum FileEntryType { File, Directory }

public sealed record FileEntry
{
    public required string Name { get; init; }
    public required FileEntryType Type { get; init; }
    public required long? SizeBytes { get; init; }
    public required DateTimeOffset? ModifiedAt { get; init; }
}

public sealed record FilesListOutput
{
    public required string Path { get; init; }
    public required int Page { get; init; }
    public required IReadOnlyList<FileEntry> Entries { get; init; }
    public required bool HasMore { get; init; }
}

public enum AdapterType { Ethernet, Wifi, Other }

public sealed record NetworkAdapter
{
    public required int InterfaceIndex { get; init; }
    public required string Name { get; init; }
    public required string? Description { get; init; }
    public required AdapterType Type { get; init; }
    public required bool Connected { get; init; }
    public required long? LinkSpeedBps { get; init; }
    public required string? MacAddress { get; init; }
    public required Ipv4Settings Ipv4 { get; init; }
    public required IReadOnlyList<string> Ipv6Addresses { get; init; }
    public required DnsSettings Dns { get; init; }
    public required string? DnsSuffix { get; init; }
    /// <summary>The DHCP lease, size limit and traffic counters; absent from older agents, and any reading that failed is null.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public AdapterDetails? Details { get; init; }
}

public sealed record AdapterStatistics
{
    public required long BytesReceived { get; init; }
    public required long BytesSent { get; init; }
    public required long ReceiveErrors { get; init; }
    public required long SendErrors { get; init; }
    public required long ReceiveDiscards { get; init; }
    public required long SendDiscards { get; init; }
}

public sealed record AdapterDetails
{
    public required string? DhcpServer { get; init; }
    public required DateTimeOffset? LeaseObtained { get; init; }
    public required DateTimeOffset? LeaseExpires { get; init; }
    public required int? Mtu { get; init; }
    public required AdapterStatistics? Statistics { get; init; }
}

public sealed record RouteEntry
{
    public required string Destination { get; init; }
    public required int PrefixLength { get; init; }
    public required string NextHop { get; init; }
    public required long Metric { get; init; }
    public required int InterfaceIndex { get; init; }
}

public enum NeighborState { Reachable, Stale, Incomplete, Unreachable, Other }

public sealed record NeighborEntry
{
    public required int InterfaceIndex { get; init; }
    public required string Address { get; init; }
    public required string? MacAddress { get; init; }
    public required NeighborState State { get; init; }
}

public sealed record NetworkConfigOutput
{
    public required IReadOnlyList<NetworkAdapter> Adapters { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<RouteEntry>? Routes { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<NeighborEntry>? Neighbors { get; init; }
}

public enum NetworkTestTarget { Gateway, DnsServer, SyncCabinet, PlatformServer }
public enum NetworkTestMethod { Ping, Dns, Tcp }

public sealed record NetworkTestParams
{
    public required NetworkTestTarget Target { get; init; }
    public required NetworkTestMethod Method { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? DnsServerIndex { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Port { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? SyncAddress { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyList<int>? SyncPorts { get; init; }
    /// <summary>Ping only: how many echo requests to send (1 to 10, default 1).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Count { get; init; }
}

public sealed record PingStatistics
{
    public required int Sent { get; init; }
    public required int Received { get; init; }
    public required double LossPercent { get; init; }
    public required double? MinMs { get; init; }
    public required double? AvgMs { get; init; }
    public required double? MaxMs { get; init; }
    public required double? JitterMs { get; init; }
}

public sealed record NetworkTraceParams
{
    public required NetworkTestTarget Target { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? DnsServerIndex { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? SyncAddress { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? MaxHops { get; init; }
}

public sealed record TraceHop
{
    public required int Hop { get; init; }
    public required string? Address { get; init; }
    public required IReadOnlyList<double?> RttMs { get; init; }
}

public sealed record NetworkTraceOutput
{
    public required NetworkTestTarget Target { get; init; }
    public required string? ResolvedTarget { get; init; }
    public required bool Reached { get; init; }
    public required IReadOnlyList<TraceHop> Hops { get; init; }
    public required string? Error { get; init; }
}

public sealed record NetworkTestOutput
{
    public required NetworkTestTarget Target { get; init; }
    public required NetworkTestMethod Method { get; init; }
    public required string? ResolvedTarget { get; init; }
    public required bool Success { get; init; }
    public required double? LatencyMs { get; init; }
    public required IReadOnlyList<string> ResolvedAddresses { get; init; }
    public required string? Error { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public PingStatistics? Statistics { get; init; }
}

public sealed record FirewallSnapshotInfo
{
    public required Guid SnapshotId { get; init; }
    public required DateTimeOffset TakenAt { get; init; }
    public required Guid? CommandId { get; init; }
}

public sealed record FirewallStateOutput
{
    public required IReadOnlyList<FirewallProfileState> Profiles { get; init; }
    public required IReadOnlyList<ReportedFirewallRule> Rules { get; init; }
    public required bool RulesTruncated { get; init; }
    public required IReadOnlyList<FirewallSnapshotInfo> Snapshots { get; init; }
}
