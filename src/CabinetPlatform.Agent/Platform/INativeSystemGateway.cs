using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace CabinetPlatform.Agent.Platform;

/// <summary>
/// The handful of Win32 calls the agent's actions need.
/// </summary>
/// <remarks>
/// Each is a specific documented API rather than a command line. Nothing here
/// shells out: launching <c>ipconfig</c> to flush a DNS cache would mean the
/// agent had a path for running an external program, and that path would then
/// exist for anything else that reached it.
/// </remarks>
public interface INativeSystemGateway
{
    /// <summary>Flushes the DNS resolver cache.</summary>
    void FlushDnsResolverCache();

    /// <summary>
    /// Requests a system shutdown or restart with a reason code.
    /// </summary>
    void InitiateRestart(TimeSpan delay, string message);
}

/// <summary>P/Invoke implementations of <see cref="INativeSystemGateway"/>.</summary>
[SupportedOSPlatform("windows")]
public sealed class NativeSystemGateway : INativeSystemGateway
{
    /// <summary>Planned maintenance, at the operating system's request.</summary>
    private const uint ShutdownReasonMajorOperatingSystem = 0x00020000;

    private const uint ShutdownReasonMinorMaintenance = 0x00000001;

    /// <summary>
    /// Marks the restart as planned so it is not recorded as an unexpected
    /// shutdown in the event log, which would otherwise look like a fault to
    /// whoever reviews the cabinet's history.
    /// </summary>
    private const uint ShutdownReasonFlagPlanned = 0x80000000;

    private const uint ShutdownReason =
        ShutdownReasonMajorOperatingSystem | ShutdownReasonMinorMaintenance | ShutdownReasonFlagPlanned;

    private const string SeShutdownPrivilege = "SeShutdownPrivilege";
    private const uint TokenAdjustPrivileges = 0x0020;
    private const uint TokenQuery = 0x0008;
    private const uint SePrivilegeEnabled = 0x00000002;

    private readonly ILogger<NativeSystemGateway> _logger;

    public NativeSystemGateway(ILogger<NativeSystemGateway> logger) => _logger = logger;

    public void FlushDnsResolverCache()
    {
        if (!DnsFlushResolverCache())
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "DnsFlushResolverCache reported failure.");
        }
    }

    public void InitiateRestart(TimeSpan delay, string message)
    {
        // The privilege is disabled by default even in LocalSystem's token and
        // must be enabled for this process before the call will be honoured.
        EnableShutdownPrivilege();

        var seconds = (uint)Math.Clamp(delay.TotalSeconds, 0, 600);

        var initiated = InitiateSystemShutdownEx(
            lpMachineName: null,
            lpMessage: message,
            dwTimeout: seconds,
            bForceAppsClosed: false,
            bRebootAfterShutdown: true,
            dwReason: ShutdownReason);

        if (!initiated)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "InitiateSystemShutdownEx reported failure.");
        }

        _logger.LogWarning(
            "A system restart has been initiated and will occur in {DelaySeconds} seconds.",
            seconds);
    }

    private void EnableShutdownPrivilege()
    {
        if (!OpenProcessToken(GetCurrentProcess(), TokenAdjustPrivileges | TokenQuery, out var tokenHandle))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open this process's token.");
        }

        try
        {
            if (!LookupPrivilegeValue(null, SeShutdownPrivilege, out var luid))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not look up SeShutdownPrivilege.");
            }

            var privileges = new TokenPrivileges
            {
                PrivilegeCount = 1,
                Luid = luid,
                Attributes = SePrivilegeEnabled,
            };

            if (!AdjustTokenPrivileges(tokenHandle, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not adjust token privileges.");
            }

            // AdjustTokenPrivileges returns success even when it granted
            // nothing, so the last error has to be checked separately.
            var lastError = Marshal.GetLastWin32Error();
            if (lastError != 0)
            {
                throw new Win32Exception(lastError, "SeShutdownPrivilege was not granted to this process.");
            }
        }
        finally
        {
            CloseHandle(tokenHandle);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges
    {
        public uint PrivilegeCount;
        public Luid Luid;
        public uint Attributes;
    }

    [DllImport("dnsapi.dll", EntryPoint = "DnsFlushResolverCache", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DnsFlushResolverCache();

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitiateSystemShutdownEx(
        string? lpMachineName,
        string? lpMessage,
        uint dwTimeout,
        [MarshalAs(UnmanagedType.Bool)] bool bForceAppsClosed,
        [MarshalAs(UnmanagedType.Bool)] bool bRebootAfterShutdown,
        uint dwReason);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LookupPrivilegeValue(string? systemName, string name, out Luid luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AdjustTokenPrivileges(
        IntPtr tokenHandle,
        [MarshalAs(UnmanagedType.Bool)] bool disableAllPrivileges,
        ref TokenPrivileges newState,
        uint bufferLength,
        IntPtr previousState,
        IntPtr returnLength);
}
