using System.Runtime.Versioning;
using System.Security.Principal;
using System.ServiceProcess;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Windows;

[assembly: SupportedOSPlatform("windows")]

namespace Cabinet.Agent.Network;

/// <summary>
/// The network service. In milestone 1 it loads and checks the local
/// configuration, refuses to run with administrator rights, keeps checking
/// that the broker answers, and (only when localHarness is on) runs command
/// files an administrator drops into its inbox, through the full checks and
/// the real broker pipe. The server connection arrives in milestone 2.
/// </summary>
public sealed class NetworkService : ServiceBase
{
    private readonly FileLog _log;
    private CancellationTokenSource? _stop;
    private Task? _work;

    public NetworkService()
    {
        ServiceName = ServiceNames.Network;
        _log = new FileLog(Path.Combine(AgentPaths.Logs, "network.log"));
    }

    protected override void OnStart(string[] args)
    {
        using (var identity = WindowsIdentity.GetCurrent())
            if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            {
                _log.Write("Refusing to start: the network service must not run with administrator rights.");
                ExitCode = 5;
                throw new InvalidOperationException("The network service must not run as an administrator.");
            }

        AgentConfig config;
        try { config = AgentConfigLoader.Load(AgentPaths.Config); }
        catch (AgentConfigException e)
        {
            _log.Write($"Refusing to start: {e.Message}");
            ExitCode = 1;
            throw;
        }

        _stop = new CancellationTokenSource();
        TimeProvider clock = TimeProvider.System;
        BrokerClient broker = BrokerPipeClient.Create();
        var processor = new CommandProcessor(
            new CommandValidator(config,
                new ReplayStore(Path.Combine(AgentPaths.State, "replay.log"), clock),
                new RateLimiter(Path.Combine(AgentPaths.State, "writes.log"), clock), clock),
            NetworkOperations.Registry(config, broker, clock), clock);
        _work = Task.WhenAll(WatchBrokerAsync(broker, _stop.Token), config.LocalHarness ? InboxAsync(processor, _stop.Token) : Task.CompletedTask);
        _log.Write($"Network service {SystemOperations.AgentVersion} started for cabinet {config.CabinetId}; read-only mode {(config.ReadOnlyMode ? "on" : "off")}; local harness {(config.LocalHarness ? "on" : "off")}.");
    }

    protected override void OnStop()
    {
        _stop?.Cancel();
        try { _work?.Wait(TimeSpan.FromSeconds(10)); } catch (AggregateException) { }
        _log.Write("Network service stopped.");
    }

    private async Task WatchBrokerAsync(BrokerClient broker, CancellationToken token)
    {
        bool? last = null;
        while (!token.IsCancellationRequested)
        {
            bool ok = await broker.PingAsync(token).ConfigureAwait(false);
            if (ok != last) _log.Write(ok ? "The broker answers." : "The broker does not answer.");
            last = ok;
            try { await Task.Delay(TimeSpan.FromSeconds(60), token).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>The local harness inbox: *.json command files, results written to the outbox under the same name.</summary>
    private async Task InboxAsync(CommandProcessor processor, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                foreach (string file in Directory.EnumerateFiles(AgentPaths.HarnessInbox, "*.json").Take(10).ToList())
                {
                    string name = Path.GetFileName(file);
                    byte[] bytes;
                    try
                    {
                        if (new FileInfo(file).Length > CommandFile.MaxBytes) { File.Delete(file); _log.Write($"Harness: {name} is too large and was discarded."); continue; }
                        bytes = await File.ReadAllBytesAsync(file, token).ConfigureAwait(false);
                        File.Delete(file);
                    }
                    catch (IOException) { continue; } // still being written
                    string outPath = Path.Combine(AgentPaths.HarnessOutbox, Path.GetFileNameWithoutExtension(name) + ".result.json");
                    try
                    {
                        var entries = await CommandFile.RunAsync(bytes, processor, token).ConfigureAwait(false);
                        await File.WriteAllBytesAsync(outPath, CommandFile.Write(entries), token).ConfigureAwait(false);
                        foreach (var e in entries)
                            _log.Write(e.Result is { } r ? $"Harness: command {r.CommandId} {r.Status}{(r.Error is null ? "" : " " + r.Error.Code)}." : $"Harness: entry {e.Index} dropped.");
                    }
                    catch (CommandFileException e)
                    {
                        await File.WriteAllTextAsync(outPath, System.Text.Json.JsonSerializer.Serialize(new { error = e.Message }), token).ConfigureAwait(false);
                    }
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                _log.Write($"Harness inbox unavailable ({e.GetType().Name}).");
            }
            try { await Task.Delay(TimeSpan.FromSeconds(3), token).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }

    public static void Main() => Run(new NetworkService());
}
