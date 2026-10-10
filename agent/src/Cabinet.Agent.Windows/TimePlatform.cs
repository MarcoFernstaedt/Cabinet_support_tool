using System.ServiceProcess;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Clock;
using Microsoft.Win32;

namespace Cabinet.Agent.Windows;

/// <summary>
/// The time zone and clock on a cabinet. tzutil and w32tm are started by full path with fixed argument arrays
/// (ExternalProgram); the zone passed to tzutil has already been checked against the compiled-in list. Windows Time's
/// source is never changed, so Group Policy and the domain stay in charge of it.
/// </summary>
public sealed class WindowsTimePlatform : ITimePlatform
{
    public TimeZoneInfo CurrentZone()
    {
        TimeZoneInfo.ClearCachedData();
        return TimeZoneInfo.Local;
    }

    public DateTimeOffset UtcNow() => DateTimeOffset.UtcNow;

    public TimeServiceState ServiceState()
    {
        try
        {
            using var service = new ServiceController("W32Time");
            return service.Status == ServiceControllerStatus.Running ? TimeServiceState.Running : TimeServiceState.Stopped;
        }
        catch (InvalidOperationException) { return TimeServiceState.NotInstalled; }
        catch (System.ComponentModel.Win32Exception) { return TimeServiceState.Unknown; }
    }

    public string? QueryStatus()
    {
        ExternalProgram.Outcome r = ExternalProgram.Run("w32tm.exe", ["/query", "/status"], TimeSpan.FromSeconds(15));
        return r.ExitCode == 0 ? r.Output : null;
    }

    public bool PolicyManaged()
    {
        using RegistryKey? key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Policies\Microsoft\W32Time\Parameters");
        return key?.GetValue("NtpServer") is not null || key?.GetValue("Type") is not null;
    }

    public int SetZone(string timeZoneId) => ExternalProgram.Run("tzutil.exe", ["/s", timeZoneId], TimeSpan.FromSeconds(30)).ExitCode;

    public int Resync() => ExternalProgram.Run("w32tm.exe", ["/resync"], TimeSpan.FromSeconds(60)).ExitCode;
}
