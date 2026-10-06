using System.Globalization;
using System.Runtime.Versioning;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;
using Microsoft.Win32;

namespace Cabinet.Agent.Windows;

/// <summary>devices.list, drivers.list and peripheral.status, read through WMI and the registry.</summary>
[SupportedOSPlatform("windows")]
public sealed class DeviceOperations
{
    private const int MaxDevices = 5000;
    private readonly AgentConfig _config;
    private readonly BrokerClient? _broker;
    private readonly TimeProvider _clock;

    /// <param name="broker">Used for the Kernel-PnP event count; null leaves the reconnect check unknown.</param>
    public DeviceOperations(AgentConfig config, BrokerClient? broker, TimeProvider clock)
    {
        _config = config;
        _broker = broker;
        _clock = clock;
    }

    internal static List<DeviceFacts> ReadDevices()
    {
        var drivers = Wmi.Query(Wmi.CimV2, "SELECT DeviceID, InfName, DriverName, DriverVersion, DriverDate, DriverProviderName, Signer FROM Win32_PnPSignedDriver")
            .Where(r => r.Text("DeviceID") is not null)
            .GroupBy(r => r.Text("DeviceID")!, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        var devices = new List<DeviceFacts>();
        foreach (var row in Wmi.Query(Wmi.CimV2, "SELECT DeviceID, Name, PNPClass, Status, ConfigManagerErrorCode, HardwareID, Present FROM Win32_PnPEntity", MaxDevices + 1))
        {
            string? id = row.Text("DeviceID");
            if (!ContractValues.Is("deviceInstanceId", id)) continue; // an ID outside the contract's character set is skipped, not sent
            long? problem = row.Long("ConfigManagerErrorCode");
            drivers.TryGetValue(id!, out var d);
            string? inf = d?.Text("InfName") ?? d?.Text("DriverName");
            devices.Add(new DeviceFacts
            {
                InstanceId = id!,
                Name = EventText.ShortText(row.Text("Name") ?? id) is { Length: > 0 } n ? n : "Unnamed device",
                Class = row.Text("PNPClass") is { } c ? EventText.ShortText(c) : null,
                Present = row.Bool("Present") ?? problem != 45,
                Status = row.Text("Status") is { } s ? EventText.ShortText(s) : null,
                ProblemCode = problem,
                HardwareIds = row.Strings("HardwareID").Where(h => ContractValues.Is("hardwareId", h)).Take(32).ToList(),
                Driver = inf is null ? null : new DriverFacts(EventText.ShortText(inf), Short(d!.Text("DriverVersion")), d!.Date("DriverDate"), Short(d!.Text("Signer"))),
            });
        }
        return devices;
    }

    public Task<DevicesListOutput> DevicesListAsync(DevicesListParams p, CancellationToken token)
    {
        var drivers = Wmi.Query(Wmi.CimV2, "SELECT DeviceID, DriverProviderName FROM Win32_PnPSignedDriver")
            .Where(r => r.Text("DeviceID") is not null)
            .GroupBy(r => r.Text("DeviceID")!, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First().Text("DriverProviderName"), StringComparer.OrdinalIgnoreCase);
        var all = ReadDevices();
        var chosen = all.Where(d => p.ProblemsOnly != true || d.ProblemCode is > 0).ToList();
        return Task.FromResult(new DevicesListOutput
        {
            Devices = chosen.Take(MaxDevices).Select(d => new DeviceInfo
            {
                InstanceId = d.InstanceId, Class = d.Class, Name = d.Name,
                Status = d.Present ? d.Status ?? "Unknown" : "Not connected",
                ErrorCode = d.ProblemCode is > 0 and <= uint.MaxValue ? d.ProblemCode : null,
                ErrorText = DeviceProblems.Describe(d.ProblemCode),
                HardwareIds = d.HardwareIds,
                Driver = d.Driver is null ? null : new DeviceDriver
                {
                    Name = d.Driver.Name, Version = d.Driver.Version,
                    Provider = drivers.TryGetValue(d.InstanceId, out string? provider) ? Short(provider) : null,
                },
            }).ToList(),
            Truncated = chosen.Count > MaxDevices,
        });
    }

    public Task<DriversListOutput> DriversListAsync(EmptyParams _, CancellationToken token)
    {
        var rows = Wmi.Query(Wmi.CimV2, "SELECT InfName, DriverVersion, DriverDate, DriverProviderName, DeviceClass, Signer FROM Win32_PnPSignedDriver")
            .Where(r => r.Text("InfName") is not null)
            .GroupBy(r => r.Text("InfName")!, StringComparer.OrdinalIgnoreCase)
            .OrderBy(g => g.Key, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return Task.FromResult(new DriversListOutput
        {
            Drivers = rows.Take(MaxDevices).Select(g =>
            {
                var r = g.First();
                return new DriverInfo
                {
                    PublishedName = EventText.ShortText(g.Key), OriginalName = OriginalInfName(g.Key),
                    Version = Short(r.Text("DriverVersion")), Date = r.Date("DriverDate"), Provider = Short(r.Text("DriverProviderName")),
                    ClassName = Short(r.Text("DeviceClass")), Signer = Short(r.Text("Signer")),
                };
            }).ToList(),
            Truncated = rows.Count > MaxDevices,
        });
    }

    /// <summary>The name a third-party driver package had before Windows renamed it to oemNN.inf, from the driver store.</summary>
    private static string? OriginalInfName(string published)
    {
        if (!published.StartsWith("oem", StringComparison.OrdinalIgnoreCase) || published.Contains('\\')) return null;
        try
        {
            using RegistryKey? key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\DriverDatabase\DriverInfFiles\" + published);
            if (key?.GetValue(null) is string[] { Length: > 0 } stores)
            {
                int cut = stores[0].IndexOf(".inf_", StringComparison.OrdinalIgnoreCase);
                if (cut > 0) return EventText.ShortText(stores[0][..cut] + ".inf");
            }
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { }
        return null;
    }

    /// <summary>
    /// The fingerprint scanner and the automated troubleshooting checklist
    /// (docs/spec/04-agent-spec.md peripheral.status, widened in milestone 1).
    /// </summary>
    public async Task<PeripheralStatusOutput> PeripheralStatusAsync(PeripheralStatusParams p, CancellationToken token)
    {
        var devices = ReadDevices();
        var facts = new ScannerFacts
        {
            ConfiguredHardwareIds = p.HardwareIds ?? _config.Scanner.HardwareIds, Devices = devices, BiometricServiceState = BiometricService(),
        };
        DeviceFacts? scanner = facts.ConfiguredHardwareIds.Count > 0 ? ScannerChecklist.Find(facts) : null;
        if (scanner is not null)
        {
            facts = facts with
            {
                Devices = devices.Select(d => d.InstanceId == scanner.InstanceId ? d with { LocationInfo = DeviceRegistryText(d.InstanceId, "LocationInformation") } : d).ToList(),
                SelectiveSuspendEnabled = SelectiveSuspend(scanner.InstanceId),
                StartsLast24Hours = await StartsLastDayAsync(scanner.InstanceId, token).ConfigureAwait(false),
            };
        }
        return ScannerChecklist.Evaluate(facts);
    }

    private static string? BiometricService()
    {
        try
        {
            var row = Wmi.Query(Wmi.CimV2, "SELECT Name, State FROM Win32_Service WHERE Name = 'WbioSrvc'").FirstOrDefault();
            return row is null ? "absent" : string.Equals(row.Text("State"), "Running", StringComparison.OrdinalIgnoreCase) ? "running" : "stopped";
        }
        catch (Exception e) when (e is System.Management.ManagementException or UnauthorizedAccessException) { return null; }
    }

    private static string? DeviceRegistryText(string instanceId, string value)
    {
        try
        {
            using RegistryKey? key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\" + instanceId);
            return key?.GetValue(value) is string s && s.Length > 0 ? EventText.ShortText(s) : null;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return null; }
    }

    /// <summary>Whether USB power management may suspend the device: true, false, or null when Windows does not say.</summary>
    private static bool? SelectiveSuspend(string instanceId)
    {
        try
        {
            using RegistryKey? key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\" + instanceId + @"\Device Parameters");
            if (key is null) return null;
            bool? seen = null;
            foreach (string name in new[] { "SelectiveSuspendEnabled", "EnhancedPowerManagementEnabled" })
            {
                object? v = key.GetValue(name);
                int? n = v switch { int i => i, byte[] { Length: > 0 } b => b[0], _ => null };
                if (n is null) continue;
                if (n != 0) return true;
                seen = false;
            }
            return seen;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return null; }
    }

    /// <summary>Kernel-PnP event 410 ("device started") for this device in the last day, read through the broker.</summary>
    private async Task<int?> StartsLastDayAsync(string instanceId, CancellationToken token)
    {
        if (_broker is null) return null;
        try
        {
            var p = new EventlogQueryParams
            {
                Log = "Microsoft-Windows-Kernel-PnP/Configuration", EventIds = [410], From = _clock.GetUtcNow().AddDays(-1), PageSize = 500,
            };
            JsonElement output = await _broker.RunAsync(Catalog.EventlogQuery, JsonSerializer.SerializeToElement(p, ContractJson.Options), token).ConfigureAwait(false);
            var result = output.Deserialize<EventlogQueryOutput>(ContractJson.Options)!;
            return result.Entries.Count(e => e.FirstLine.Contains(instanceId, StringComparison.OrdinalIgnoreCase));
        }
        catch (OperationFailedException) { return null; }
    }

    private static string? Short(string? text) => text is null ? null : EventText.ShortText(text) is { Length: > 0 } s ? s : null;
}
