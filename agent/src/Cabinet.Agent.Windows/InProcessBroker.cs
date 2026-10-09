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
    /// <summary>The network service's log folder (it may write here).</summary>
    public static string Logs => Path.Combine(DataRoot, "logs");
    /// <summary>The broker's and updater's logs: inside the broker's folder, so only SYSTEM and administrators can write them.</summary>
    public static string BrokerLogs => Path.Combine(Broker, "logs");
    public static string HarnessInbox => Path.Combine(DataRoot, "harness", "inbox");
    public static string HarnessOutbox => Path.Combine(DataRoot, "harness", "outbox");
    /// <summary>The CA the platform server's certificate must chain to. Installed with the agent; only administrators can change it.</summary>
    public static string PlatformCa => Path.Combine(DataRoot, "platform-ca.pem");
    /// <summary>The broker's own state: only SYSTEM and administrators can write here; the network service may read.</summary>
    public static string Broker => Path.Combine(DataRoot, "broker");
    /// <summary>Firewall snapshots, timers and the journal of platform changes.</summary>
    public static string BrokerFirewall => Path.Combine(Broker, "firewall");
    /// <summary>Changes waiting for the safety net.</summary>
    public static string SafetyNet => Path.Combine(Broker, "safety-net.json");
    /// <summary>Where packages are checked and installed from: SYSTEM and administrators only, emptied after every install.</summary>
    public static string Staging => Path.Combine(DataRoot, "staging");
    /// <summary>Where the network service downloads a package; the broker copies it out before checking it.</summary>
    public static string Downloads => Path.Combine(DataRoot, "downloads");
    /// <summary>The agent's program folder, one subfolder per program (as the installer and every release lay it out).</summary>
    public static string ProgramFolder { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Mashura", "CabinetAgent");
    /// <summary>The previous version, kept by the updater while a new one proves itself (and until the next upgrade).</summary>
    public static string ProgramBackup { get; } = ProgramFolder + ".previous";
    /// <summary>The broker's copy of a release being checked and installed (inside staging, so only SYSTEM and administrators can write it).</summary>
    public static string UpgradeStaging => Path.Combine(Staging, "upgrade");
    public static string UpgradeFiles => Path.Combine(UpgradeStaging, "files");
    /// <summary>The updater's journal: in the broker's folder, which the network service may only read.</summary>
    public static string UpgradeJournal => Path.Combine(Broker, "upgrade.json");
    /// <summary>The service watcher's list and counts: in the broker's folder, which the network service may only read.</summary>
    public static string ServiceWatch => Path.Combine(Broker, "service-watch.json");
    /// <summary>The updater runs from a copy here, so it can replace the program folder it came from.</summary>
    public static string UpdaterCopy => Path.Combine(Broker, "updater", "Cabinet.Agent.Updater.exe");
    /// <summary>Written by the network service after each heartbeat that reaches the server; read by the updater.</summary>
    public static string CheckIn => Path.Combine(State, "check-in.json");
    public static string UpgradeReported => Path.Combine(State, "upgrade-reported");
}
