using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Windows;

/// <summary>The two services' names. The network service's account is its virtual account, NT SERVICE\CabinetAgentNetwork.</summary>
public static class ServiceNames
{
    public const string Broker = "CabinetAgentBroker";
    public const string Network = "CabinetAgentNetwork";

    /// <summary>The only account the broker pipe admits.</summary>
    public static SecurityIdentifier NetworkServiceSid { get; } = new(ServiceSid.For(Network));
}

/// <summary>
/// The broker's end of the local pipe. Three locks, each enough alone:
/// the pipe's access list admits only the network service's account (and
/// SYSTEM, which owns it) and denies network logons; every connection's
/// caller process is checked again by its token's account before a byte is read; and every
/// request is validated by <see cref="BrokerRequestHandler"/>.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class BrokerPipeServer
{
    private readonly BrokerRequestHandler _handler;
    private readonly SecurityIdentifier _aclSid;
    private readonly SecurityIdentifier _callerSid;
    private readonly string _pipeName;
    private readonly Action<string> _log;

    public BrokerPipeServer(BrokerRequestHandler handler, Action<string> log)
        : this(handler, log, BrokerFraming.PipeName, ServiceNames.NetworkServiceSid, ServiceNames.NetworkServiceSid) { }

    /// <param name="aclSid">The account the pipe's access list admits.</param>
    /// <param name="callerSid">The account each caller must prove to be. Separate only so tests can show each lock works alone.</param>
    internal BrokerPipeServer(BrokerRequestHandler handler, Action<string> log, string pipeName, SecurityIdentifier aclSid, SecurityIdentifier callerSid)
    {
        _handler = handler;
        _log = log;
        _pipeName = pipeName;
        _aclSid = aclSid;
        _callerSid = callerSid;
    }

    public static PipeSecurity Security(SecurityIdentifier allowed)
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(allowed, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        return security;
    }

    public const int Instances = 4;

    /// <summary>Serves until cancelled, with up to four connections at once.</summary>
    public Task RunAsync(CancellationToken token)
    {
        PipeSecurity security = Security(_aclSid);
        // The first instance is created with FirstPipeInstance, so the broker refuses to start if anything else already owns the name.
        NamedPipeServerStream first = Create(security, firstInstance: true);
        return Task.WhenAll(Enumerable.Range(0, Instances).Select(i => Task.Run(() => ServeLoopAsync(i == 0 ? first : null, security, token), token)));
    }

    private NamedPipeServerStream Create(PipeSecurity security, bool firstInstance) =>
        NamedPipeServerStreamAcl.Create(_pipeName, PipeDirection.InOut, Instances, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | (firstInstance ? PipeOptions.FirstPipeInstance : PipeOptions.None), 0, 0, security);

    private async Task ServeLoopAsync(NamedPipeServerStream? initial, PipeSecurity security, CancellationToken token)
    {
        NamedPipeServerStream? next = initial;
        while (!token.IsCancellationRequested)
        {
            await using NamedPipeServerStream pipe = next ?? Create(security, firstInstance: false);
            next = null;
            try
            {
                await pipe.WaitForConnectionAsync(token).ConfigureAwait(false);
                if (!CallerIsAllowed(pipe))
                {
                    _log("Refused a broker connection from an account other than the network service.");
                    continue;
                }
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                timeout.CancelAfter(TimeSpan.FromMinutes(2));
                byte[]? request = await BrokerFraming.ReadAsync(pipe, BrokerFraming.MaxRequestBytes, timeout.Token).ConfigureAwait(false);
                if (request is null) continue;
                byte[]? response = await _handler.HandleAsync(request, timeout.Token).ConfigureAwait(false);
                if (response is not null) await BrokerFraming.WriteAsync(pipe, response, timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception e) when (e is IOException or OperationCanceledException or UnauthorizedAccessException)
            {
                _log($"A broker connection ended early ({e.GetType().Name}).");
            }
        }
    }

    /// <summary>
    /// Reads the connected caller's account from its process token: the
    /// client process ID comes from the pipe itself, and the broker (SYSTEM)
    /// opens that process's token for query only. No impersonation is used.
    /// </summary>
    private bool CallerIsAllowed(NamedPipeServerStream pipe)
    {
        SecurityIdentifier? caller = CallerSid(pipe);
        if (caller is not null && caller.Equals(_callerSid)) return true;
        _log($"Caller account was {(caller?.Value ?? "unreadable")}.");
        return false;
    }

    internal static SecurityIdentifier? CallerSid(NamedPipeServerStream pipe)
    {
        if (!NativeMethods.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out uint pid)) return null;
        using Microsoft.Win32.SafeHandles.SafeProcessHandle process = NativeMethods.OpenProcess(NativeMethods.ProcessQueryLimitedInformation, false, pid);
        if (process.IsInvalid) return null;
        if (!NativeMethods.OpenProcessToken(process, NativeMethods.TokenQuery, out Microsoft.Win32.SafeHandles.SafeAccessTokenHandle token)) return null;
        using (token)
        using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
            return identity.User;
    }
}

internal static class NativeMethods
{
    public const uint ProcessQueryLimitedInformation = 0x1000;
    public const uint TokenQuery = 0x0008;

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    public static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint clientProcessId);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    public static extern Microsoft.Win32.SafeHandles.SafeProcessHandle OpenProcess(uint access, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)] bool inherit, uint processId);

    [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    public static extern bool OpenProcessToken(Microsoft.Win32.SafeHandles.SafeProcessHandle process, uint access, out Microsoft.Win32.SafeHandles.SafeAccessTokenHandle token);
}

/// <summary>The network process's end: connects with identification-level impersonation only, and checks the pipe is owned by SYSTEM or Administrators so a squatting process cannot pose as the broker.</summary>
[SupportedOSPlatform("windows")]
public static class BrokerPipeClient
{
    public static BrokerClient Create(string pipeName = BrokerFraming.PipeName) => new(token => ConnectAsync(pipeName, token));

    public static async Task<Stream> ConnectAsync(string pipeName, CancellationToken token)
    {
        var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
        try
        {
            await pipe.ConnectAsync(5000, token).ConfigureAwait(false);
            var owner = pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            if (owner is null || !(owner.IsWellKnown(WellKnownSidType.LocalSystemSid) || owner.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid)))
                throw new UnauthorizedAccessException("The broker pipe is not owned by SYSTEM or Administrators.");
            return pipe;
        }
        catch
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }
}
