using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Cabinet.Agent.Core.Helpers;

/// <summary>
/// A minimal DNS A-record query and answer parser (RFC 1035), so network.test
/// can ask one specific configured DNS server, which the operating system
/// resolver cannot be told to do. Answers are untrusted bytes and are parsed
/// defensively: bounds checked, compression pointers limited, nothing beyond
/// A records read.
/// </summary>
public static class DnsWire
{
    public const int MaxNameLength = 253;

    public static byte[] BuildQuery(ushort id, string hostname)
    {
        if (hostname.Length is 0 or > MaxNameLength) throw new ArgumentException("Host name length is out of range.", nameof(hostname));
        var packet = new List<byte>(18 + hostname.Length);
        Span<byte> header = stackalloc byte[12];
        BinaryPrimitives.WriteUInt16BigEndian(header, id);
        header[2] = 0x01; // recursion desired
        header[5] = 0x01; // one question
        packet.AddRange(header.ToArray());
        foreach (string label in hostname.TrimEnd('.').Split('.'))
        {
            byte[] bytes = Encoding.ASCII.GetBytes(label);
            if (bytes.Length is 0 or > 63 || bytes.Any(b => !(char.IsAsciiLetterOrDigit((char)b) || b == '-')))
                throw new ArgumentException("Host name has an invalid label.", nameof(hostname));
            packet.Add((byte)bytes.Length);
            packet.AddRange(bytes);
        }
        packet.Add(0);
        packet.AddRange(new byte[] { 0, 1, 0, 1 }); // type A, class IN
        return packet.ToArray();
    }

    public sealed record Answer(int ResponseCode, IReadOnlyList<IPAddress> Addresses);

    /// <returns>The parsed answer, or null when the packet is not a well-formed reply to <paramref name="id"/>.</returns>
    public static Answer? ParseResponse(ReadOnlySpan<byte> packet, ushort id)
    {
        if (packet.Length < 12 || packet.Length > 4096) return null;
        if (BinaryPrimitives.ReadUInt16BigEndian(packet) != id) return null;
        if ((packet[2] & 0x80) == 0) return null; // not a response
        int rcode = packet[3] & 0x0F;
        int questions = BinaryPrimitives.ReadUInt16BigEndian(packet[4..]);
        int answers = BinaryPrimitives.ReadUInt16BigEndian(packet[6..]);
        int offset = 12;
        for (int q = 0; q < questions; q++)
        {
            if (!SkipName(packet, ref offset) || offset + 4 > packet.Length) return null;
            offset += 4;
        }
        var addresses = new List<IPAddress>();
        for (int a = 0; a < answers && addresses.Count < 16; a++)
        {
            if (!SkipName(packet, ref offset) || offset + 10 > packet.Length) return null;
            ushort type = BinaryPrimitives.ReadUInt16BigEndian(packet[offset..]);
            ushort cls = BinaryPrimitives.ReadUInt16BigEndian(packet[(offset + 2)..]);
            ushort length = BinaryPrimitives.ReadUInt16BigEndian(packet[(offset + 8)..]);
            offset += 10;
            if (offset + length > packet.Length) return null;
            if (type == 1 && cls == 1 && length == 4) addresses.Add(new IPAddress(packet.Slice(offset, 4)));
            offset += length;
        }
        return new Answer(rcode, addresses);
    }

    /// <summary>Skips a possibly compressed name. A pointer ends the name, so loops cannot occur.</summary>
    private static bool SkipName(ReadOnlySpan<byte> packet, ref int offset)
    {
        for (int labels = 0; labels < 128; labels++)
        {
            if (offset >= packet.Length) return false;
            byte length = packet[offset];
            if (length == 0) { offset++; return true; }
            if ((length & 0xC0) == 0xC0) { if (offset + 2 > packet.Length) return false; offset += 2; return true; }
            if ((length & 0xC0) != 0) return false;
            offset += 1 + length;
        }
        return false;
    }

    public static string RcodeText(int rcode) => rcode switch
    {
        1 => "the server reported a format error",
        2 => "the server failed",
        3 => "the name does not exist",
        4 => "the server does not support the query",
        5 => "the server refused the query",
        _ => $"the server answered with error {rcode}",
    };

    /// <summary>Sends one A query to <paramref name="server"/> over UDP port 53 and waits for the matching answer.</summary>
    public static async Task<Answer?> QueryAsync(IPAddress server, string hostname, TimeSpan timeout, CancellationToken token)
    {
        ushort id = (ushort)Random.Shared.Next(1, 65536);
        byte[] query = BuildQuery(id, hostname);
        using var udp = new UdpClient(server.AddressFamily);
        udp.Connect(new IPEndPoint(server, 53));
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(timeout);
        await udp.SendAsync(query, limit.Token).ConfigureAwait(false);
        while (true)
        {
            UdpReceiveResult reply = await udp.ReceiveAsync(limit.Token).ConfigureAwait(false);
            if (!reply.RemoteEndPoint.Address.Equals(server)) continue;
            if (ParseResponse(reply.Buffer, id) is { } answer) return answer;
        }
    }
}
