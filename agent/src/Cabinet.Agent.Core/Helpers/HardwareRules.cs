using System.Net;
using System.Text;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Helpers;

/// <summary>
/// The platform-independent rules behind system.hardware, system.identity and network.hosts: parsing and bounds only. Everything these
/// functions read (registry text, the hosts file, monitor identification data) is untrusted, so each one drops what it does not recognise.
/// Plain string handling, no pattern matching of text.
/// </summary>
public static class HardwareRules
{
    public const int MaxHostsEntries = 500;
    public const int MaxNamesPerEntry = 16;
    public const int MaxHostsFileBytes = 1_048_576;
    public const int MaxPorts = 32;
    public const int MaxMonitors = 16;
    public const int MaxModules = 32;
    public const int MaxAdministrators = 64;

    // ---- hosts file -------------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// The entries of a hosts file: an address and its names. Comments (from # to the end of the line) and blank lines are dropped, and so is
    /// any line whose first word is not an IP address, or that has no usable name. Names over 255 characters or with unprintable characters are
    /// skipped; at most 16 names are kept per line and <paramref name="max"/> entries in all.
    /// </summary>
    public static (List<HostsEntry> Entries, bool Truncated) ParseHosts(string? text, int max = MaxHostsEntries)
    {
        var entries = new List<HostsEntry>();
        if (string.IsNullOrEmpty(text)) return (entries, false);
        foreach (string rawLine in text.Split('\n'))
        {
            if (rawLine.Length > 8192) continue;
            string line = rawLine;
            int hash = line.IndexOf('#');
            if (hash >= 0) line = line[..hash];
            string[] words = line.Split([' ', '\t', '\r', ' ', '\u000B', '\u000C'], StringSplitOptions.RemoveEmptyEntries);
            if (words.Length < 2 || !IsAddress(words[0])) continue;
            var names = new List<string>();
            foreach (string word in words.Skip(1))
            {
                if (names.Count >= MaxNamesPerEntry) break;
                if (IsHostName(word)) names.Add(word);
            }
            if (names.Count == 0) continue;
            if (entries.Count >= max) return (entries, true);
            entries.Add(new HostsEntry { Address = words[0], Names = names });
        }
        return (entries, false);
    }

    /// <summary>An IPv4 or IPv6 address as the contract allows it: hex digits, dots, colons and a % scope, nothing else.</summary>
    public static bool IsAddress(string word)
    {
        if (word.Length is < 2 or > 45) return false;
        foreach (char c in word) if (!(char.IsAsciiHexDigit(c) || c is ':' or '.' or '%')) return false;
        int scope = word.IndexOf('%');
        string bare = scope >= 0 ? word[..scope] : word;
        return IPAddress.TryParse(bare, out _);
    }

    private static bool IsHostName(string word)
    {
        if (word.Length is 0 or > 255) return false;
        foreach (char c in word) if (char.IsControl(c) || char.IsWhiteSpace(c)) return false;
        return true;
    }

    /// <summary>Decodes hosts file bytes (UTF-8, with or without a byte order mark); bytes that do not decode become a replacement character.</summary>
    public static string DecodeHosts(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) bytes = bytes[3..];
        return Encoding.UTF8.GetString(bytes);
    }

    // ---- monitors ---------------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// A monitor's name and native resolution from its 128-byte EDID block. The first detailed timing descriptor is the native mode. Anything
    /// that is not a valid EDID (wrong header or checksum) gives nothing.
    /// </summary>
    public static (string? Name, long? Width, long? Height) ParseEdid(byte[]? edid)
    {
        if (edid is null || edid.Length < 128) return (null, null, null);
        byte[] header = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];
        for (int i = 0; i < 8; i++) if (edid[i] != header[i]) return (null, null, null);
        int sum = 0;
        for (int i = 0; i < 128; i++) sum += edid[i];
        if (sum % 256 != 0) return (null, null, null);

        long? width = null, height = null;
        string? name = null;
        for (int block = 0; block < 4; block++)
        {
            int at = 54 + 18 * block;
            int pixelClock = edid[at] | (edid[at + 1] << 8);
            if (pixelClock != 0)
            {
                if (block == 0)
                {
                    long w = edid[at + 2] | ((edid[at + 4] & 0xF0) << 4), h = edid[at + 5] | ((edid[at + 7] & 0xF0) << 4);
                    if (w is > 0 and <= 16384 && h is > 0 and <= 16384) { width = w; height = h; }
                }
            }
            else if (edid[at + 3] == 0xFC)
            {
                var text = new StringBuilder();
                for (int i = 5; i < 18; i++)
                {
                    byte b = edid[at + i];
                    if (b == 0x0A) break;
                    text.Append(b is >= 0x20 and < 0x7F ? (char)b : ' ');
                }
                name = InventoryRules.Clean(text.ToString(), 64);
            }
        }
        return (name, width, height);
    }

    // ---- boot, TPM, Secure Boot -------------------------------------------------------------------------------------------------------

    /// <summary>UEFISecureBootEnabled from HKLM\SYSTEM\CurrentControlSet\Control\SecureBoot\State. No key means the firmware has no Secure Boot.</summary>
    public static SecureBootState? SecureBootFor(bool keyExists, object? value)
    {
        if (!keyExists) return SecureBootState.Unsupported;
        return value is int v ? (v == 1 ? SecureBootState.On : v == 0 ? SecureBootState.Off : null) : null;
    }

    /// <summary>Win32_Tpm.SpecVersion looks like "2.0, 0, 1.38": the first part is the TPM version.</summary>
    public static string? TpmVersion(string? specVersion)
    {
        if (string.IsNullOrWhiteSpace(specVersion)) return null;
        string first = specVersion.Split(',')[0].Trim();
        return first.Length is > 0 and <= 8 && first.All(c => char.IsAsciiDigit(c) || c == '.') ? first : null;
    }

    /// <summary>A FILETIME stored as two 32-bit registry values. Zero, or a time before 1995 or after 2100, is not a real answer.</summary>
    public static DateTimeOffset? FileTimeFromParts(object? low, object? high)
    {
        if (low is not int lo || high is not int hi) return null;
        long ticks = ((long)(uint)hi << 32) | (uint)lo;
        if (ticks <= 0) return null;
        try
        {
            var time = DateTimeOffset.FromFileTime(ticks).ToUniversalTime();
            return time.Year is >= 1995 and <= 2100 ? time : null;
        }
        catch (ArgumentOutOfRangeException) { return null; }
    }

    // ---- identity ---------------------------------------------------------------------------------------------------------------------

    /// <summary>NETSETUP_JOIN_STATUS from NetGetJoinInformation: 1 unjoined, 2 workgroup, 3 domain.</summary>
    public static JoinType JoinTypeFor(int status) => status switch { 2 => JoinType.Workgroup, 3 => JoinType.Domain, _ => JoinType.Unknown };

    /// <summary>The AutoAdminLogon value is the text "1" or the number 1 when automatic sign-in is on.</summary>
    public static bool AutoLogonOn(object? value) => value switch { string s => s.Trim() == "1", int i => i == 1, _ => false };

    // ---- COM ports --------------------------------------------------------------------------------------------------------------------

    /// <summary>"COM" and one to three digits, as Windows names serial ports.</summary>
    public static bool IsComPortName(string? name) =>
        name is { Length: >= 4 and <= 6 } && name.StartsWith("COM", StringComparison.OrdinalIgnoreCase) && name[3..].All(char.IsAsciiDigit) && name[3] != '0';

    public static int ComNumber(string name) => int.Parse(name[3..]);

    /// <summary>The key under Control\Class for a device's driver ("{guid}\0003"), or null when the value is not exactly that shape for this class.</summary>
    public static string? DriverKeyFor(string? driverValue, string classGuid)
    {
        if (driverValue is null || driverValue.Length != classGuid.Length + 5) return null;
        if (!driverValue.StartsWith(classGuid + "\\", StringComparison.OrdinalIgnoreCase)) return null;
        string index = driverValue[(classGuid.Length + 1)..];
        return index.All(char.IsAsciiDigit) ? index : null;
    }

    /// <summary>A device description such as "@msports.inf,%portdesc%;Communications Port" is shown as its text after the last semicolon.</summary>
    public static string? DeviceText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        string t = text.StartsWith('@') ? text[(text.LastIndexOf(';') + 1)..] : text;
        return InventoryRules.Clean(t, 200);
    }

    /// <summary>A WMI monitor instance such as "DISPLAY\DELA0A8\5&amp;1a2b&amp;0&amp;UID4352_0" as its registry path under Enum, or null for anything unexpected.</summary>
    public static string? MonitorEnumPath(string? instanceName)
    {
        if (instanceName is null || instanceName.Length is < 10 or > 200 || !instanceName.StartsWith("DISPLAY\\", StringComparison.OrdinalIgnoreCase)) return null;
        string[] parts = instanceName.Split('\\');
        if (parts.Length != 3) return null;
        string last = parts[2];
        int underscore = last.LastIndexOf('_');
        if (underscore > 0 && last[(underscore + 1)..].All(char.IsAsciiDigit) && last.Length - underscore <= 4) parts[2] = last[..underscore];
        foreach (string part in parts)
            if (part.Length == 0 || !part.All(c => char.IsAsciiLetterOrDigit(c) || c is '&' or '_' or '-' or '.' or '#')) return null;
        return string.Join('\\', parts);
    }

    /// <summary>A WMI string stored as numbers (a monitor's friendly name) as text, stopping at the first zero.</summary>
    public static string? TextFromNumbers(object? value)
    {
        if (value is not ushort[] numbers) return null;
        var text = new StringBuilder();
        foreach (ushort n in numbers)
        {
            if (n == 0) break;
            text.Append(n is >= 0x20 and < 0x7F ? (char)n : ' ');
            if (text.Length >= 64) break;
        }
        return InventoryRules.Clean(text.ToString(), 64);
    }
}
