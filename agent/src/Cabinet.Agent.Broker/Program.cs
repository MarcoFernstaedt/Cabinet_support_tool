using System.Runtime.Versioning;
using System.ServiceProcess;
using System.Security.AccessControl;
using System.Security.Principal;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Packages;
using Cabinet.Agent.Core.Upgrades;
using Cabinet.Agent.Core.Writes;
using Cabinet.Agent.Core.Monitoring;
using Cabinet.Agent.Core.Services;
using Cabinet.Agent.Windows;

[assembly: SupportedOSPlatform("windows")]

namespace Cabinet.Agent.Broker;

/// <summary>
/// The broker (docs/spec/04-agent-spec.md): holds the administrator rights,
/// never touches the network, and answers only typed requests from the
/// network service over the locked pipe. It has no code that opens a socket.
/// It makes the write operations, keeps the safety net and the firewall timers
/// (checked every few seconds and at start-up, so a reboot inside a window still
/// ends in a rollback), starts only pnputil, msiexec and netsh, by full path, and the signed
/// updater, once a release has passed every check.
/// </summary>
public sealed class BrokerService : ServiceBase
{
    private readonly FileLog _log;
    private CancellationTokenSource? _stop;
    private Task? _serving;

    public BrokerService()
    {
        ServiceName = ServiceNames.Broker;
        Directory.CreateDirectory(AgentPaths.BrokerLogs);
        _log = new FileLog(Path.Combine(AgentPaths.BrokerLogs, "broker.log"));
    }

    protected override void OnStart(string[] args)
    {
        _stop = new CancellationTokenSource();
        PrepareFolders();
        TimeProvider clock = TimeProvider.System;
        var safetyNet = new SafetyNet(AgentPaths.SafetyNet, clock);
        var writes = new BrokerWrites(new FirewallCom(), new NetworkControl(), safetyNet, new FirewallStore(AgentPaths.BrokerFirewall), clock, _log.Write);
        var packages = new PackageInstaller(AgentPaths.Downloads, AgentPaths.Staging, TrustList.Compiled, new PackagePlatform(_log.Write), _log.Write);
        // Services (milestone 10): services.list, service.control, processes.list, and the watcher that keeps the watched services running.
        var servicePlatform = new WindowsServicePlatform();
        var serviceWatcher = new ServiceWatcher(servicePlatform, new StateFile<ServiceWatcher.Saved>(AgentPaths.ServiceWatch), clock, _log.Write);
        var serviceControl = new ServiceControl(servicePlatform, _log.Write) { Watcher = serviceWatcher };
        var registry = WindowsProcesses.Register(serviceControl.Register(packages.Register(writes.Register(BrokerReadOperations.Registry()))));
        // Signed upgrades: the broker verifies a downloaded release against the keys compiled into it and starts the updater.
        var authenticode = new WindowsAuthenticode();
        var upgrades = new UpgradeBroker(new ReleaseVerifier(UpgradeTrust.Compiled, authenticode), new UpgradeJournalStore(AgentPaths.UpgradeJournal),
            AgentPaths.Downloads, AgentPaths.UpgradeStaging, SystemOperations.AgentVersion, new UpdaterLauncher(UpgradeTrust.Compiled, authenticode, _log.Write), clock, _log.Write);
        try { upgrades.ResumeIfNeeded(); }
        catch (Exception e) { _log.Write($"Could not resume an unfinished upgrade: {e.GetType().Name}: {OperationRunner.Truncate(e.Message)}"); }
        var server = new BrokerPipeServer(new BrokerRequestHandler(registry, confirm: safetyNet.Confirm, upgrade: upgrades.Start, watcher: serviceWatcher), _log.Write);
        _serving = Task.WhenAll(server.RunAsync(_stop.Token), UpkeepAsync(writes, _stop.Token), WatchAsync(serviceWatcher, _stop.Token));
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

    /// <summary>The service watcher: every 30 seconds, starts any watched service that stopped (docs/spec/12-milestones-8-to-12.md).</summary>
    private async Task WatchAsync(ServiceWatcher watcher, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try { watcher.Tick(); }
            catch (Exception e) { _log.Write($"Service watcher: {e.GetType().Name}."); }
            try { await Task.Delay(ServiceWatcher.CheckEvery, token).ConfigureAwait(false); } catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>
    /// The broker's folders, with their access lists set every start: its state, logs and staging are writable only
    /// by SYSTEM and administrators (the network service may read the broker's folder, not staging), and downloads is
    /// where the network service may write a package or release for the broker to copy out.
    /// Downloads is the one folder a less trusted account can change, so it is never trusted as a path: any link
    /// planted in its place is removed, it is re-created with its access list set at creation (nothing is set through
    /// an existing path), and the broker only ever reads from it.
    /// </summary>
    private void PrepareFolders()
    {
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var network = new NTAccount("NT SERVICE", ServiceNames.Network);
        DirectorySecurity Acl(FileSystemRights? networkRights)
        {
            var acl = new DirectorySecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.SetOwner(admins);
            var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            acl.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            acl.AddAccessRule(new FileSystemAccessRule(admins, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            if (networkRights is { } rights)
                acl.AddAccessRule(new FileSystemAccessRule(network, rights, inherit, PropagationFlags.None, AccessControlType.Allow));
            return acl;
        }
        // The data folder and the broker's own folders: writable only by SYSTEM and administrators (the installer set
        // this), so a path through them cannot be redirected. A link found here is refused rather than followed.
        RefuseLink(AgentPaths.DataRoot);
        void Secure(string path, FileSystemRights? networkRights)
        {
            RefuseLink(path);
            Directory.CreateDirectory(path).SetAccessControl(Acl(networkRights));
        }
        Secure(AgentPaths.Broker, FileSystemRights.ReadAndExecute);
        Secure(AgentPaths.BrokerLogs, FileSystemRights.ReadAndExecute);
        Secure(AgentPaths.BrokerFirewall, FileSystemRights.ReadAndExecute);
        Secure(AgentPaths.Staging, null);

        // Downloads: what it holds is transient, so it is emptied and created again with its access list in one step.
        var downloads = new DirectoryInfo(AgentPaths.Downloads);
        try
        {
            if (downloads.Exists && downloads.Attributes.HasFlag(FileAttributes.ReparsePoint)) downloads.Delete(); // removes the link only
            else if (downloads.Exists) downloads.Delete(recursive: true); // .NET removes links inside without following them
            downloads.Create(Acl(FileSystemRights.Modify));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // The network service may be using it (a broker restart while it downloads); its access list is the one set when it was created.
            _log.Write($"The downloads folder was not re-created ({e.GetType().Name}); keeping it.");
            downloads.Refresh();
            if (downloads.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new InvalidOperationException("The downloads folder is a link; refusing to start.");
        }
    }

    /// <summary>Refuses to start when a folder the broker trusts is a junction or link.</summary>
    private static void RefuseLink(string path)
    {
        var dir = new DirectoryInfo(path);
        if (dir.Exists && dir.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new InvalidOperationException($"{path} is a link, not a folder; refusing to start.");
    }

    protected override void OnStop()
    {
        _stop?.Cancel();
        try { _serving?.Wait(TimeSpan.FromSeconds(10)); } catch (AggregateException) { }
        _log.Write("Broker stopped.");
    }

    public static void Main() => Run(new BrokerService());
}
