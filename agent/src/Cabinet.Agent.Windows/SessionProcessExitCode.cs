using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Cabinet.Agent.Windows;

internal static class SessionProcessExitCode
{
    // -1 is the documented unknown code; STILL_ACTIVE is not an exit code until the handle is signalled.
    internal static int Read(SafeProcessHandle handle)
    {
        try
        {
            return WaitForSingleObject(handle, 0) == 0 && GetExitCodeProcess(handle, out uint code)
                ? unchecked((int)code) : -1;
        }
        catch { return -1; }
    }

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(SafeProcessHandle handle, out uint code);
}
