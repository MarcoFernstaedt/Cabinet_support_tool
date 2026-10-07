using System.Runtime.Versioning;
using System.ServiceProcess;
using System.Security.AccessControl;
using System.Security.Principal;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Packages;
using Cabinet.Agent.Core.Writes;
using Cabinet.Agent.Windows;

[assembly: SupportedOSPlatform("windows")]

namespace Cabinet.Agent.Broker;

/// <summary>
/// The broker (docs/spec/04-agent-spec.md): holds the administrator rights,
/// never touches the network, and answers only typed requests from the
/// network service over the locked pipe. It has no code that opens a socket.
/// It makes the write operations, keeps the safety net and the firewall timers
/// (checked every few seconds and at start-up, so a reboot inside a window still
/// ends in a rollback), and starts only pnputil, msiexec and netsh, by full path.
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
        PrepareFolders();
        TimeProvider clock = TimeProvider.System;
        var safetyNet = new SafetyNet(AgentPaths.SafetyNet, clock);
        var writes = new BrokerWrites(new FirewallCom(), new NetworkControl(), safetyNet, new FirewallStore(AgentPaths.BrokerFirewall), clock, _log.Write);
        var packages = new PackageInstaller(AgentPaths.Downloads, AgentPaths.Staging, TrustList.Compiled, new PackagePlatform(_log.Write), _log.Write);
        var registry = packages.Register(writes.Register(BrokerReadOperations.Registry()));
        var server = new BrokerPipeServer(new BrokerRequestHandler(registry, confirm: safetyNet.Confirm), _log.Write);
        _serving = Task.WhenAll(server.RunAsync(_stop.Token), UpkeepAsync(writes, _stop.Token));
        _serving.ContinueWith(t => _log.Write($"The broker pipe stopped ({t.Exception?.InnerException?.GetType().Name ?? "stopped"})."), TaskScheduler.Default);
        _log.Write($"Broker {SystemOperations.AgentVersion} started; pipe admits only NT SERVICE\\{ServiceNames.Network}.");
    }

    /// <summary>Safety-net rollbacks and firewall timers: once at start-up (after a reboot), then every 5 seconds.</summary>
    private async Task UpkeepAsync(BrokerWrites writes, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try { writes.Tick(); }
            catch (Exception e) { _log.Write($"Broker upkeep: {e.GetType().Name}: {OperationRunner.Truncate(e.Message)}"); }
            try { await Task.Delay(TimeSpan.FromSeconds(5), token).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>
    /// The broker's folders, with their access lists set every start: its state and staging are writable only
    /// by SYSTEM and administrators (the network service may read the firewall journal and snapshot list, not
    /// staging), and downloads is where the network service may write a package for the broker to copy out.
    /// </summary>
    private static void PrepareFolders()
    {
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var network = new NTAccount("NT SERVICE", ServiceNames.Network);
        void Secure(string path, FileSystemRights? networkRights)
        {
            var dir = Directory.CreateDirectory(path);
            var acl = new DirectorySecurity();
            acl.SetAccessRuleProtection(true, false);
            var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            acl.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            acl.AddAccessRule(new FileSystemAccessRule(admins, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            if (networkRights is { } rights)
                acl.AddAccessRule(new FileSystemAccessRule(network, rights, inherit, PropagationFlags.None, AccessControlType.Allow));
            dir.SetAccessControl(acl);
        }
        Secure(AgentPaths.Broker, FileSystemRights.ReadAndExecute);
        Secure(AgentPaths.BrokerFirewall, FileSystemRights.ReadAndExecute);
        Secure(AgentPaths.Staging, null);
        Secure(AgentPaths.Downloads, FileSystemRights.Modify);
    }

    protected override void OnStop()
    {
        _stop?.Cancel();
        try { _serving?.Wait(TimeSpan.FromSeconds(10)); } catch (AggregateException) { }
        _log.Write("Broker stopped.");
    }

    public static void Main() => Run(new BrokerService());
}
