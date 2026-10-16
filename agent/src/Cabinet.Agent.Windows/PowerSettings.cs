using System.Globalization;
using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Windows;

/// <summary>Reads (and, for the power actions, sets) the Windows power plan through powercfg.exe, started by full path with an argument array.</summary>
[SupportedOSPlatform("windows")]
internal static class PowerSettings
{
    /// <summary>The USB settings subgroup and its "USB selective suspend setting".</summary>
    public const string UsbSubgroup = "2a737441-1930-4402-8d77-b2bebba308a3";
    public const string UsbSuspendSetting = "48e6b7a6-50f5-4782-a5d4-53bb8f07e226";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    public static string? ActivePlanName()
    {
        var r = ExternalProgram.Run("powercfg.exe", ["/getactivescheme"], Timeout);
        if (r.ExitCode != 0) return null;
        int open = r.Output.IndexOf('('), close = r.Output.LastIndexOf(')');
        return open >= 0 && close > open ? InventoryRules.Clean(r.Output[(open + 1)..close], 80) : null;
    }

    /// <summary>The AC and DC index values as printed: the last two "0x" numbers of the query. Null when powercfg does not answer.</summary>
    public static UsbSuspendSettings? UsbSuspend()
    {
        var r = ExternalProgram.Run("powercfg.exe", ["/query", "SCHEME_CURRENT", UsbSubgroup, UsbSuspendSetting], Timeout);
        if (r.ExitCode != 0) return null;
        var values = r.Output.Split('\n').Select(l => l.Trim()).Where(l => l.Contains("0x", StringComparison.Ordinal))
            .Select(l => l[(l.LastIndexOf("0x", StringComparison.Ordinal) + 2)..])
            .Select(h => long.TryParse(h, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out long v) ? (long?)v : null).ToList();
        if (values.Count < 2) return null;
        return new UsbSuspendSettings { PluggedIn = values[^2] is { } ac ? ac != 0 : null, OnBattery = values[^1] is { } dc ? dc != 0 : null };
    }

    /// <summary>Sets USB selective suspend on the active plan for both power sources, then re-applies the plan so it takes effect.</summary>
    public static void SetUsbSuspend(bool enabled)
    {
        string value = enabled ? "1" : "0";
        foreach (string verb in new[] { "/setacvalueindex", "/setdcvalueindex" })
            Require(ExternalProgram.Run("powercfg.exe", [verb, "SCHEME_CURRENT", UsbSubgroup, UsbSuspendSetting, value], Timeout), "setting USB selective suspend");
        Require(ExternalProgram.Run("powercfg.exe", ["/setactive", "SCHEME_CURRENT"], Timeout), "applying the power plan");
    }

    private const string PowerKey = @"SYSTEM\CurrentControlSet\Control\Session Manager\Power";

    public static bool? FastStartup()
    {
        using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(PowerKey);
        return key?.GetValue("HiberbootEnabled") is int v ? v != 0 : null;
    }

    /// <summary>The one registry value Windows keeps Fast Startup in. No other value is written.</summary>
    public static void SetFastStartup(bool enabled)
    {
        using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(PowerKey, writable: true)
            ?? throw new Core.OperationFailedException("execution_failed", "Windows has no power settings key to change.");
        key.SetValue("HiberbootEnabled", enabled ? 1 : 0, Microsoft.Win32.RegistryValueKind.DWord);
    }

    private static void Require(ExternalProgram.Outcome r, string what)
    {
        if (r.ExitCode != 0) throw new Core.OperationFailedException("execution_failed", $"Windows refused {what} (powercfg exit code {r.ExitCode}).");
    }
}
