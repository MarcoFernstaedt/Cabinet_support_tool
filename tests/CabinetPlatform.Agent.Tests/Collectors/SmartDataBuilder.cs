using CabinetPlatform.Agent.Collectors;

namespace CabinetPlatform.Agent.Tests.Collectors;

/// <summary>
/// Builds VendorSpecific buffers in the exact shape a storage driver returns
/// them, so the decoder is tested against the real layout rather than against
/// the decoder's own assumptions.
/// </summary>
internal sealed class SmartDataBuilder
{
    /// <summary>The full structure a drive returns is 512 bytes.</summary>
    public const int VendorSpecificLength = 512;

    private readonly List<(byte Id, byte Current, byte Worst, ushort Flags, long Raw)> _attributes = new();
    private byte _revisionLow = 0x10;
    private byte _revisionHigh = 0x00;

    public SmartDataBuilder WithRevision(byte low, byte high)
    {
        _revisionLow = low;
        _revisionHigh = high;
        return this;
    }

    public SmartDataBuilder WithAttribute(byte id, long raw, byte current = 100, byte worst = 100, ushort flags = 0x000B)
    {
        _attributes.Add((id, current, worst, flags, raw));
        return this;
    }

    /// <summary>Leaves an unused slot (attribute id 0) at the current position.</summary>
    public SmartDataBuilder WithEmptySlot()
    {
        _attributes.Add((0, 0, 0, 0, 0));
        return this;
    }

    public byte[] Build(int length = VendorSpecificLength)
    {
        var buffer = new byte[length];
        buffer[0] = _revisionLow;
        buffer[1] = _revisionHigh;

        for (var index = 0; index < _attributes.Count; index++)
        {
            var offset = SmartAttributeDecoder.AttributeTableOffset
                + (index * SmartAttributeDecoder.AttributeRecordLength);

            if (offset + SmartAttributeDecoder.AttributeRecordLength > buffer.Length)
            {
                break;
            }

            var attribute = _attributes[index];
            buffer[offset] = attribute.Id;
            buffer[offset + 1] = (byte)(attribute.Flags & 0xFF);
            buffer[offset + 2] = (byte)((attribute.Flags >> 8) & 0xFF);
            buffer[offset + 3] = attribute.Current;
            buffer[offset + 4] = attribute.Worst;

            for (var rawByte = 0; rawByte < 6; rawByte++)
            {
                buffer[offset + 5 + rawByte] = (byte)((attribute.Raw >> (8 * rawByte)) & 0xFF);
            }

            buffer[offset + 11] = 0;
        }

        return buffer;
    }
}
