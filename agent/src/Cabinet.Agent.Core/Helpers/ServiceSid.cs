using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Cabinet.Agent.Core.Helpers;

/// <summary>
/// The per-service security identifier Windows gives a service ("NT SERVICE\name"):
/// S-1-5-80 followed by the SHA-1 of the upper-cased service name in UTF-16LE,
/// as five little-endian 32-bit numbers. Computed rather than looked up so the
/// broker's pipe can admit the network service even before that service is
/// installed, and so tests can prove the value on any platform.
/// </summary>
public static class ServiceSid
{
    public static string For(string serviceName)
    {
        byte[] hash = SHA1.HashData(Encoding.Unicode.GetBytes(serviceName.ToUpperInvariant()));
        var parts = new uint[5];
        for (int i = 0; i < 5; i++) parts[i] = BinaryPrimitives.ReadUInt32LittleEndian(hash.AsSpan(i * 4, 4));
        return "S-1-5-80-" + string.Join('-', parts);
    }
}
