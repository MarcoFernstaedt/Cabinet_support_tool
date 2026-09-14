using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using CabinetPlatform.Contracts.Actions;
using Microsoft.Win32.SafeHandles;

namespace CabinetPlatform.Agent.Platform;

/// <summary>Windows process-object binding. No PID lookup occurs after OpenProcess.</summary>
internal sealed class WindowsSelectedProcessHandleFactory : ISelectedProcessHandleFactory, IProcessObservationHandleFactory
{
    // Read-only discovery must not require termination rights on a diagnostic target.
    public IProcessObservationHandle OpenRead(int processId) => OpenHandle(processId, 0x00001000);

    public ISelectedProcessHandle Open(int processId) => OpenHandle(processId, 0x00101001);

    private static BoundHandle OpenHandle(int processId, uint access)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("Process handle inspection requires Windows.");
        }

        SafeProcessHandle handle = Native.OpenProcess(access, false, processId);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return new BoundHandle(processId, handle);
    }

    private sealed class BoundHandle(int processId, SafeProcessHandle handle) : ISelectedProcessHandle, IProcessObservationHandle
    {
        public ProcessSelectionIdentity Identity
        {
            get
            {
                if (!Native.GetProcessTimes(handle, out long creation, out _, out _, out _))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                var path = new StringBuilder(32768);
                int length = path.Capacity;
                if (!Native.QueryFullProcessImageName(handle, 0, path, ref length))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                string executable = path.ToString();
                return new ProcessSelectionIdentity
                {
                    ProcessId = processId,
                    ProcessName = Path.GetFileNameWithoutExtension(executable),
                    CreationTimeFileTime = creation,
                    ExecutablePath = executable,
                };
            }
        }

        public bool IsCritical
        {
            get
            {
                if (!Native.IsProcessCritical(handle, out bool critical))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return critical;
            }
        }

        public void Terminate()
        {
            if (!Native.TerminateProcess(handle, 1))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        public bool WaitForExit(TimeSpan timeout)
        {
            uint result = Native.WaitForSingleObject(handle, checked((uint)timeout.TotalMilliseconds));
            return result switch
            {
                0 => true,
                258 => false,
                _ => throw new Win32Exception(Marshal.GetLastWin32Error()),
            };
        }

        public void Dispose() => handle.Dispose();
    }

    private static class Native
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);

        [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryFullProcessImageName(SafeProcessHandle process, int flags, StringBuilder path, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool IsProcessCritical(SafeProcessHandle process, [MarshalAs(UnmanagedType.Bool)] out bool critical);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    }
}
