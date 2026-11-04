using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;
using Microsoft.Win32.SafeHandles;

namespace Cabinet.Agent.Windows;

/// <summary>
/// storage.health on Windows: each physical drive from Storage Management, with an NVMe drive's own health log asked for through
/// IOCTL_STORAGE_QUERY_PROPERTY (a query: no command that changes the drive is ever sent), and each fixed volume's repair state (its HealthStatus) and
/// dirty bit. Drives are opened by number (\\.\PhysicalDriveN) and volumes by letter (\\.\C:), both taken from what Windows reported and
/// checked, never from a command; they are opened with no read or write access, which these two queries do not need. Runs in the broker
/// (opening a drive needs administrator rights). Nothing is changed.
/// </summary>
[SupportedOSPlatform("windows")]
public static class StorageOperations
{
    private const uint IoctlStorageQueryProperty = 0x002D1400, FsctlIsVolumeDirty = 0x00090078;
    private const uint ShareReadWrite = 0x1 | 0x2, OpenExisting = 3;
    private const int ErrorInvalidFunction = 1, ErrorNotSupported = 50, ErrorInvalidParameter = 87;

    public static Task<StorageHealthOutput> HealthAsync(EmptyParams _, CancellationToken token)
    {
        var drives = new List<StorageDrive>();
        foreach (var d in Wmi.Query(Wmi.Storage, "SELECT DeviceId, FriendlyName, Model, BusType FROM MSFT_PhysicalDisk", StorageHealth.MaxDrives))
        {
            token.ThrowIfCancellationRequested();
            if (!int.TryParse(d.Text("DeviceId"), NumberStyles.None, CultureInfo.InvariantCulture, out int number) || number > 255) continue;
            StorageBus bus = StorageHealth.BusOf(d.Long("BusType"));
            var (health, problem) = bus == StorageBus.Nvme ? NvmeHealth(number) : (null, NvmeProblem.NotNvme);
            drives.Add(new StorageDrive
            {
                Number = number, Model = Short(d.Text("FriendlyName") ?? d.Text("Model")), Bus = bus, Nvme = health, NvmeProblem = problem,
            });
        }

        var volumes = new List<StorageVolume>();
        foreach (var v in Wmi.Query(Wmi.Storage, "SELECT DriveLetter, FileSystemLabel, FileSystem, Size, SizeRemaining, HealthStatus, DriveType FROM MSFT_Volume", 256))
        {
            token.ThrowIfCancellationRequested();
            if (v.Long("DriveType") != 3) continue; // fixed volumes only: not removable media, network or optical drives
            if (volumes.Count == StorageHealth.MaxVolumes) break;
            string? letter = StorageHealth.LetterOf(v["DriveLetter"] is char c ? c.ToString() : v.Text("DriveLetter"));
            volumes.Add(new StorageVolume
            {
                Letter = letter,
                Label = Short(v.Text("FileSystemLabel")),
                FileSystem = StorageHealth.FileSystemOf(v.Text("FileSystem")),
                SizeBytes = StorageHealth.Count(v.Long("Size")),
                FreeBytes = StorageHealth.Count(v.Long("SizeRemaining")),
                Repair = StorageHealth.RepairOf(v.Long("HealthStatus")),
                Dirty = letter is null ? null : IsDirty(letter),
            });
        }
        return Task.FromResult(new StorageHealthOutput { TakenAt = DateTimeOffset.UtcNow, Drives = drives, Volumes = volumes });
    }

    private static (NvmeHealthInfo?, NvmeProblem?) NvmeHealth(int number)
    {
        using SafeFileHandle h = CreateFileW($@"\\.\PhysicalDrive{number.ToString(CultureInfo.InvariantCulture)}", 0, ShareReadWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
        if (h.IsInvalid) return (null, NvmeProblem.Unreadable);
        byte[] buffer = StorageHealth.NvmeHealthQuery();
        if (!DeviceIoControl(h, IoctlStorageQueryProperty, buffer, buffer.Length, buffer, buffer.Length, out int returned, IntPtr.Zero))
        {
            int error = Marshal.GetLastWin32Error();
            return (null, error is ErrorInvalidFunction or ErrorNotSupported or ErrorInvalidParameter ? NvmeProblem.NotSupported : NvmeProblem.Unreadable);
        }
        return StorageHealth.ReadNvmeAnswer(buffer, returned);
    }

    private static bool? IsDirty(string letter)
    {
        using SafeFileHandle h = CreateFileW($@"\\.\{letter}:", 0, ShareReadWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
        if (h.IsInvalid) return null;
        byte[] answer = new byte[4];
        if (!DeviceIoControl(h, FsctlIsVolumeDirty, null, 0, answer, answer.Length, out int returned, IntPtr.Zero) || returned < 4) return null;
        return (BitConverter.ToUInt32(answer, 0) & 0x1) != 0; // VOLUME_IS_DIRTY
    }

    private static string? Short(string? text) => text is null ? null : EventText.ShortText(text);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(SafeFileHandle device, uint code, byte[]? input, int inputSize, byte[] output, int outputSize, out int returned, IntPtr overlapped);
}
