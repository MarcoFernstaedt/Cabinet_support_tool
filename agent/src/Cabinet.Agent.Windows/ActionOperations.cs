using System.Diagnostics;
using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;
using Cabinet.Agent.Core.Writes;

namespace Cabinet.Agent.Windows;

/// <summary>
/// The support actions the broker runs: restart or shut down, end one process, check Windows' component store and change two power
/// settings. Each is one fixed operation: shutdown.exe, dism.exe and powercfg.exe are started by full path with argument arrays,
/// and the process and registry specifics are fixed here.
/// </summary>
[SupportedOSPlatform("windows")]
public static class ActionOperations
{
    public static OperationRegistry Register(OperationRegistry registry) => registry
        .Register<SystemRestartParams, SystemRestartOutput>(Catalog.SystemRestart, (p, _) => Task.FromResult(Restart(p)))
        .Register<ProcessEndParams, ProcessEndOutput>(Catalog.ProcessEnd, (p, _) => Task.FromResult(EndProcess(p)))
        .Register<EmptyParams, SystemCheckHealthOutput>(Catalog.SystemCheckHealth, (_, _) => Task.FromResult(CheckHealth()))
        .Register<PowerSetParams, PowerSetOutput>(Catalog.PowerSet, (p, _) => Task.FromResult(SetPower(p)));

    public static SystemRestartOutput Restart(SystemRestartParams p)
    {
        if (p.Mode == RestartMode.Cancel && (p.DelaySeconds is not null || p.Message is not null))
            throw new OperationFailedException("invalid_params", "Cancelling a restart takes no delay or message.");
        var r = ExternalProgram.Run("shutdown.exe", ActionRules.RestartArguments(p), TimeSpan.FromSeconds(30));
        if (r.ExitCode != 0)
            throw new OperationFailedException("execution_failed", p.Mode == RestartMode.Cancel && r.ExitCode == 1116 ? "No restart or shutdown was waiting." : $"Windows refused (shutdown.exe exit code {r.ExitCode}).");
        long delay = p.DelaySeconds ?? 0;
        return new SystemRestartOutput { Mode = p.Mode, DelaySeconds = p.Mode == RestartMode.Cancel ? null : delay, ScheduledFor = p.Mode == RestartMode.Cancel ? null : DateTimeOffset.UtcNow.AddSeconds(delay) };
    }

    public static ProcessEndOutput EndProcess(ProcessEndParams p)
    {
        if (ActionRules.WhyNotEnd(p.ProcessId, p.Name, Environment.ProcessId) is { } why) throw new OperationFailedException("execution_failed", why);
        Process process;
        try { process = Process.GetProcessById(checked((int)p.ProcessId)); }
        catch (Exception e) when (e is ArgumentException or OverflowException) { throw new OperationFailedException("not_found", "No process has that ID any more."); }
        using (process)
        {
            string actual = ProcessName(process);
            // The ID and the name must both match, so an ID that Windows has reused for another program is never ended.
            if (!SameName(actual, p.Name)) throw new OperationFailedException("not_found", "The process with that ID is not the one that was named.");
            if (ActionRules.WhyNotEnd(p.ProcessId, actual, Environment.ProcessId) is { } why2) throw new OperationFailedException("execution_failed", why2);
            try { process.Kill(entireProcessTree: false); }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException)
            { throw new OperationFailedException("execution_failed", "Windows would not end that process."); }
            return new ProcessEndOutput { ProcessId = p.ProcessId, Name = p.Name, Ended = process.WaitForExit(5000) };
        }
    }

    private static string ProcessName(Process p)
    {
        try { return Path.GetFileName(p.MainModule?.FileName) is { Length: > 0 } f ? f : p.ProcessName; }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException) { return p.ProcessName; }
    }

    private static string Bare(string name) => name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name;
    private static bool SameName(string a, string b) => string.Equals(Bare(a), Bare(b), StringComparison.OrdinalIgnoreCase);

    public static SystemCheckHealthOutput CheckHealth()
    {
        var clock = Stopwatch.StartNew();
        // Reads are given 90 seconds in all; DISM is stopped at 80 so the answer, "not clear", arrives instead of a time-out, and nothing is left running.
        try
        {
            var r = ExternalProgram.Run("dism.exe", ["/Online", "/Cleanup-Image", "/CheckHealth"], TimeSpan.FromSeconds(80));
            var (state, summary) = ActionRules.ReadDism(r.ExitCode, r.Output);
            return new SystemCheckHealthOutput { State = state, Summary = summary, ExitCode = r.ExitCode, ElapsedMs = clock.ElapsedMilliseconds };
        }
        catch (OperationFailedException e) when (e.Code == "timeout")
        {
            return new SystemCheckHealthOutput { State = ComponentStoreState.Unknown, Summary = "DISM did not answer within 80 seconds. Try again when the cabinet is less busy.", ExitCode = -1, ElapsedMs = clock.ElapsedMilliseconds };
        }
    }

    public static PowerSetOutput SetPower(PowerSetParams p)
    {
        if (p.Setting == PowerSetting.FastStartup)
        {
            bool? before = PowerSettings.FastStartup();
            PowerSettings.SetFastStartup(p.Enabled);
            return new PowerSetOutput { Setting = p.Setting, Before = before, After = PowerSettings.FastStartup() };
        }
        UsbSuspendSettings? was = PowerSettings.UsbSuspend();
        PowerSettings.SetUsbSuspend(p.Enabled);
        UsbSuspendSettings? now = PowerSettings.UsbSuspend();
        return new PowerSetOutput { Setting = p.Setting, Before = was?.PluggedIn, After = now?.PluggedIn };
    }
}
