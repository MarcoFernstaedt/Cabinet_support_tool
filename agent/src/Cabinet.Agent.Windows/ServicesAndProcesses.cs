using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.ServiceProcess;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Services;
using Microsoft.Win32.SafeHandles;

namespace Cabinet.Agent.Windows;

/// <summary>
/// Windows services as the broker sees them (docs/spec/12-milestones-8-to-12.md): the list through WMI (Win32_Service),
/// recovery settings through the service manager, and start/stop through ServiceController with bounded waits. Paths
/// are reported without their arguments; no command line is ever read or returned.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsServicePlatform : IServicePlatform
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(30);

    public IReadOnlyList<ServiceInfo> List()
    {
        var rows = Wmi.Query(Wmi.CimV2, "SELECT Name, DisplayName, State, StartMode, DelayedAutoStart, StartName, ProcessId, PathName, Description FROM Win32_Service", 2000);
        var services = new List<ServiceInfo>();
        foreach (var r in rows)
        {
            string? name = r.Text("Name");
            if (!ServiceRules.IsValidName(name)) continue; // a name outside the contract is not reported (and could not be controlled)
            long? pid = r.Long("ProcessId");
            services.Add(new ServiceInfo
            {
                Name = name!, DisplayName = Clean(r.Text("DisplayName") ?? name!, 256)!, State = State(r.Text("State")),
                StartType = StartType(r.Text("StartMode"), r.Bool("DelayedAutoStart") == true), Account = Clean(r.Text("StartName"), 256),
                ProcessId = pid is > 0 ? pid : null, ExecutablePath = ProgramOnly(r.Text("PathName")), Description = Clean(r.Text("Description"), 512),
                Recovery = Recovery(name!),
            });
        }
        return services;
    }

    /// <summary>
    /// The exact key name, or null. ServiceController would also accept a display name and act on whatever service has
    /// it; the agent looks the name up among the key names only, so "Remote Desktop Services" never reaches TermService.
    /// </summary>
    public string? KeyName(string name)
    {
        ServiceController[] all = ServiceController.GetServices();
        try { return all.FirstOrDefault(s => string.Equals(s.ServiceName, name, StringComparison.OrdinalIgnoreCase))?.ServiceName; }
        finally { foreach (var s in all) s.Dispose(); }
    }

    public (ServiceState State, ServiceStartType StartType)? Query(string name)
    {
        if (KeyName(name) is not { } key) return null;
        using var sc = new ServiceController(key);
        try
        {
            return (State(sc.Status), sc.StartType switch
            {
                ServiceStartMode.Automatic => ServiceStartType.Automatic, ServiceStartMode.Manual => ServiceStartType.Manual, ServiceStartMode.Disabled => ServiceStartType.Disabled,
                ServiceStartMode.Boot => ServiceStartType.Boot, ServiceStartMode.System => ServiceStartType.System, _ => ServiceStartType.Unknown,
            });
        }
        catch (InvalidOperationException) { return null; } // no such service
    }

    /// <summary>sc.exe config, by full path with an argument array: the service's key name was checked against the live list first, and the start value is one of four fixed words.</summary>
    public void SetStartType(string name, ServiceStartType startType)
    {
        if (KeyName(name) is not { } key) throw new ServiceControlException(1060, "No service has that key name.");
        string word = startType switch
        {
            ServiceStartType.Automatic => "auto", ServiceStartType.AutomaticDelayed => "delayed-auto", ServiceStartType.Manual => "demand", ServiceStartType.Disabled => "disabled",
            _ => throw new ServiceControlException(87, "Not a start type the agent sets."),
        };
        var r = ExternalProgram.Run("sc.exe", ["config", key, "start=", word], TimeSpan.FromSeconds(30));
        if (r.ExitCode != 0) throw new ServiceControlException(r.ExitCode, "Windows refused.");
    }

    public void Start(string name) => Control(name, sc => { sc.Start(); sc.WaitForStatus(ServiceControllerStatus.Running, Wait); });

    public void Stop(string name) => Control(name, sc =>
    {
        if (sc.Status is ServiceControllerStatus.Stopped) return;
        sc.Stop();
        sc.WaitForStatus(ServiceControllerStatus.Stopped, Wait);
    });

    private void Control(string name, Action<ServiceController> act)
    {
        if (KeyName(name) is not { } key) throw new ServiceControlException(1060, "No service has that key name.");
        using var sc = new ServiceController(key);
        try { act(sc); }
        catch (System.ServiceProcess.TimeoutException) { throw new ServiceControlException(1053, "The service did not respond in time."); }
        catch (InvalidOperationException e) when (e.InnerException is Win32Exception w) { throw new ServiceControlException(w.NativeErrorCode, "Windows refused."); }
        catch (InvalidOperationException) { throw new ServiceControlException(1060, "No such service."); }
    }

    private static ServiceState State(ServiceControllerStatus s) => s switch
    {
        ServiceControllerStatus.Running => ServiceState.Running, ServiceControllerStatus.Stopped => ServiceState.Stopped,
        ServiceControllerStatus.StartPending => ServiceState.StartPending, ServiceControllerStatus.StopPending => ServiceState.StopPending,
        ServiceControllerStatus.Paused => ServiceState.Paused, ServiceControllerStatus.PausePending => ServiceState.PausePending,
        ServiceControllerStatus.ContinuePending => ServiceState.ContinuePending, _ => ServiceState.Unknown,
    };

    private static ServiceState State(string? wmi) => wmi switch
    {
        "Running" => ServiceState.Running, "Stopped" => ServiceState.Stopped, "Start Pending" => ServiceState.StartPending, "Stop Pending" => ServiceState.StopPending,
        "Paused" => ServiceState.Paused, "Pause Pending" => ServiceState.PausePending, "Continue Pending" => ServiceState.ContinuePending, _ => ServiceState.Unknown,
    };

    private static ServiceStartType StartType(string? mode, bool delayed) => mode switch
    {
        "Auto" => delayed ? ServiceStartType.AutomaticDelayed : ServiceStartType.Automatic, "Manual" => ServiceStartType.Manual, "Disabled" => ServiceStartType.Disabled,
        "Boot" => ServiceStartType.Boot, "System" => ServiceStartType.System, _ => ServiceStartType.Unknown,
    };

    /// <summary>The program of a service's image path, without arguments (ServiceRules.ProgramOnly, tested in Core).</summary>
    public static string? ProgramOnly(string? path) => ServiceRules.ProgramOnly(path);

    private static string? Clean(string? text, int max)
    {
        if (text is null) return null;
        var chars = text.Where(c => c >= ' ' && c != '\u007f').ToArray();
        string s = new string(chars).Trim();
        return s.Length == 0 ? null : s.Length <= max ? s : s[..max];
    }

    // ---- Recovery settings, read through the service manager -----------------------------------

    private const uint ScManagerConnect = 0x0001, ServiceQueryConfig = 0x0001, ServiceConfigFailureActions = 2;

    private static ServiceRecovery? Recovery(string name)
    {
        using SafeServiceHandle scm = OpenSCManagerW(null, null, ScManagerConnect);
        if (scm.IsInvalid) return null;
        using SafeServiceHandle svc = OpenServiceW(scm, name, ServiceQueryConfig);
        if (svc.IsInvalid) return null;
        QueryServiceConfig2W(svc, ServiceConfigFailureActions, IntPtr.Zero, 0, out uint needed);
        if (needed == 0 || needed > 64 * 1024) return null;
        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!QueryServiceConfig2W(svc, ServiceConfigFailureActions, buffer, needed, out _)) return null;
            var fa = Marshal.PtrToStructure<ServiceFailureActions>(buffer);
            var actions = new RecoveryAction[3];
            for (int i = 0; i < 3; i++)
            {
                int index = (int)Math.Min(i, Math.Max(0, (int)fa.cActions - 1));
                actions[i] = fa.cActions == 0 || fa.lpsaActions == IntPtr.Zero ? RecoveryAction.None
                    : Action(Marshal.PtrToStructure<ScAction>(fa.lpsaActions + index * Marshal.SizeOf<ScAction>()).Type);
            }
            return new ServiceRecovery { FirstFailure = actions[0], SecondFailure = actions[1], SubsequentFailures = actions[2], ResetPeriodSeconds = fa.dwResetPeriod == uint.MaxValue ? 0 : fa.dwResetPeriod };
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static RecoveryAction Action(uint type) => type switch { 1 => RecoveryAction.Restart, 2 => RecoveryAction.Reboot, 3 => RecoveryAction.RunProgram, _ => RecoveryAction.None };

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceFailureActions { public uint dwResetPeriod; public IntPtr lpRebootMsg; public IntPtr lpCommand; public uint cActions; public IntPtr lpsaActions; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ScAction { public uint Type; public uint Delay; }

    private sealed class SafeServiceHandle() : SafeHandleZeroOrMinusOneIsInvalid(true)
    {
        protected override bool ReleaseHandle() => CloseServiceHandle(handle);
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern SafeServiceHandle OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern SafeServiceHandle OpenServiceW(SafeServiceHandle scm, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryServiceConfig2W(SafeServiceHandle service, uint level, IntPtr buffer, uint size, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)][return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseServiceHandle(IntPtr handle);
}

/// <summary>
/// processes.list: every process, as Task Manager shows it, with CPU measured over one second. Paths come from
/// QueryFullProcessImageName (no command line is read); the owner from the process token. Runs in the broker, which
/// can see every account's processes.
/// </summary>
[SupportedOSPlatform("windows")]
public static class WindowsProcesses
{
    public const int Max = 2000;
    public static readonly TimeSpan Sample = TimeSpan.FromSeconds(1);

    public static OperationRegistry Register(OperationRegistry registry) =>
        registry.Register<EmptyParams, ProcessesListOutput>(Catalog.ProcessesList, async (_, token) => await ListAsync(token).ConfigureAwait(false));

    public static async Task<ProcessesListOutput> ListAsync(CancellationToken token)
    {
        Process[] first = Process.GetProcesses();
        var before = new Dictionary<int, TimeSpan>();
        foreach (var p in first) { try { before[p.Id] = p.TotalProcessorTime; } catch (Exception e) when (e is Win32Exception or InvalidOperationException or NotSupportedException) { } }
        var watch = Stopwatch.StartNew();
        await Task.Delay(Sample, token).ConfigureAwait(false);
        double elapsed = watch.Elapsed.TotalMilliseconds;
        int cores = Environment.ProcessorCount;
        var list = new List<ProcessInfo>();
        foreach (var p in first.OrderBy(p => p.Id))
        {
            using (p)
            {
                if (list.Count >= Max) continue;
                try
                {
                    p.Refresh();
                    double cpu = 0;
                    try { if (before.TryGetValue(p.Id, out var t0)) cpu = Math.Clamp((p.TotalProcessorTime - t0).TotalMilliseconds / (elapsed * cores) * 100, 0, 100); }
                    catch (Exception e) when (e is Win32Exception or InvalidOperationException or NotSupportedException) { }
                    (string? path, string? account) = Details(p.Id);
                    DateTimeOffset? started = null;
                    try { started = new DateTimeOffset(p.StartTime.ToUniversalTime(), TimeSpan.Zero); } catch (Exception e) when (e is Win32Exception or InvalidOperationException or NotSupportedException) { }
                    string name = path is not null ? Path.GetFileName(path) : p.ProcessName;
                    list.Add(new ProcessInfo
                    {
                        ProcessId = p.Id, Name = Short(name), ExecutablePath = path, CpuPercent = Math.Round(cpu, 1),
                        WorkingSetBytes = Math.Max(0, p.WorkingSet64), PrivateBytes = Math.Max(0, p.PrivateMemorySize64), Threads = p.Threads.Count, Handles = Math.Max(0, p.HandleCount),
                        StartTime = started, SessionId = Math.Max(0, p.SessionId), Account = account,
                    });
                }
                catch (InvalidOperationException) { } // exited during the sample
            }
        }
        return new ProcessesListOutput { Processes = list.OrderByDescending(x => x.CpuPercent).ThenByDescending(x => x.WorkingSetBytes).ToList(), SampleMilliseconds = (long)elapsed, Truncated = first.Length > Max };
    }

    private static string Short(string s) { s = new string(s.Where(c => c >= ' ' && c != '\u007f').ToArray()); return s.Length <= 256 ? s : s[..256]; }

    private static (string? Path, string? Account) Details(int pid)
    {
        using SafeProcessHandle h = NativeMethods.OpenProcess(NativeMethods.ProcessQueryLimitedInformation, false, (uint)pid);
        if (h.IsInvalid) return (null, null);
        string? path = null;
        var buffer = new char[1024];
        uint size = (uint)buffer.Length;
        if (QueryFullProcessImageNameW(h, 0, buffer, ref size) && size is > 0 and <= 520) path = new string(buffer, 0, (int)size);
        string? account = null;
        if (NativeMethods.OpenProcessToken(h, NativeMethods.TokenQuery, out SafeAccessTokenHandle token))
            using (token)
            {
                try { using var identity = new WindowsIdentity(token.DangerousGetHandle()); account = identity.Name.Length <= 256 ? identity.Name : null; }
                catch (Exception e) when (e is UnauthorizedAccessException or ArgumentException or SystemException) { }
            }
        return (path, account);
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)][return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, [Out] char[] name, ref uint size);
}
