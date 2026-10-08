using System.Globalization;

namespace Cabinet.Agent.Core.Upgrades;

/// <summary>
/// An agent version (common.schema.json agentVersion): major.minor.patch with an optional pre-release tag,
/// ordered by semantic-versioning rules. A pre-release sorts before its release.
/// </summary>
public readonly record struct SemVersion(int Major, int Minor, int Patch, string? PreRelease) : IComparable<SemVersion>
{
    public static bool TryParse(string? text, out SemVersion version)
    {
        version = default;
        if (string.IsNullOrEmpty(text) || text.Length > 64) return false;
        string core = text, pre = "";
        int dash = text.IndexOf('-');
        if (dash >= 0) { core = text[..dash]; pre = text[(dash + 1)..]; if (pre.Length is 0 or > 32) return false; }
        string[] parts = core.Split('.');
        if (parts.Length != 3) return false;
        var n = new int[3];
        for (int i = 0; i < 3; i++)
        {
            string p = parts[i];
            if (p.Length is 0 or > 9 || (p.Length > 1 && p[0] == '0') || !p.All(char.IsAsciiDigit)) return false;
            n[i] = int.Parse(p, NumberStyles.None, CultureInfo.InvariantCulture);
        }
        if (pre.Length > 0 && pre.Split('.').Any(id => id.Length == 0 || !id.All(c => char.IsAsciiLetterOrDigit(c) || c == '-'))) return false;
        version = new SemVersion(n[0], n[1], n[2], pre.Length > 0 ? pre : null);
        return true;
    }

    public static SemVersion Parse(string text) =>
        TryParse(text, out SemVersion v) ? v : throw new FormatException($"\"{text}\" is not an agent version.");

    public int CompareTo(SemVersion other)
    {
        int c = Major.CompareTo(other.Major);
        if (c == 0) c = Minor.CompareTo(other.Minor);
        if (c == 0) c = Patch.CompareTo(other.Patch);
        if (c != 0) return c;
        if (PreRelease == other.PreRelease) return 0;
        if (PreRelease is null) return 1;
        if (other.PreRelease is null) return -1;
        string[] a = PreRelease.Split('.'), b = other.PreRelease.Split('.');
        for (int i = 0; i < Math.Min(a.Length, b.Length); i++)
        {
            bool an = a[i].All(char.IsAsciiDigit), bn = b[i].All(char.IsAsciiDigit);
            int d = an && bn ? decimal.Parse(a[i], CultureInfo.InvariantCulture).CompareTo(decimal.Parse(b[i], CultureInfo.InvariantCulture))
                : an ? -1 : bn ? 1 : string.CompareOrdinal(a[i], b[i]);
            if (d != 0) return d;
        }
        return a.Length.CompareTo(b.Length);
    }

    public static bool operator >(SemVersion a, SemVersion b) => a.CompareTo(b) > 0;
    public static bool operator <(SemVersion a, SemVersion b) => a.CompareTo(b) < 0;
    public static bool operator >=(SemVersion a, SemVersion b) => a.CompareTo(b) >= 0;
    public static bool operator <=(SemVersion a, SemVersion b) => a.CompareTo(b) <= 0;

    public override string ToString() => $"{Major}.{Minor}.{Patch}{(PreRelease is null ? "" : "-" + PreRelease)}";
}
