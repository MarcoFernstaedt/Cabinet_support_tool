using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;
using Microsoft.Win32;

namespace Cabinet.Agent.Windows;

/// <summary>
/// Read-only Windows inventory served by the broker: security state, installed software, startup items, sessions, shares, reliability
/// history, folder sizes, the DNS cache and power settings. Every WQL text is a constant; registry keys are fixed; no command output is parsed
/// except `powercfg /query` for the USB setting, read by exact GUID.
/// </summary>
[SupportedOSPlatform("windows")]
public static class InventoryOperations
{
    private const string Defender = @"root\Microsoft\Windows\Defender";
    private const string BitLocker = @"root\CIMV2\Security\MicrosoftVolumeEncryption";
    private const string TaskScheduler = @"root\Microsoft\Windows\TaskScheduler";
    private const string StandardCim = @"root\StandardCimv2";
    private static readonly string[] UninstallKeys = [@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"];

    public static OperationRegistry Register(OperationRegistry registry) => registry
        .Register<EmptyParams, SystemSecurityOutput>(Catalog.SystemSecurity, (_, t) => Task.FromResult(SystemSecurity()))
        .Register<EmptyParams, SoftwareListOutput>(Catalog.SoftwareList, (_, t) => Task.FromResult(SoftwareList()))
        .Register<EmptyParams, StartupListOutput>(Catalog.StartupList, (_, t) => Task.FromResult(StartupList()))
        .Register<EmptyParams, SessionsListOutput>(Catalog.SessionsList, (_, t) => Task.FromResult(Sessions()))
        .Register<EmptyParams, SharesListOutput>(Catalog.SharesList, (_, t) => Task.FromResult(Shares()))
        .Register<EmptyParams, ReliabilityListOutput>(Catalog.ReliabilityList, (_, t) => Task.FromResult(Reliability()))
        .Register<DiskFoldersParams, DiskFoldersOutput>(Catalog.DiskFolders, (p, t) => Task.FromResult(Folders(p, t)))
        .Register<EmptyParams, DnsCacheOutput>(Catalog.DnsCache, (_, t) => Task.FromResult(DnsCache()))
        .Register<EmptyParams, PowerStatusOutput>(Catalog.PowerStatus, (_, t) => Task.FromResult(Power()))
        .Register<EmptyParams, SystemHardwareOutput>(Catalog.SystemHardware, (_, t) => Task.FromResult(HardwareOperations.Hardware()))
        .Register<EmptyParams, NetworkHostsOutput>(Catalog.NetworkHosts, (_, t) => Task.FromResult(HardwareOperations.Hosts()));

    /// <summary>A query that may not exist on this edition of Windows: nothing comes back instead of an error.</summary>
    private static List<Dictionary<string, object?>> Try(string scope, string wql, int max)
    {
        try { return Wmi.Query(scope, wql, max); }
        catch (Exception e) when (e is System.Management.ManagementException or COMException or UnauthorizedAccessException) { return []; }
    }

    // ---- system.security ----------------------------------------------------------------------------------------------------------

    public static SystemSecurityOutput SystemSecurity()
    {
        var now = DateTimeOffset.UtcNow;
        var reasons = new List<string>();
        using (var cbs = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending")) if (cbs is not null) reasons.Add("Component servicing");
        using (var wu = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired")) if (wu is not null) reasons.Add("Windows Update");
        using (var session = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager"))
            if (session?.GetValue("PendingFileRenameOperations") is string[] { Length: > 0 }) reasons.Add("File replacement at restart");

        DefenderStatus? defender = null;
        var status = Try(Defender, "SELECT AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureLastUpdated, QuickScanEndTime, FullScanEndTime FROM MSFT_MpComputerStatus", 1);
        if (status.Count == 1)
        {
            var s = status[0];
            var threats = Try(Defender, "SELECT ThreatID, ProcessName, InitialDetectionTime, CurrentThreatExecutionStatusID FROM MSFT_MpThreatDetection", 20)
                .Select(t => new DefenderThreat
                {
                    Name = InventoryRules.Clean(t.Text("ProcessName") ?? $"Threat {t.Long("ThreatID")}", 200) ?? "Threat",
                    DetectedAt = t.Date("InitialDetectionTime"),
                    // MSFT_MpThreatDetection: 1 blocked, 2 allowed, 3 executing, 4 not executing. A threat Defender let run, or that is running, is active.
                    Active = t.Long("CurrentThreatExecutionStatusID") is 2 or 3,
                }).ToList();
            defender = new DefenderStatus
            {
                Enabled = s.Bool("AntivirusEnabled") ?? false,
                RealTimeProtection = s.Bool("RealTimeProtectionEnabled") ?? false,
                SignatureAgeDays = InventoryRules.AgeDays(s.Date("AntivirusSignatureLastUpdated"), now),
                LastQuickScan = s.Date("QuickScanEndTime"),
                LastFullScan = s.Date("FullScanEndTime"),
                Threats = threats,
            };
        }

        var volumes = Try(BitLocker, "SELECT DriveLetter, ProtectionStatus FROM Win32_EncryptableVolume", 26)
            .Where(v => v.Text("DriveLetter") is { Length: >= 2 })
            .Select(v => new BitLockerVolume
            {
                Volume = v.Text("DriveLetter")![..2],
                Protection = v.Long("ProtectionStatus") switch { 1 => BitLockerProtection.On, 0 => BitLockerProtection.Off, _ => BitLockerProtection.Unknown },
                PercentEncrypted = null,
            }).ToList();

        ActivationStatus? activation = null;
        var licence = Try(Wmi.CimV2, "SELECT Name, LicenseStatus FROM SoftwareLicensingProduct WHERE PartialProductKey IS NOT NULL AND ApplicationId = '55c92734-d682-4d71-983e-d6ec3f16059f'", 1);
        if (licence.Count == 1)
        {
            long code = licence[0].Long("LicenseStatus") ?? -1;
            activation = new ActivationStatus
            {
                Licensed = code == 1,
                Status = code switch { 0 => "Unlicensed", 1 => "Licensed", 2 => "Initial grace period", 3 => "Additional grace period", 4 => "Non-genuine grace period", 5 => "Notification", 6 => "Extended grace period", _ => "Unknown" },
                Edition = InventoryRules.Clean(licence[0].Text("Name"), 120),
            };
        }

        return new SystemSecurityOutput
        {
            TakenAt = now,
            PendingReboot = new PendingReboot { Pending = reasons.Count > 0, Reasons = reasons },
            Defender = defender,
            Bitlocker = volumes,
            Activation = activation,
            Certificates = Certificates(now),
        };
    }

    /// <summary>Machine certificates that are expired or expire within 90 days; the rest are not worth a row.</summary>
    private static List<CertificateExpiry> Certificates(DateTimeOffset now)
    {
        var found = new List<CertificateExpiry>();
        foreach (var (name, label) in new[] { (StoreName.My, "Personal"), (StoreName.Root, "Trusted roots"), (StoreName.TrustedPublisher, "Trusted publishers") })
        {
            try
            {
                using var store = new X509Store(name, StoreLocation.LocalMachine);
                store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
                foreach (var cert in store.Certificates)
                {
                    using (cert)
                    {
                        var notAfter = new DateTimeOffset(cert.NotAfter.ToUniversalTime(), TimeSpan.Zero);
                        long days = InventoryRules.DaysLeft(notAfter, now);
                        if (days > 90) continue;
                        found.Add(new CertificateExpiry { Store = label, Subject = InventoryRules.Clean(cert.Subject, 300) ?? "(no subject)", NotAfter = notAfter, DaysLeft = days, Expired = days < 0 });
                    }
                }
            }
            catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or UnauthorizedAccessException) { }
        }
        return found.OrderBy(c => c.NotAfter).Take(50).ToList();
    }

    // ---- software.list ------------------------------------------------------------------------------------------------------------

    public static SoftwareListOutput SoftwareList()
    {
        var programs = new Dictionary<string, InstalledProgram>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in UninstallKeys)
        {
            using var root = Registry.LocalMachine.OpenSubKey(path);
            if (root is null) continue;
            foreach (string sub in root.GetSubKeyNames())
            {
                using var key = root.OpenSubKey(sub);
                if (key is null || key.GetValue("SystemComponent") is 1 || key.GetValue("ParentKeyName") is not null) continue;
                if (InventoryRules.Clean(key.GetValue("DisplayName") as string, 200) is not { } name) continue;
                string? version = InventoryRules.Clean(key.GetValue("DisplayVersion") as string, 64);
                programs.TryAdd($"{name}|{version}", new InstalledProgram
                {
                    Name = name,
                    Version = version,
                    Publisher = InventoryRules.Clean(key.GetValue("Publisher") as string, 120),
                    InstalledOn = InventoryRules.CompactDate(key.GetValue("InstallDate") as string),
                });
            }
        }
        var (shownPrograms, cutPrograms) = InventoryRules.Bound(programs.Values.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase), 1500);
        var hotfixRows = Try(Wmi.CimV2, "SELECT HotFixID, Description, InstalledOn FROM Win32_QuickFixEngineering", 600);
        var (hotfixes, cutHotfixes) = InventoryRules.Bound(hotfixRows
            .Where(h => InventoryRules.Clean(h.Text("HotFixID"), 40) is not null)
            .Select(h => new InstalledHotfix { Id = InventoryRules.Clean(h.Text("HotFixID"), 40)!, Description = InventoryRules.Clean(h.Text("Description"), 120), InstalledOn = InventoryRules.Clean(h.Text("InstalledOn"), 40) })
            .OrderByDescending(h => h.Id, StringComparer.Ordinal), 500);
        return new SoftwareListOutput { TakenAt = DateTimeOffset.UtcNow, Programs = shownPrograms, Hotfixes = hotfixes, Truncated = cutPrograms || cutHotfixes };
    }

    // ---- startup.list -------------------------------------------------------------------------------------------------------------

    public static StartupListOutput StartupList()
    {
        var startup = Try(Wmi.CimV2, "SELECT Name, Command, Location FROM Win32_StartupCommand", 400)
            .Select(r => new StartupItem { Name = InventoryRules.Clean(r.Text("Name"), 200) ?? "(unnamed)", Command = InventoryRules.Clean(r.Text("Command"), 500) ?? "", Location = InventoryRules.Clean(r.Text("Location"), 200) ?? "" });
        var (startupItems, cutStartup) = InventoryRules.Bound(startup, 300);
        var tasks = Try(TaskScheduler, "SELECT TaskName, TaskPath, State FROM MSFT_ScheduledTask", 2000)
            .Where(t => !(t.Text("TaskPath") ?? "").StartsWith(@"\Microsoft\", StringComparison.OrdinalIgnoreCase))
            .Select(t => new ScheduledTaskInfo
            {
                Path = InventoryRules.Clean(t.Text("TaskPath"), 256) ?? "\\",
                Name = InventoryRules.Clean(t.Text("TaskName"), 256) ?? "(unnamed)",
                State = InventoryRules.TaskStateFor(t.Long("State")),
                LastRun = null, LastResult = null, NextRun = null,
            });
        var (taskItems, cutTasks) = InventoryRules.Bound(tasks, 500);
        return new StartupListOutput { TakenAt = DateTimeOffset.UtcNow, Startup = startupItems, Tasks = taskItems, Truncated = cutStartup || cutTasks };
    }

    // ---- sessions.list ------------------------------------------------------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    private struct WtsSessionInfo { public int SessionId; [MarshalAs(UnmanagedType.LPStr)] public string WinStationName; public int State; }

    [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr info, out int count);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);

    private static string? SessionString(int session, int infoClass)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, infoClass, out IntPtr buffer, out _)) return null;
        try { return Marshal.PtrToStringUni(buffer); } finally { WTSFreeMemory(buffer); }
    }

    public static SessionsListOutput Sessions()
    {
        var sessions = new List<LogonSession>();
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out IntPtr info, out int count)) return new SessionsListOutput { TakenAt = DateTimeOffset.UtcNow, Sessions = sessions };
        try
        {
            int size = Marshal.SizeOf<WtsSessionInfo>();
            for (int i = 0; i < Math.Min(count, 50); i++)
            {
                var s = Marshal.PtrToStructure<WtsSessionInfo>(info + i * size);
                string? user = SessionString(s.SessionId, 5);   // WTSUserName
                if (string.IsNullOrEmpty(user)) continue;       // the services session and listeners have no user
                string? domain = SessionString(s.SessionId, 7); // WTSDomainName
                sessions.Add(new LogonSession
                {
                    Id = s.SessionId,
                    User = InventoryRules.Clean(string.IsNullOrEmpty(domain) ? user : $"{domain}\\{user}", 120) ?? user,
                    State = InventoryRules.SessionStateFor(s.State),
                    Type = InventoryRules.SessionTypeFor(s.WinStationName ?? ""),
                    LogonTime = null,
                });
            }
        }
        finally { WTSFreeMemory(info); }
        return new SessionsListOutput { TakenAt = DateTimeOffset.UtcNow, Sessions = sessions };
    }

    // ---- shares.list --------------------------------------------------------------------------------------------------------------

    public static SharesListOutput Shares()
    {
        var shares = Try(Wmi.CimV2, "SELECT Name, Path, Description, Type FROM Win32_Share", 200)
            .Select(r =>
            {
                string name = InventoryRules.Clean(r.Text("Name"), 80) ?? "(unnamed)";
                return new ShareInfo { Name = name, Path = InventoryRules.Clean(r.Text("Path"), 260), Description = InventoryRules.Clean(r.Text("Description"), 200), Kind = InventoryRules.ShareKindFor(r.Long("Type"), name) };
            }).Take(100).ToList();
        return new SharesListOutput { TakenAt = DateTimeOffset.UtcNow, Shares = shares };
    }

    // ---- reliability.list ---------------------------------------------------------------------------------------------------------

    public static ReliabilityListOutput Reliability()
    {
        var rows = Try(Wmi.CimV2, "SELECT TimeGenerated, SourceName, ProductName, EventIdentifier, Message FROM Win32_ReliabilityRecords", 2000);
        var records = rows.Where(r => r.Date("TimeGenerated") is not null).Select(r =>
        {
            string source = InventoryRules.Clean(r.Text("SourceName"), 120) ?? "Unknown";
            long? id = r.Long("EventIdentifier");
            return new ReliabilityRecord
            {
                At = r.Date("TimeGenerated")!.Value,
                Source = source,
                Product = InventoryRules.Clean(r.Text("ProductName"), 120),
                EventId = id,
                Kind = InventoryRules.ReliabilityKindFor(source, id),
                Message = EventText.FirstLine(r.Text("Message"), 300),
            };
        }).OrderByDescending(r => r.At);
        var (items, cut) = InventoryRules.Bound(records, 300);
        return new ReliabilityListOutput { TakenAt = DateTimeOffset.UtcNow, Records = items, Truncated = cut };
    }

    // ---- disk.folders -------------------------------------------------------------------------------------------------------------

    private const int FolderBudgetSeconds = 20;

    /// <summary>Sizes the folders directly under a directory on C:, largest first, within a time budget. Links and junctions are never followed.</summary>
    public static DiskFoldersOutput Folders(DiskFoldersParams p, CancellationToken token)
    {
        string path = FilesListing.Canonical(p.Path) ?? throw new OperationFailedException("not_found", "That path names a device or is not a plain directory path.");
        foreach (string directory in FilesListing.SelfAndAncestors(path))
        {
            FileAttributes a;
            try { a = File.GetAttributes(directory); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { throw new OperationFailedException("not_found", "That directory does not exist or cannot be read."); }
            if ((a & FileAttributes.Directory) == 0) throw new OperationFailedException("not_found", "That path is a file, not a directory.");
            if (directory != "C:\\" && (a & FileAttributes.ReparsePoint) != 0) throw new OperationFailedException("unavailable", "That path goes through a link or junction.");
        }
        var clock = Stopwatch.StartNew();
        bool partial = false;
        var options = new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint, RecurseSubdirectories = false };
        var sizes = new List<FolderSize>();
        long loose = 0;
        foreach (string file in Directory.EnumerateFiles(path, "*", options)) { try { loose += new FileInfo(file).Length; } catch (IOException) { } }
        foreach (string directory in Directory.EnumerateDirectories(path, "*", options))
        {
            if (clock.Elapsed.TotalSeconds > FolderBudgetSeconds || token.IsCancellationRequested) { partial = true; break; }
            long bytes = 0, files = 0;
            var deep = new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint, RecurseSubdirectories = true };
            try
            {
                foreach (string file in Directory.EnumerateFiles(directory, "*", deep))
                {
                    if (clock.Elapsed.TotalSeconds > FolderBudgetSeconds || token.IsCancellationRequested) { partial = true; break; }
                    try { bytes += new FileInfo(file).Length; files++; } catch (IOException) { }
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { partial = true; }
            string name = Path.GetFileName(directory);
            if (name.Length is 0 or > 256 || name.Any(char.IsControl)) continue;
            sizes.Add(new FolderSize { Name = name, SizeBytes = bytes, Files = files });
        }
        var top = sizes.OrderByDescending(s => s.SizeBytes).Take(25).ToList();
        return new DiskFoldersOutput { Path = path, Folders = top, TotalBytes = loose + sizes.Sum(s => s.SizeBytes), Partial = partial, ElapsedMs = clock.ElapsedMilliseconds };
    }

    // ---- dns.cache ----------------------------------------------------------------------------------------------------------------

    public static DnsCacheOutput DnsCache()
    {
        var rows = Try(StandardCim, "SELECT Name, Type, Data, TimeToLive FROM MSFT_DNSClientCache", 1000);
        var entries = rows.Select(r => new DnsCacheEntry
        {
            Name = InventoryRules.Clean(r.Text("Name"), 253) ?? "",
            Type = r.Long("Type") switch { 1 => "A", 2 => "NS", 5 => "CNAME", 12 => "PTR", 15 => "MX", 16 => "TXT", 28 => "AAAA", 33 => "SRV", var t => $"{t}" },
            Data = InventoryRules.Clean(r.Text("Data"), 300) ?? "",
            TtlSeconds = Math.Clamp(r.Long("TimeToLive") ?? 0, 0, 2_000_000),
        }).Where(e => e.Name.Length > 0);
        var (items, cut) = InventoryRules.Bound(entries, 500);
        return new DnsCacheOutput { TakenAt = DateTimeOffset.UtcNow, Entries = items, Truncated = cut };
    }

    // ---- power.status -------------------------------------------------------------------------------------------------------------

    public static PowerStatusOutput Power()
    {
        using var power = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Power");
        bool? flag(string name) => power?.GetValue(name) is int v ? v != 0 : null;
        return new PowerStatusOutput
        {
            TakenAt = DateTimeOffset.UtcNow,
            Plan = PowerSettings.ActivePlanName() ?? "Unknown",
            FastStartup = flag("HiberbootEnabled"),
            Hibernate = flag("HibernateEnabled"),
            UsbSelectiveSuspend = PowerSettings.UsbSuspend(),
        };
    }
}
