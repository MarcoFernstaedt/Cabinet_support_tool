// Read-only x64 launch inspection. No process writes, execution or credential output.
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class CabinetRecoveryProcess {
    [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr exit, peb, affinity, priority, id, parent; }
    [StructLayout(LayoutKind.Sequential)] struct Memory { public IntPtr address, allocation; public uint protect; public UIntPtr size; public uint state, protection, type; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process(IntPtr handle, out bool wow);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] bytes, int length, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr handle, IntPtr address, out Memory info, UIntPtr size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref uint length);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, out Basic info, int size, out int returned);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    static void Check(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static byte[] Bytes(IntPtr h, IntPtr address, int length) {
        if (address == IntPtr.Zero || length < 0 || length > 1048576) throw new InvalidOperationException("Invalid process buffer");
        byte[] b = new byte[length]; IntPtr read;
        Check(ReadProcessMemory(h, address, b, length, out read));
        if (read.ToInt64() != length) throw new InvalidOperationException("Incomplete process read");
        return b;
    }
    static IntPtr Pointer(IntPtr h, IntPtr address) { return new IntPtr(BitConverter.ToInt64(Bytes(h,address,8),0)); }
    static string Unicode(IntPtr h, IntPtr address) {
        byte[] s=Bytes(h,address,16); int length=BitConverter.ToUInt16(s,0);
        if ((length & 1)!=0) throw new InvalidOperationException("Invalid process string");
        return Encoding.Unicode.GetString(Bytes(h,new IntPtr(BitConverter.ToInt64(s,8)),length));
    }
    public sealed class Launch {
        public string Image, CommandLine, Directory, UserSid;
        public Dictionary<string,string> Environment = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    }
    public static string Image(int id) {
        IntPtr h=OpenProcess(0x1000,false,id);
        if(h==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { var image=new StringBuilder(32768); uint count=32768; Check(QueryFullProcessImageName(h,0,image,ref count)); return image.ToString(); }
        finally { CloseHandle(h); }
    }
    public static Launch Read(int id) {
        if (IntPtr.Size!=8) throw new InvalidOperationException("64-bit PowerShell required");
        // Read only targets accessible with the inspector's existing token.
        // A denied OpenProcess is a refusal, never a reason to change privileges.
            IntPtr h=OpenProcess(0x410,false,id);
            if(h==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                bool wow; Check(IsWow64Process(h,out wow)); if(wow) throw new InvalidOperationException("x86 target unsupported");
                Basic basic; int size;
                if(NtQueryInformationProcess(h,0,out basic,Marshal.SizeOf(typeof(Basic)),out size)!=0) throw new InvalidOperationException("Process layout unavailable");
                // Native x64 PEB.ProcessParameters and RTL_USER_PROCESS_PARAMETERS offsets.
                // These are OS implementation details, bounded and validated, not a public environment API.
                IntPtr parameters=Pointer(h,IntPtr.Add(basic.peb,0x20));
                Launch result=new Launch(); var image=new StringBuilder(32768); uint count=32768;
                Check(QueryFullProcessImageName(h,0,image,ref count)); result.Image=image.ToString();
                string parameterImage=Unicode(h,IntPtr.Add(parameters,0x60));
                if(!String.Equals(result.Image,parameterImage,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Process image disagreement");
                result.CommandLine=Unicode(h,IntPtr.Add(parameters,0x70));
                result.Directory=Unicode(h,IntPtr.Add(parameters,0x38));
                IntPtr owner; Check(OpenProcessToken(h,8,out owner));
                try { using(var identity=new WindowsIdentity(owner)) result.UserSid=identity.User.Value; }
                finally { CloseHandle(owner); }
                IntPtr environment=Pointer(h,IntPtr.Add(parameters,0x80)); Memory memory;
                if(VirtualQueryEx(h,environment,out memory,new UIntPtr((uint)Marshal.SizeOf(typeof(Memory))))==UIntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                long available=memory.size.ToUInt64() > Int64.MaxValue ? 0 : (long)memory.size.ToUInt64()-(environment.ToInt64()-memory.address.ToInt64());
                int limit=(int)Math.Min(available,1048576); limit-=limit%2;
                string block=Encoding.Unicode.GetString(Bytes(h,environment,limit)); int end=block.IndexOf("\0\0",StringComparison.Ordinal);
                if(end<0) throw new InvalidOperationException("Unterminated environment");
                foreach(string entry in block.Substring(0,end).Split('\0')) {
                    int split=entry.IndexOf('=',entry.StartsWith("=",StringComparison.Ordinal)?1:0);
                    if(split<1) throw new InvalidOperationException("Invalid environment entry");
                    result.Environment.Add(entry.Substring(0,split),entry.Substring(split+1));
                }
                return result;
            } finally { CloseHandle(h); }
    }
}
