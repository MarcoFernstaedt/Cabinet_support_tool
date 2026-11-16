namespace Cabinet.Agent.Core.Server;

/// <summary>A locally selected interactive process. No server-supplied executable, arguments or script.</summary>
public interface ISessionTerminal : IDisposable
{
    Stream Input { get; }
    Stream Output { get; }
    bool HasExited { get; }
    /// <summary>Process exit code, or -1 when unavailable. Must never throw.</summary>
    int ExitCode { get; }
    void Terminate();
    void Resize(short columns, short rows);
}
