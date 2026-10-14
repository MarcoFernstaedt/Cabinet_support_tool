using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Core.Packages;

namespace Cabinet.Agent.Windows;

/// <summary>
/// Windows' part of package.install and driver.uninstall: its own trust verification
/// (WinVerifyTrust, without network access or revocation fetching), the certificates in an MSI's
/// signature, and the two installers, pnputil and msiexec, run by full path with fixed arguments.
/// The server cannot add or change any argument.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class PackagePlatform(Action<string> log) : IPackagePlatform
{
    public static readonly TimeSpan InstallTimeout = TimeSpan.FromMinutes(10);

    public void VerifyWithWindows(string path)
    {
        int hr = WinTrust.Verify(path);
        if (hr != 0) throw new PackageRefusedException("signature_invalid", $"Windows did not accept the signature on {Path.GetFileName(path)} (0x{hr:X8}).");
    }

    public (X509Certificate2 Signer, X509Certificate2Collection Certificates) ReadMsiSignature(string path)
    {
        X509Certificate2 signer;
        try
        {
#pragma warning disable SYSLIB0057 // the only managed way to read an Authenticode signer; the trust decision is made separately
            signer = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
#pragma warning restore SYSLIB0057
        }
        catch (System.Security.Cryptography.CryptographicException) { throw new PackageRefusedException("signature_invalid", "The installer is not signed."); }
        return (signer, WinTrust.EmbeddedCertificates(path));
    }

    public (bool Installed, long ExitCode, bool RebootRequired) InstallDriver(IReadOnlyList<string> infPaths)
    {
        long last = 0;
        bool reboot = false;
        foreach (string inf in infPaths)
        {
            var r = ExternalProgram.Run("pnputil.exe", ["/add-driver", inf, "/install"], InstallTimeout);
            log($"pnputil /add-driver {Path.GetFileName(inf)}: exit code {r.ExitCode}.");
            // 0: added (and installed on matching devices); 259: added, no device needed it now; 3010: a restart finishes it.
            if (r.ExitCode is not (0 or 259 or 3010)) return (false, r.ExitCode, false);
            reboot |= r.ExitCode == 3010;
            last = r.ExitCode;
        }
        return (true, last, reboot);
    }

    public (bool Installed, long ExitCode, bool RebootRequired) InstallMsi(string msiPath)
    {
        // Fixed silent-install arguments; nothing from the server reaches this list.
        var r = ExternalProgram.Run("msiexec.exe", ["/i", msiPath, "/qn", "/norestart"], InstallTimeout);
        log($"msiexec /i: exit code {r.ExitCode}.");
        return (r.ExitCode is 0 or 3010 or 1641, r.ExitCode, r.ExitCode is 3010 or 1641);
    }

    public (bool Removed, bool RebootRequired) UninstallDriver(string publishedName)
    {
        var r = ExternalProgram.Run("pnputil.exe", ["/delete-driver", publishedName, "/uninstall"], InstallTimeout);
        log($"pnputil /delete-driver {publishedName}: exit code {r.ExitCode}.");
        return (r.ExitCode is 0 or 3010, r.ExitCode == 3010);
    }

    /// <summary>wusa.exe /uninstall /kb:NNN /quiet /norestart: fixed arguments, the KB digits already checked, and never a restart.</summary>
    public (bool Removed, bool RebootRequired) UninstallUpdate(string kb)
    {
        var r = ExternalProgram.Run("wusa.exe", ["/uninstall", "/kb:" + kb[2..], "/quiet", "/norestart"], InstallTimeout);
        log($"wusa /uninstall {kb}: exit code {r.ExitCode}.");
        return (r.ExitCode is 0 or 3010, r.ExitCode == 3010);
    }
}

/// <summary>WinVerifyTrust and CryptQueryObject, the Windows trust APIs, declared by hand.</summary>
[SupportedOSPlatform("windows")]
internal static class WinTrust
{
    private static readonly Guid GenericVerifyV2 = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    private const uint WTD_UI_NONE = 2, WTD_REVOKE_NONE = 0, WTD_CHOICE_FILE = 1, WTD_STATEACTION_VERIFY = 1, WTD_STATEACTION_CLOSE = 2;
    private const uint WTD_REVOCATION_CHECK_NONE = 0x10, WTD_CACHE_ONLY_URL_RETRIEVAL = 0x1000, WTD_DISABLE_MD2_MD4 = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo
    {
        public uint cbStruct;
        public IntPtr pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Data
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        public IntPtr pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }

    [DllImport("wintrust.dll", ExactSpelling = true)]
    private static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref Data data);

    /// <returns>0 when Windows trusts the file's signature; otherwise the error code.</returns>
    public static int Verify(string path)
    {
        IntPtr pathPtr = Marshal.StringToCoTaskMemUni(path);
        var file = new FileInfo { cbStruct = (uint)Marshal.SizeOf<FileInfo>(), pcwszFilePath = pathPtr };
        IntPtr filePtr = Marshal.AllocCoTaskMem(Marshal.SizeOf<FileInfo>());
        try
        {
            Marshal.StructureToPtr(file, filePtr, false);
            var data = new Data
            {
                cbStruct = (uint)Marshal.SizeOf<Data>(), dwUIChoice = WTD_UI_NONE, fdwRevocationChecks = WTD_REVOKE_NONE, dwUnionChoice = WTD_CHOICE_FILE,
                pFile = filePtr, dwStateAction = WTD_STATEACTION_VERIFY,
                // No network: the broker never opens a connection, and revocation lists are not fetched.
                dwProvFlags = WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_DISABLE_MD2_MD4,
            };
            Guid action = GenericVerifyV2;
            int result = WinVerifyTrust(IntPtr.Zero, ref action, ref data);
            data.dwStateAction = WTD_STATEACTION_CLOSE;
            WinVerifyTrust(IntPtr.Zero, ref action, ref data);
            return result;
        }
        finally
        {
            Marshal.FreeCoTaskMem(filePtr);
            Marshal.FreeCoTaskMem(pathPtr);
        }
    }

    private const int CERT_QUERY_OBJECT_FILE = 1, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED = 1 << 10, CERT_QUERY_FORMAT_FLAG_BINARY = 1 << 1;

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptQueryObject(int objectType, string obj, int contentTypes, int formatTypes, int flags,
        out int encoding, out int contentType, out int formatType, out IntPtr certStore, out IntPtr msg, IntPtr context);

    [DllImport("crypt32.dll")] private static extern bool CryptMsgClose(IntPtr msg);
    [DllImport("crypt32.dll")] private static extern bool CertCloseStore(IntPtr store, uint flags);

    /// <summary>Every certificate carried in a file's embedded Authenticode signature (for building the signer's chain offline).</summary>
    public static X509Certificate2Collection EmbeddedCertificates(string path)
    {
        if (!CryptQueryObject(CERT_QUERY_OBJECT_FILE, path, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED, CERT_QUERY_FORMAT_FLAG_BINARY, 0,
                out _, out _, out _, out IntPtr store, out IntPtr msg, IntPtr.Zero))
            throw new PackageRefusedException("signature_invalid", "The installer has no readable signature.");
        try
        {
            using var s = new X509Store(store);
            var all = new X509Certificate2Collection();
            foreach (X509Certificate2 c in s.Certificates) all.Add(X509CertificateLoader.LoadCertificate(c.RawData));
            return all;
        }
        finally
        {
            CryptMsgClose(msg);
            CertCloseStore(store, 0);
        }
    }
}
