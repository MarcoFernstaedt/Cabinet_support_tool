using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// Writes the Windows Update scheduled-install policy.
/// </summary>
/// <remarks>
/// The one registry write the agent performs, and it is confined to the Auto
/// Update policy key that Windows Update reads. Abstracted so the executor's
/// validation can be tested without writing to a real registry.
/// </remarks>
public interface IScheduledUpdateWriter
{
    /// <summary>Schedules detected updates to install at the given UTC instant.</summary>
    void ScheduleInstall(DateTimeOffset scheduledUtc);
}

/// <summary>Registry-backed implementation of <see cref="IScheduledUpdateWriter"/>.</summary>
[SupportedOSPlatform("windows")]
public sealed class ScheduledUpdateWriter : IScheduledUpdateWriter
{
    private const string AutoUpdatePolicyKey = @"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU";

    /// <summary>Auto-download and schedule the install.</summary>
    private const int AutoInstallScheduled = 4;

    /// <summary>Every day, rather than a specific day of the week.</summary>
    private const int ScheduledInstallEveryDay = 0;

    private readonly ILogger<ScheduledUpdateWriter> _logger;

    public ScheduledUpdateWriter(ILogger<ScheduledUpdateWriter> logger) => _logger = logger;

    public void ScheduleInstall(DateTimeOffset scheduledUtc)
    {
        // Windows Update's scheduled-install policy is expressed in the
        // machine's own local time and to the hour. Writing the UTC hour would
        // schedule the install at the wrong time on any cabinet that is not on
        // UTC, which is nearly all of them.
        var localScheduled = scheduledUtc.ToLocalTime();
        var scheduledHour = localScheduled.Hour;

        using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var key = baseKey.CreateSubKey(AutoUpdatePolicyKey, writable: true);

        if (key is null)
        {
            throw new InvalidOperationException(
                $@"The policy key HKLM\{AutoUpdatePolicyKey} could not be opened for writing.");
        }

        key.SetValue("NoAutoUpdate", 0, RegistryValueKind.DWord);
        key.SetValue("AUOptions", AutoInstallScheduled, RegistryValueKind.DWord);
        key.SetValue("ScheduledInstallDay", ScheduledInstallEveryDay, RegistryValueKind.DWord);
        key.SetValue("ScheduledInstallTime", scheduledHour, RegistryValueKind.DWord);

        _logger.LogInformation(
            "Windows Update is set to install at {ScheduledHour:00}:00 local time " +
            "(requested {ScheduledUtc:O}).",
            scheduledHour,
            scheduledUtc);
    }
}
