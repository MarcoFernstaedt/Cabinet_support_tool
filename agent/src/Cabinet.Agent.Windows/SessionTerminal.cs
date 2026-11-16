using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Cabinet.Agent.Core.Server;
using Microsoft.Win32.SafeHandles;

namespace Cabinet.Agent.Windows;

/// <summary>Development-only cmd.exe process in a Windows pseudoconsole, including terminal resize.</summary>
[SupportedOSPlatform("windows")]
public sealed class SessionTerminal : ISessionTerminal
{
    private IntPtr _console;
    private readonly Process _process;
    private readonly SafeProcessHandle _processHandle;
    private Task? _consoleCloser;
    private readonly object _closeGate = new();
    private bool _disposed;
    public Stream Input { get; }
    public Stream Output { get; }
    public bool HasExited {
        get {
            bool exited = _process.HasExited;
            if (exited) CloseConsole();
            return exited;
        }
    }
    public int ExitCode => SessionProcessExitCode.Read(_processHandle);

    public SessionTerminal()
    {
        IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        ProcessInfo process = default;
        bool attributesInitialized = false;
        try
        {
            Check(CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0));
            Check(CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0));
            Marshal.ThrowExceptionForHR(CreatePseudoConsole(new Coord(120, 30), inputRead, outputWrite, 0, out _console));
            CloseHandle(inputRead); inputRead = IntPtr.Zero;
            CloseHandle(outputWrite); outputWrite = IntPtr.Zero;
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
            attributesInitialized = true;
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x00020016, _console, IntPtr.Size, IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupInfoEx { Info = new StartupInfo { Size = Marshal.SizeOf<StartupInfoEx>() }, Attributes = attributes };
            // Locally chosen executable and fixed switches. /D disables registry AutoRun; no /C or server command string.
            string executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
            Check(CreateProcess(executable, new StringBuilder("cmd.exe /D /Q"), IntPtr.Zero, IntPtr.Zero, false,
                0x00080000, IntPtr.Zero, Environment.GetFolderPath(Environment.SpecialFolder.Windows), ref startup, out process));
            _process = Process.GetProcessById(process.ProcessId);
            _processHandle = new SafeProcessHandle(process.Process, ownsHandle: true);
            process.Process = IntPtr.Zero;
            Input = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write, 4096, false); inputWrite = IntPtr.Zero;
            Output = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read, 4096, false); outputRead = IntPtr.Zero;
        }
        catch
        {
            if (process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
            if (_processHandle is not null) { TerminateProcess(_processHandle.DangerousGetHandle(), 1); _processHandle.Dispose(); }
            if (_console != IntPtr.Zero) { ClosePseudoConsole(_console); _console = IntPtr.Zero; }
            throw;
        }
        finally
        {
            foreach (IntPtr handle in new[] { inputRead, inputWrite, outputRead, outputWrite, process.Thread, process.Process })
                if (handle != IntPtr.Zero) CloseHandle(handle);
            if (attributes != IntPtr.Zero) { if (attributesInitialized) DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
        }
    }

    public void Resize(short columns, short rows)
    {
        if (columns is < 1 or > 500 || rows is < 1 or > 300) throw new ArgumentOutOfRangeException(nameof(columns));
        Marshal.ThrowExceptionForHR(ResizePseudoConsole(_console, new Coord(columns, rows)));
    }

    public void Terminate() { if (!_process.HasExited) _process.Kill(entireProcessTree: true); }

    // Close on another thread: ConPTY waits for output to drain, while session polling drains its bounded queue.
    private Task CloseConsole()
    {
        lock (_closeGate)
        {
            return _consoleCloser ??= Task.Run(() => {
                IntPtr console = Interlocked.Exchange(ref _console, IntPtr.Zero);
                if (console != IntPtr.Zero) ClosePseudoConsole(console);
            });
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { if (!_process.HasExited) _process.Kill(entireProcessTree: true); }
        finally
        {
            Input.Dispose();
            // Output continues draining while ClosePseudoConsole joins its writer.
            CloseConsole().GetAwaiter().GetResult();
            Output.Dispose(); _process.Dispose(); _processHandle.Dispose();
        }
    }

    private static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    [StructLayout(LayoutKind.Sequential)] private readonly struct Coord(short x, short y) { public readonly short X = x; public readonly short Y = y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        public int Size; public string? Reserved; public string? Desktop; public string? Title;
        public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr security, int size);
    [DllImport("kernel32.dll")] private static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, int flags, out IntPtr console);
    [DllImport("kernel32.dll")] private static extern int ResizePseudoConsole(IntPtr console, Coord size);
    [DllImport("kernel32.dll")] private static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity,
        [MarshalAs(UnmanagedType.Bool)] bool inherit, int flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateProcess(IntPtr handle, uint exit);
}
