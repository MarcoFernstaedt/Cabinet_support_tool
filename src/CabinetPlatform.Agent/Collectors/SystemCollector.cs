using CabinetPlatform.Agent.Configuration;
using CabinetPlatform.Agent.Platform;
using CabinetPlatform.Agent.Platform.Wmi;
using CabinetPlatform.Contracts.Telemetry;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Operating system identity, uptime, domain membership, who is signed in, and
/// the installed software inventory.
/// </summary>
public sealed class SystemCollector : ICollector
{
    private readonly IWmiRepository _wmi;
    private readonly InstalledSoftwareReader _software;
    private readonly LogonSessionReader _logons;
    private readonly IClock _clock;
    private readonly CollectionOptions _options;

    public SystemCollector(
        IWmiRepository wmi,
        InstalledSoftwareReader software,
        LogonSessionReader logons,
        IClock clock,
        IOptions<AgentOptions> options)
    {
        _wmi = wmi;
        _software = software;
        _logons = logons;
        _clock = clock;
        _options = options.Value.Collection;
    }

    public string SectionName => CollectorSections.System;

    public Task CollectAsync(CheckInDraft draft, CancellationToken cancellationToken)
    {
        var operatingSystem = _wmi.Query(
                WmiScopes.CimV2,
                "SELECT Caption, Version, BuildNumber, InstallDate, LastBootUpTime, LocalDateTime " +
                "FROM Win32_OperatingSystem")
            .FirstOrDefault();

        var computerSystem = _wmi.Query(
                WmiScopes.CimV2,
                "SELECT Name, Domain, Workgroup, PartOfDomain FROM Win32_ComputerSystem")
            .FirstOrDefault();

        var lastBoot = operatingSystem?.GetDateTime("LastBootUpTime");
        var isDomainJoined = computerSystem?.GetBoolean("PartOfDomain");

        var interactiveUsers = _logons.GetInteractiveUsers();

        draft.System = new SystemInfo
        {
            Hostname = computerSystem?.GetString("Name"),
            OsVersion = operatingSystem?.GetString("Caption") ?? operatingSystem?.GetString("Version"),
            OsBuild = operatingSystem?.GetString("BuildNumber"),
            InstallDateUtc = operatingSystem?.GetDateTime("InstallDate")?.ToUniversalTime(),
            LastBootUtc = lastBoot?.ToUniversalTime(),
            Uptime = lastBoot is null ? null : _clock.UtcNow - lastBoot.Value.ToUniversalTime(),
            TimeZoneId = TimeZoneInfo.Local.Id,
            SystemTimeUtc = _clock.UtcNow,

            // A domain-joined machine reports its domain; a workgroup machine
            // reports the workgroup. Win32_ComputerSystem populates Domain in
            // both cases, so the flag decides which is meaningful.
            DomainOrWorkgroup = isDomainJoined == false
                ? computerSystem?.GetString("Workgroup") ?? computerSystem?.GetString("Domain")
                : computerSystem?.GetString("Domain"),
            IsDomainJoined = isDomainJoined,

            AnyUserLoggedOn = interactiveUsers.Count > 0,
            LoggedOnUserCount = interactiveUsers.Count,

            InstalledSoftware = _software.Read(_options.MaxInstalledSoftware),
        };

        return Task.CompletedTask;
    }
}
