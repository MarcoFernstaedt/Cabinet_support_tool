namespace Cabinet.Agent.Contracts;

public sealed record SessionOpenParams(Guid SessionId, string Kind);
public sealed record SessionOpenOutput(Guid SessionId);
public sealed record SessionControl(string Control);
public sealed record SessionDiagnosticFrame(string Data);
