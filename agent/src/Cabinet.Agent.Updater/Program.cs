using System.Diagnostics;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.ServiceProcess;
using Cabinet.Agent.Core.Upgrades;
using Cabinet.Agent.Windows;

[assembly: SupportedOSPlatform("windows")]

namespace Cabinet.Agent.Updater;

/// <summary>
/// The updater. The broker starts it as SYSTEM, from a copy in the broker's folder, with "run" (install the release
/// the journal records as verified) or "resume" (finish or undo one a restart cut short). It takes no path and no
/// other argument: every location is fixed, and the release it installs is the one the broker already checked in full.
/// It holds a machine-wide mutex while it works, so only one ever runs.
/// </summary>
public static class Program
{
    public static int Main(string[] args)
    {
        Directory.CreateDirectory(AgentPaths.BrokerLogs);
        var log = new FileLog(Path.Combine(AgentPaths.BrokerLogs, "updater.log"));
        if (args is not ["run"] and not ["resume"]) { log.Write("Refusing to start: the updater takes only run or resume."); return 2; }
        using (var identity = WindowsIdentity.GetCurrent())
            if (!identity.IsSystem) { log.Write("Refusing to start: the updater runs only as SYSTEM, started by the broker."); return 5; }

        using var mutex = new Mutex(initiallyOwned: true, UpdaterLauncher.MutexName, out bool mine);
        if (!mine) { log.Write("Another updater is already running."); return 3; }
        try
        {
            var updater = new Core.Upgrades.Updater(
                new UpdaterPaths(AgentPaths.ProgramFolder, AgentPaths.ProgramBackup, AgentPaths.UpgradeFiles, AgentPaths.CheckIn),
                new UpgradeJournalStore(AgentPaths.UpgradeJournal), new ServicePlatform(log.Write), TimeProvider.System, log.Write);
            var result = args[0] == "run" ? updater.Run() : updater.Resume();
            log.Write(result is null ? "Nothing to resume." : $"Upgrade to {result.Version}: {result.Phase}. {result.Message}");
            return 0;
        }
        catch (Exception e)
        {
            log.Write($"The updater stopped: {e.GetType().Name}.");
            return 1;
        }
        finally { mutex.ReleaseMutex(); }
    }
}

/// <summary>Stops and starts the two agent services, waiting until their processes have really exited so their files can be moved.</summary>
public sealed class ServicePlatform(Action<string> log) : IUpdaterPlatform
{
    private const string Broker = ServiceNames.Broker, Network = ServiceNames.Network;
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(60);

    public void StopServices()
    {
        foreach (string name in new[] { Network, Broker })
        {
            using var s = new ServiceController(name);
            if (s.Status is not ServiceControllerStatus.Stopped and not ServiceControllerStatus.StopPending) s.Stop();
            WaitFor(s, ServiceControllerStatus.Stopped);
        }
        foreach (string exe in new[] { "Cabinet.Agent.Network", "Cabinet.Agent.Broker", "cabinet-harness" })
            foreach (Process p in Process.GetProcessesByName(exe))
                using (p)
                {
                    if (!p.WaitForExit(Wait)) throw new InvalidOperationException($"{exe} did not exit.");
                }
        log("Both agent services are stopped.");
    }

    public void StartServices()
    {
        foreach (string name in new[] { Broker, Network })
        {
            using var s = new ServiceController(name);
            s.Refresh();
            if (s.Status is ServiceControllerStatus.Stopped) s.Start();
            WaitFor(s, ServiceControllerStatus.Running);
        }
        log("Both agent services are started.");
    }

    private static void WaitFor(ServiceController s, ServiceControllerStatus status)
    {
        try { s.WaitForStatus(status, Wait); }
        catch (System.ServiceProcess.TimeoutException) { throw new InvalidOperationException($"{s.ServiceName} did not reach {status} within {Wait.TotalSeconds:0} seconds."); }
    }
}
