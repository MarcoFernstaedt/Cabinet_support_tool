using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Decodes the <c>VendorSpecific</c> buffer of
/// <c>MSStorageDriver_FailurePredictData</c> into S.M.A.R.T. attributes.
/// </summary>
/// <remarks>
/// <para>
/// The buffer is the drive's raw 512-byte SMART data structure. The first two
/// bytes are a revision word; the attribute table begins at offset 2 and holds
/// up to 30 fixed 12-byte records laid out as:
/// </para>
/// <code>
///   +0  attribute id      (1 byte, 0 means the slot is unused)
///   +1  status flags      (2 bytes, little-endian)
///   +3  current value     (1 byte, normalised)
///   +4  worst value       (1 byte, normalised)
///   +5  raw value         (6 bytes, little-endian)
///   +11 reserved          (1 byte)
/// </code>
/// <para>
/// Two mistakes in this layout are easy to make and nearly invisible once made:
/// starting the table at offset 0 rather than 2, which shifts every attribute
/// id by one record and reports another drive's counters entirely; and reading
/// the raw value as 4 bytes rather than 6, which is correct for most drives
/// right up until a power-on-hours count exceeds 32 bits. Both are covered by
/// tests.
/// </para>
/// <para>
/// An attribute that is not present is reported as null. Nothing here ever
/// substitutes zero for a value it could not read: on a reallocated-sector
/// count, zero is the reading that means the drive is fine.
/// </para>
/// </remarks>
public static class SmartAttributeDecoder
{
    /// <summary>Offset of the first attribute record; the two bytes before it are a revision word.</summary>
    public const int AttributeTableOffset = 2;

    /// <summary>Size of one attribute record in bytes.</summary>
    public const int AttributeRecordLength = 12;

    /// <summary>Maximum number of attribute records the ATA structure defines.</summary>
    public const int MaximumAttributeCount = 30;

    /// <summary>
    /// Decodes every populated attribute record in <paramref name="vendorSpecific"/>.
    /// </summary>
    /// <returns>
    /// The attributes found, in table order. An empty list when the buffer is
    /// null, too short to contain a record, or contains no populated slots.
    /// </returns>
    public static IReadOnlyList<SmartAttribute> Decode(byte[]? vendorSpecific)
    {
        if (vendorSpecific is null || vendorSpecific.Length < AttributeTableOffset + AttributeRecordLength)
        {
            return Array.Empty<SmartAttribute>();
        }

        var attributes = new List<SmartAttribute>();

        for (var index = 0; index < MaximumAttributeCount; index++)
        {
            var offset = AttributeTableOffset + (index * AttributeRecordLength);

            // Stop rather than throw on a buffer shorter than the full table.
            // Some controllers return a truncated structure.
            if (offset + AttributeRecordLength > vendorSpecific.Length)
            {
                break;
            }

            var id = vendorSpecific[offset];
            if (id == 0)
            {
                // An id of zero marks an unused slot. Later slots can still be
                // populated on some firmware, so this skips rather than stops.
                continue;
            }

            attributes.Add(new SmartAttribute
            {
                Id = id,
                Flags = (ushort)(vendorSpecific[offset + 1] | (vendorSpecific[offset + 2] << 8)),
                Current = vendorSpecific[offset + 3],
                Worst = vendorSpecific[offset + 4],
                Raw = ReadRawValue(vendorSpecific, offset + 5),
            });
        }

        return attributes;
    }

    /// <summary>
    /// Reads the 48-bit little-endian raw value at <paramref name="offset"/>.
    /// </summary>
    public static long ReadRawValue(byte[] buffer, int offset)
    {
        long raw = 0;
        for (var byteIndex = 0; byteIndex < 6; byteIndex++)
        {
            raw |= (long)buffer[offset + byteIndex] << (8 * byteIndex);
        }

        return raw;
    }

    /// <summary>
    /// Projects decoded attributes onto the wire contract, leaving any
    /// attribute the drive did not report as null.
    /// </summary>
    /// <param name="attributes">Attributes decoded from the vendor buffer.</param>
    /// <param name="overallPredictFailure">
    /// The drive's own failure prediction from
    /// <c>MSStorageDriver_FailurePredictStatus</c>, or null when that class was
    /// unreadable.
    /// </param>
    /// <param name="model">Drive model, when known.</param>
    /// <param name="serialNumber">Drive serial, when known.</param>
    public static SmartInfo ToSmartInfo(
        IReadOnlyList<SmartAttribute> attributes,
        bool? overallPredictFailure,
        string? model = null,
        string? serialNumber = null)
    {
        return new SmartInfo
        {
            ReallocatedSectorCount = RawAsInt(attributes, SmartAttributeIds.ReallocatedSectorCount),
            PendingSectorCount = RawAsInt(attributes, SmartAttributeIds.CurrentPendingSectorCount),
            UncorrectableErrorCount = RawAsInt(attributes, SmartAttributeIds.UncorrectableSectorCount),
            PowerOnHours = RawAsInt(attributes, SmartAttributeIds.PowerOnHours),
            TemperatureCelsius = ReadTemperature(attributes),
            OverallPredictFailure = overallPredictFailure,
            Model = model,
            SerialNumber = serialNumber,
        };
    }

    /// <summary>
    /// Finds an attribute's raw value, clamped into the contract's 32-bit
    /// field. The raw field is 48 bits wide, so a drive reporting a very large
    /// count would otherwise overflow into a negative number and read as
    /// healthier than it is.
    /// </summary>
    private static int? RawAsInt(IReadOnlyList<SmartAttribute> attributes, byte id)
    {
        var attribute = Find(attributes, id);
        if (attribute is null)
        {
            return null;
        }

        return attribute.Raw > int.MaxValue ? int.MaxValue : (int)attribute.Raw;
    }

    /// <summary>
    /// Extracts the current temperature from attribute 0xC2.
    /// </summary>
    /// <remarks>
    /// Only the low byte is the current reading. Most drives pack the lifetime
    /// minimum and maximum into the upper bytes of the same raw field, so
    /// reading all six bytes as one number yields values in the thousands.
    /// </remarks>
    private static int? ReadTemperature(IReadOnlyList<SmartAttribute> attributes)
    {
        var attribute = Find(attributes, SmartAttributeIds.TemperatureCelsius);
        if (attribute is null)
        {
            return null;
        }

        var celsius = (int)(attribute.Raw & 0xFF);

        // A plausibility gate. A drive reporting 0 C or 200 C is a drive whose
        // vendor uses this attribute for something else; unknown beats wrong.
        return celsius is > 0 and < 125 ? celsius : null;
    }

    private static SmartAttribute? Find(IReadOnlyList<SmartAttribute> attributes, byte id)
    {
        for (var i = 0; i < attributes.Count; i++)
        {
            if (attributes[i].Id == id)
            {
                return attributes[i];
            }
        }

        return null;
    }
}
