#Requires -Version 5.1
<#
.SYNOPSIS
Creates only a fresh, empty protected Agent state root under C:\Program Files.
.DESCRIPTION
No enrollment, key, service or Server operation. The caller supplies a GUID; this never adopts
an existing directory. A returned path is only a preparation result, not issuance authority.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')][string]$Id
)
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

public static class FreshAgentRoot
{
    const string Parent = @"C:\Program Files";
    const string TrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    const string SystemSid = "S-1-5-18";
    const string AdminSid = "S-1-5-32-544";
    const int ErrorAlreadyExists = 183;
    const int ErrorFileExists = 80;
    const uint CreateDirectoryAccess = 0x00000002; // FILE_ADD_SUBDIRECTORY
    const uint DeleteAccess = 0x00010000;
    const uint DeleteChildAccess = 0x00000040;
    const uint WriteDac = 0x00040000;
    const uint WriteOwner = 0x00080000;
    const uint GenericWrite = 0x40000000;
    const uint GenericAll = 0x10000000;

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle; }
    [DllImport("kernel32.dll", EntryPoint="CreateDirectoryW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateDirectory(string path, ref SecurityAttributes attributes);

    static void CheckParent()
    {
        foreach (string path in new [] { @"C:\", Parent })
        {
            var info = new DirectoryInfo(path);
            info.Refresh();
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Missing or reparse ancestor: " + path);
            var acl = Directory.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access);
            if (acl.GetOwner(typeof(SecurityIdentifier)).Value != TrustedInstaller || !acl.AreAccessRulesProtected)
                throw new InvalidOperationException("Ancestor owner or DACL protection changed: " + path);
            // C:\ may grant ordinary users add-child, but must not allow deleting or
            // replacing Program Files. Program Files must forbid adding an attacker child.
            uint forbidden = path == Parent
                ? CreateDirectoryAccess | DeleteAccess | DeleteChildAccess | WriteDac | WriteOwner | GenericWrite | GenericAll
                : DeleteChildAccess | WriteDac | WriteOwner | GenericAll;
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow ||
                    (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                string sid = ((SecurityIdentifier)rule.IdentityReference).Value;
                if (sid == SystemSid || sid == AdminSid || sid == TrustedInstaller) continue;
                uint rights = unchecked((uint)rule.FileSystemRights);
                if ((rights & forbidden) != 0)
                    throw new InvalidOperationException("Ancestor grants unsafe rights: " + path + " / " + sid);
            }
        }
    }

    public static string Prepare(string id)
    {
        Guid guid;
        if (!Guid.TryParseExact(id, "D", out guid) || guid == Guid.Empty || id != guid.ToString("D"))
            throw new ArgumentException("Expected a lowercase, nonzero canonical GUID");
        string path = Path.Combine(Parent, "CabinetAgent-Fresh-" + id);
        CheckParent();
        // CREATE_NEW semantics: CreateDirectoryW fails if the final component already exists,
        // including a file, junction or symlink. Never open, overwrite, or adopt that object.
        var security = new DirectorySecurity();
        security.SetSecurityDescriptorSddlForm("O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        IntPtr buffer = Marshal.AllocHGlobal(descriptor.Length);
        try
        {
            Marshal.Copy(descriptor, 0, buffer, descriptor.Length);
            var attrs = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = buffer };
            if (!CreateDirectory(path, ref attrs))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ErrorAlreadyExists || error == ErrorFileExists)
                    throw new IOException("Refusing existing state root (including reparse): " + path);
                throw new System.ComponentModel.Win32Exception(error, "CreateDirectoryW failed");
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
        // Never repair a bad ACL after creation. If verification fails, leave it for operator inspection.
        CheckParent();
        var created = new DirectoryInfo(path);
        created.Refresh();
        if (!created.Exists || (created.Attributes & FileAttributes.ReparsePoint) != 0 ||
            Directory.EnumerateFileSystemEntries(path).Any())
            throw new InvalidOperationException("Created root provenance/emptiness verification failed");
        var actual = Directory.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access);
        if (actual.GetOwner(typeof(SecurityIdentifier)).Value != SystemSid || !actual.AreAccessRulesProtected ||
            actual.GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access) !=
            security.GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access))
            throw new InvalidOperationException("Created root ACL readback differed from requested descriptor");
        return path;
    }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
[FreshAgentRoot]::Prepare($Id)
