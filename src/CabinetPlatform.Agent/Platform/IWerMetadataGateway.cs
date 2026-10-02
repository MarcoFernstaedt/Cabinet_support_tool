using System.Runtime.InteropServices;
using System.Diagnostics;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Native-only fields; never serialize this type or report keys.</summary>
public sealed record NativeWerMetadata(Guid ReportId, DateTimeOffset CreatedUtc, string EventName);

public interface IWerMetadataGateway
{
    IEnumerable<NativeWerMetadata> Enumerate(WerStore store, CancellationToken cancellationToken);
}

internal interface IWerNativeOperations
{
    IntPtr Open(WerStore store);
    void Close(IntPtr handle);
    string? First(IntPtr handle);
    string? Next(IntPtr handle, string key);
    NativeWerMetadata Query(IntPtr handle, string key, Func<bool> deadlineReached);
}

/// <summary>Wer.dll machine store enumeration. Windows 10 1703+; synchronous calls have no hard timeout.</summary>
public sealed class WindowsWerMetadataGateway : IWerMetadataGateway
{
    private readonly IWerNativeOperations native;
    private readonly Func<bool>? deadlineReached;
    public WindowsWerMetadataGateway() : this(new NativeOperations()) { }
    internal WindowsWerMetadataGateway(IWerNativeOperations native) => this.native = native;
    internal WindowsWerMetadataGateway(IWerNativeOperations native, Func<bool> deadlineReached)
    { this.native = native; this.deadlineReached = deadlineReached; }
    private const int NoMoreFiles = unchecked((int)0x80070012); // HRESULT_FROM_WIN32(ERROR_NO_MORE_FILES)
    private const int InsufficientBuffer = unchecked((int)0x8007007A);
    private const int AccessDenied = unchecked((int)0x80070005);
    private const int MaxKeyCharacters = 1024;
    private const int MaxFileNameUnits = 4096;

    public IEnumerable<NativeWerMetadata> Enumerate(WerStore store, CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows() && native is NativeOperations) throw new PlatformNotSupportedException();
        if (store is not (WerStore.MachineQueue or WerStore.MachineArchive)) throw new ArgumentOutOfRangeException(nameof(store));
        ValidateLayout();
        cancellationToken.ThrowIfCancellationRequested();
        var elapsed = Stopwatch.StartNew();
        bool DeadlineReached() => elapsed.Elapsed >= TimeSpan.FromSeconds(3) || deadlineReached?.Invoke() == true;
        var handle = native.Open(store);
        if (handle == IntPtr.Zero) throw new InvalidOperationException("WER store unavailable.");
        try
        {
            if (DeadlineReached()) throw new TimeoutException("WER metadata read limit reached.");
            string? key = native.First(handle);
            for (int count = 0; count < 128 && key is not null; count++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (DeadlineReached())
                    throw new TimeoutException("WER metadata read limit reached.");
                var metadata = native.Query(handle, key, DeadlineReached);
                yield return metadata;
                cancellationToken.ThrowIfCancellationRequested();
                if (count < 127)
                {
                    if (DeadlineReached()) throw new TimeoutException("WER metadata read limit reached.");
                    key = native.Next(handle, key);
                }
            }
        }
        finally { native.Close(handle); }
    }

    private sealed class NativeOperations : IWerNativeOperations
    {
        public IntPtr Open(WerStore store) { Check(WerStoreOpen((int)store, out var handle)); return handle; }
        public void Close(IntPtr handle) => WerStoreClose(handle);
        public string? First(IntPtr handle) => Key(WerStoreGetFirstReportKey(handle, out var pointer), pointer);
        public string? Next(IntPtr handle, string key) => Key(WerStoreGetNextReportKey(handle, out var pointer), pointer);
        public NativeWerMetadata Query(IntPtr handle, string key, Func<bool> deadlineReached) => ReadMetadata(handle, key, deadlineReached);
        private static string? Key(int hr, IntPtr pointer)
        {
            if (hr == NoMoreFiles) return null;
            Check(hr);
            return CopyBoundedKey(pointer);
        }
    }

    private static NativeWerMetadata ReadMetadata(IntPtr handle, string key, Func<bool> deadlineReached)
    {
        var buffer = Marshal.AllocHGlobal(Marshal.SizeOf<WerMetadataV2>());
        IntPtr names = IntPtr.Zero;
        int allocatedNameBytes = 0;
        try
        {
            // Initial query: no file-name allocation. Only if required, allocate a capped
            // throwaway buffer. Documentation inconsistently describes SizeOfFileNames as
            // bytes and WCHAR units; allocate twice the stated count, never read its contents.
            for (int i = 0; i < Marshal.SizeOf<WerMetadataV2>(); i++) Marshal.WriteByte(buffer, i, 0);
            int hr = WerStoreQueryReportMetadataV2(handle, key, buffer);
            if (hr == InsufficientBuffer)
            {
                int required = Marshal.ReadInt32(buffer, (int)Marshal.OffsetOf<WerMetadataV2>(nameof(WerMetadataV2.SizeOfFileNames)));
                if (required <= 0 || required > MaxFileNameUnits) throw new InvalidOperationException("WER metadata filename buffer limit exceeded.");
                allocatedNameBytes = checked(required * sizeof(char));
                names = Marshal.AllocHGlobal(allocatedNameBytes);
                Marshal.WriteIntPtr(buffer, (int)Marshal.OffsetOf<WerMetadataV2>(nameof(WerMetadataV2.FileNames)), names);
                if (deadlineReached()) throw new TimeoutException("WER metadata read limit reached.");
                hr = WerStoreQueryReportMetadataV2(handle, key, buffer);
            }
            Check(hr);
            // Read only the event-name prefix, GUID and FILETIME by verified offsets.
            // Do not marshal signature parameters, filenames, bucket, CAB id or keys.
            var eventName = Marshal.PtrToStringUni(buffer, 65)!.Split('\0')[0];
            var reportId = Marshal.PtrToStructure<Guid>(IntPtr.Add(buffer, 7928));
            var fileTime = Marshal.ReadInt64(buffer, 7944);
            DateTimeOffset created;
            try { created = new DateTimeOffset(DateTime.FromFileTimeUtc(fileTime)); }
            catch (ArgumentOutOfRangeException) { created = DateTimeOffset.MinValue; }
            return new NativeWerMetadata(reportId, created, eventName);
        }
        finally
        {
            // Native metadata includes signature parameters and filenames; clear before release.
            if (names != IntPtr.Zero)
            {
                for (int i = 0; i < allocatedNameBytes; i++) Marshal.WriteByte(names, i, 0);
                Marshal.FreeHGlobal(names);
            }
            for (int i = 0; i < Marshal.SizeOf<WerMetadataV2>(); i++) Marshal.WriteByte(buffer, i, 0);
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string CopyBoundedKey(IntPtr pointer)
    {
        if (pointer == IntPtr.Zero) throw new InvalidOperationException("Missing WER report key.");
        for (int i = 0; i < MaxKeyCharacters; i++)
            if (Marshal.ReadInt16(pointer, i * 2) == 0)
                return Marshal.PtrToStringUni(pointer, i) ?? throw new InvalidOperationException("Missing WER report key.");
        throw new InvalidOperationException("WER report key limit exceeded.");
    }

    private static void Check(int hr)
    {
        if (hr == 0) return;
        if (hr == AccessDenied) throw new UnauthorizedAccessException();
        // Never return or log native error messages or report keys.
        throw new InvalidOperationException("WER store read failed.");
    }

    /// <summary>Fail closed on an ABI mismatch. Expected offsets from werapi.h with default packing.</summary>
    public static void ValidateLayout()
    {
        int pointerOffset = IntPtr.Size == 8 ? 8512 : 8508;
        int size = IntPtr.Size == 8 ? 8520 : 8512;
        if (Marshal.SizeOf<WerMetadataV2>() != size ||
            Marshal.OffsetOf<WerMetadataV2>(nameof(WerMetadataV2.ReportId)).ToInt32() != 7928 ||
            Marshal.OffsetOf<WerMetadataV2>(nameof(WerMetadataV2.CreationTime)).ToInt32() != 7944 ||
            Marshal.OffsetOf<WerMetadataV2>(nameof(WerMetadataV2.SizeOfFileNames)).ToInt32() != 8504 ||
            Marshal.OffsetOf<WerMetadataV2>(nameof(WerMetadataV2.FileNames)).ToInt32() != pointerOffset)
            throw new PlatformNotSupportedException("WER metadata ABI mismatch.");
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WerParameter
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 129)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Value;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WerSignature
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 65)] public string EventName;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 10)] public WerParameter[] Parameters;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WerMetadataV2
    {
        public WerSignature Signature;
        public Guid BucketId;
        public Guid ReportId;
        public long CreationTime;
        public ulong SizeInBytes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string CabId;
        public uint ReportStatus;
        public Guid ReportIntegratorId;
        public uint NumberOfFiles;
        public uint SizeOfFileNames;
        public IntPtr FileNames;
    }

    [DllImport("wer.dll", ExactSpelling = true)]
    private static extern int WerStoreOpen(int storeType, out IntPtr handle);
    [DllImport("wer.dll", ExactSpelling = true)]
    private static extern void WerStoreClose(IntPtr handle);
    [DllImport("wer.dll", ExactSpelling = true)]
    private static extern int WerStoreGetFirstReportKey(IntPtr handle, out IntPtr reportKey);
    [DllImport("wer.dll", ExactSpelling = true)]
    private static extern int WerStoreGetNextReportKey(IntPtr handle, out IntPtr reportKey);
    [DllImport("wer.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int WerStoreQueryReportMetadataV2(IntPtr handle, string reportKey, IntPtr metadata);
}
