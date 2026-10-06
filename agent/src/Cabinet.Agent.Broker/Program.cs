using System.Runtime.Versioning;
using System.ServiceProcess;
using Cabinet.Agent.Core;
using Cabinet.Agent.Windows;

[assembly: SupportedOSPlatform("windows")]

namespace Cabinet.Agent.Broker;

/// <summary>
/// The broker (docs/spec/04-agent-spec.md): holds the administrator rights,
/// never touches the network, and answers only typed requests from the
/// network service over the locked pipe. It has no code that opens a socket,
/// and runs no external program.
/// </summary>
public sealed class BrokerService : ServiceBase
{
    private readonly FileLog _log;
    private CancellationTokenSource? _stop;
    private Task? _serving;

    public BrokerService()
    {
        ServiceName = ServiceNames.Broker;
        Directory.CreateDirectory(AgentPaths.Logs);
        _log = new FileLog(Path.Combine(AgentPaths.Logs, "broker.log"));
    }

    protected override void OnStart(string[] args)
    {
        _stop = new CancellationTokenSource();
        var server = new BrokerPipeServer(new BrokerRequestHandler(BrokerReadOperations.Registry()), _log.Write);
        _serving = server.RunAsync(_stop.Token);
        _serving.ContinueWith(t => _log.Write($"The broker pipe stopped ({t.Exception?.InnerException?.GetType().Name ?? "stopped"})."), TaskScheduler.Default);
        _log.Write($"Broker {SystemOperations.AgentVersion} started; pipe admits only NT SERVICE\\{ServiceNames.Network}.");
    }

    protected override void OnStop()
    {
        _stop?.Cancel();
        try { _serving?.Wait(TimeSpan.FromSeconds(10)); } catch (AggregateException) { }
        _log.Write("Broker stopped.");
    }

    public static void Main() => Run(new BrokerService());
}
