using System.Runtime.InteropServices;

namespace CabinetPlatform.Agent.Platform;

/// <summary>A mode from the OS desktop visible to this service. It is not a user-session DPI or zoom measurement.</summary>
public readonly record struct NativeDisplayMode(int WidthPixels, int HeightPixels, int? RefreshHz);

public interface IDisplayModeGateway
{
    IReadOnlyList<NativeDisplayMode> ReadModes(CancellationToken cancellationToken);
}

/// <summary>Enumerates attached desktop display modes with read-only Win32 calls. No display names leave this class.</summary>
public sealed class WindowsDisplayModeGateway : IDisplayModeGateway
{
    private const int MaxDevicesToInspect = 32;
    private const int AttachedToDesktop = 1;
    private const int MirroringDriver = 8;
    private const int CurrentSettings = -1;
    private const int AccessDenied = 5;

    public IReadOnlyList<NativeDisplayMode> ReadModes(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!OperatingSystem.IsWindows()) return Array.Empty<NativeDisplayMode>();

        var modes = new List<NativeDisplayMode>();
        for (uint index = 0; index < MaxDevicesToInspect; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var device = new DisplayDevice { Size = Marshal.SizeOf<DisplayDevice>() };
            if (!EnumDisplayDevices(null, index, ref device, 0))
            {
                if (Marshal.GetLastWin32Error() == AccessDenied) throw new UnauthorizedAccessException();
                break;
            }
            if ((device.StateFlags & AttachedToDesktop) == 0 || (device.StateFlags & MirroringDriver) != 0)
                continue;

            var mode = new DevMode { Size = (ushort)Marshal.SizeOf<DevMode>() };
            if (!EnumDisplaySettingsEx(device.DeviceName, CurrentSettings, ref mode, 0))
            {
                if (Marshal.GetLastWin32Error() == AccessDenied) throw new UnauthorizedAccessException();
                continue;
            }
            if (mode.Width > 0 && mode.Height > 0 && mode.Width <= 16384 && mode.Height <= 16384)
                modes.Add(new NativeDisplayMode((int)mode.Width, (int)mode.Height,
                    mode.Frequency is > 0 and <= 1000 ? (int)mode.Frequency : null));
        }
        cancellationToken.ThrowIfCancellationRequested();
        return modes;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayDevice
    {
        public int Size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceId;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    // DEVMODEW offsets from wingdi.h. Only dmSize and the read-only pixel/frequency fields are used.
    [StructLayout(LayoutKind.Explicit, Size = 220, CharSet = CharSet.Unicode)]
    private struct DevMode
    {
        [FieldOffset(68)] public ushort Size;
        [FieldOffset(172)] public uint Width;
        [FieldOffset(176)] public uint Height;
        [FieldOffset(184)] public uint Frequency;
    }

    [DllImport("user32.dll", EntryPoint = "EnumDisplayDevicesW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayDevices(string? device, uint index, ref DisplayDevice displayDevice, uint flags);

    [DllImport("user32.dll", EntryPoint = "EnumDisplaySettingsExW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplaySettingsEx(string device, int modeNum, ref DevMode mode, uint flags);
}
