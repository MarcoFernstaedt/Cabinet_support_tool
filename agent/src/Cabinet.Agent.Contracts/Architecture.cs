namespace Cabinet.Agent.Contracts;

/// <summary>
/// Which Windows the agent's own programs are built for (contracts/schemas/common.schema.json $defs/architecture):
/// exactly "windows-x64" or "windows-x86". One cabinet runs one of the two, so this is the value the platform records
/// for the cabinet and the value an update has to match.
/// </summary>
public static class AgentArchitecture
{
    public const string X64 = "windows-x64";
    public const string X86 = "windows-x86";

    /// <summary>
    /// The architecture of the programs in this build, taken from the running process's own bitness rather than from
    /// the operating system. A 32-bit agent runs on 64-bit Windows (the case the installer has a named lab-only switch
    /// for), and what the platform must know and an update must match is the build installed on this cabinet, not what
    /// the OS could run — a 64-bit agent on a 64-bit cabinet and a 32-bit agent on the same cabinet are different
    /// cabinets to the platform. A published, self-contained program's process bitness is exactly the runtime it was
    /// published for.
    /// </summary>
    public static string Current { get; } = Environment.Is64BitProcess ? X64 : X86;

    /// <summary>
    /// The contract value for a PE header's Machine field, or null for one the agent is not published for (ARM64) or
    /// for a header that could not be read at all. 0x014c is IMAGE_FILE_MACHINE_I386, 0x8664 is IMAGE_FILE_MACHINE_AMD64.
    /// </summary>
    public static string? FromPeMachine(int? machine) => machine switch
    {
        0x14C => X86,
        0x8664 => X64,
        _ => null,
    };
}
