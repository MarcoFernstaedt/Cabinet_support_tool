namespace CabinetPlatform.Agent.Platform.Wmi;

/// <summary>
/// Reads key properties out of the object-path strings WMI association classes
/// use for their endpoints, for example:
/// <c>\\CABINET-01\root\cimv2:Win32_LogonSession.LogonId="998877"</c>.
/// </summary>
/// <remarks>
/// Association queries are how a logon session is joined to an account, and a
/// physical disk to the drive letters that live on it. Both joins are wrong in
/// ways nobody notices if this parsing is sloppy: a mis-parsed LogonId silently
/// reports nobody logged on, which is exactly the condition that lets a reboot
/// through.
/// </remarks>
public static class WmiReference
{
    /// <summary>
    /// Extracts a named key property's value from an object path.
    /// </summary>
    /// <returns>The unquoted value, or null when the path has no such key.</returns>
    public static string? GetKeyValue(string? objectPath, string keyName)
    {
        if (string.IsNullOrWhiteSpace(objectPath) || string.IsNullOrWhiteSpace(keyName))
        {
            return null;
        }

        // Key properties follow the class name after a '.', separated by commas:
        //   Class.Key1="a",Key2="b"
        var classSeparator = objectPath.IndexOf('.');
        if (classSeparator < 0 || classSeparator == objectPath.Length - 1)
        {
            return null;
        }

        var keySection = objectPath[(classSeparator + 1)..];
        var searchFrom = 0;

        while (searchFrom < keySection.Length)
        {
            var equals = keySection.IndexOf('=', searchFrom);
            if (equals < 0)
            {
                return null;
            }

            var name = keySection[searchFrom..equals].Trim();
            var valueStart = equals + 1;
            string value;
            int nextStart;

            if (valueStart < keySection.Length && keySection[valueStart] == '"')
            {
                // A quoted value may itself contain an escaped quote or the
                // backslashes of a device path, so it is scanned rather than split.
                var builder = new System.Text.StringBuilder();
                var index = valueStart + 1;
                while (index < keySection.Length && keySection[index] != '"')
                {
                    if (keySection[index] == '\\' && index + 1 < keySection.Length)
                    {
                        index++;
                    }

                    builder.Append(keySection[index]);
                    index++;
                }

                value = builder.ToString();
                nextStart = index + 2;
            }
            else
            {
                var comma = keySection.IndexOf(',', valueStart);
                var end = comma < 0 ? keySection.Length : comma;
                value = keySection[valueStart..end];
                nextStart = end + 1;
            }

            if (name.Equals(keyName, StringComparison.OrdinalIgnoreCase))
            {
                return value;
            }

            searchFrom = nextStart;
        }

        return null;
    }

    /// <summary>Returns the class name portion of an object path.</summary>
    public static string? GetClassName(string? objectPath)
    {
        if (string.IsNullOrWhiteSpace(objectPath))
        {
            return null;
        }

        var namespaceSeparator = objectPath.LastIndexOf(':');
        var start = namespaceSeparator < 0 ? 0 : namespaceSeparator + 1;
        var dot = objectPath.IndexOf('.', start);
        var end = dot < 0 ? objectPath.Length : dot;

        return end > start ? objectPath[start..end] : null;
    }
}
