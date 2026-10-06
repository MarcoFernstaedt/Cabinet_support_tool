using System.IO.Pipes;
using System.Runtime.Versioning;
using Cabinet.Agent.Core;

namespace Cabinet.Agent.Windows;

/// <summary>
/// For the local test harness and the Windows tests only: runs the broker's
/// request handler inside the same process, over a private one-use pipe, so
/// the full request and response checks still run. Needs the caller to be an
/// administrator for the reads that require it. The services never use this.
/// </summary>
[SupportedOSPlatform("windows")]
public static class InProcessBroker
{
    public static BrokerClient Client(BrokerRequestHandler handler) => new(async token =>
    {
        string name = "Mashura.CabinetAgent.Harness." + Guid.NewGuid().ToString("N");
        var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        _ = Task.Run(async () =>
        {
            await using (server)
            {
                await server.WaitForConnectionAsync(token).ConfigureAwait(false);
                byte[]? request = await BrokerFraming.ReadAsync(server, BrokerFraming.MaxRequestBytes, token).ConfigureAwait(false);
                if (request is not null && await handler.HandleAsync(request, token).ConfigureAwait(false) is { } reply)
                    await BrokerFraming.WriteAsync(server, reply, token).ConfigureAwait(false);
                server.WaitForPipeDrain();
            }
        }, token);
        var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await client.ConnectAsync(5000, token).ConfigureAwait(false);
        return client;
    });
}

/// <summary>
/// A plain, size-capped text log under the agent's data folder. Callers log
/// facts the agent produced (command IDs, operation names, outcomes), never
/// parameters, outputs or exception text that could carry user data.
/// </summary>
public sealed class FileLog(string path)
{
    private const long MaxBytes = 5 * 1024 * 1024;
    private readonly object _gate = new();

    public void Write(string message)
    {
        lock (_gate)
        {
            try
            {
                var info = new FileInfo(path);
                if (info.Exists && info.Length > MaxBytes) File.Move(path, path + ".1", overwrite: true);
                File.AppendAllText(path, $"{DateTimeOffset.UtcNow:yyyy-MM-dd'T'HH:mm:ss'Z'} {message}{Environment.NewLine}");
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
    }
}

/// <summary>Where the installed agent keeps its files.</summary>
public static class AgentPaths
{
    public static string DataRoot { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Mashura", "CabinetAgent");
    public static string Config => Path.Combine(DataRoot, "agent-config.json");
    public static string State => Path.Combine(DataRoot, "state");
    public static string Logs => Path.Combine(DataRoot, "logs");
    public static string HarnessInbox => Path.Combine(DataRoot, "harness", "inbox");
    public static string HarnessOutbox => Path.Combine(DataRoot, "harness", "outbox");
    /// <summary>The CA the platform server's certificate must chain to. Installed with the agent; only administrators can change it.</summary>
    public static string PlatformCa => Path.Combine(DataRoot, "platform-ca.pem");
}
