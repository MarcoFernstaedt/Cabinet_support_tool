using System.Text.Json.Serialization;

namespace Cabinet.Agent.Contracts;

public sealed record SessionOpenParams(Guid SessionId, string Kind);
public sealed record SessionOpenOutput(Guid SessionId);

// Mirrors the closed envelope alternatives. Null fields are absent on the wire;
// the schema validates which fields each named control/frame requires.
public sealed record SessionControl(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Control = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Kind = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Data = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Columns = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Rows = null);

public sealed record SessionDiagnosticFrame(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Data = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Kind = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Code = null);

public sealed record SshTransportData
{
    public required string Data { get; init; }
}

public sealed record SshTransportClaim
{
    public required Guid? TransportId { get; init; }
}
