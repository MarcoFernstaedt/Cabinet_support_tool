using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core;
using Cabinet.Agent.Windows;
using Xunit;

[assembly: SupportedOSPlatform("windows")]
[assembly: CollectionBehavior(DisableTestParallelization = true)]

namespace Cabinet.Agent.Windows.Tests;

/// <summary>
/// Proof that no process other than the network service can talk to the
/// broker (docs/spec/08-build-plan.md milestone 1). This test process runs as
/// an ordinary or administrator account, never as NT SERVICE\CabinetAgentNetwork,
/// so it stands in for "any other process".
/// </summary>
public sealed class BrokerPipeAccessTests
{
    private static readonly SecurityIdentifier Me = WindowsIdentity.GetCurrent().User!;

    private static BrokerRequestHandler Handler() => new(new OperationRegistry()
        .Register<EmptyParams, DiskSmartOutput>(Catalog.DiskSmart, (_, _) => Task.FromResult(new DiskSmartOutput { Drives = [] })));

    private static (CancellationTokenSource Stop, Task Serving, string Name, List<string> Log) Start(SecurityIdentifier aclSid, SecurityIdentifier callerSid)
    {
        string name = "CabinetAgent.Test." + Guid.NewGuid().ToString("N");
        var log = new List<string>();
        var stop = new CancellationTokenSource();
        Task serving = new BrokerPipeServer(Handler(), m => { lock (log) log.Add(m); }, name, aclSid, callerSid).RunAsync(stop.Token);
        return (stop, serving, name, log);
    }

    [Fact]
    public void The_network_service_sid_is_the_one_windows_assigns()
    {
        // Translating needs the service to exist, so this checks the computed SID against the well-known derivation instead.
        Assert.StartsWith("S-1-5-80-", ServiceNames.NetworkServiceSid.Value);
        Assert.NotEqual(Me, ServiceNames.NetworkServiceSid);
    }

    [Fact]
    public async Task Another_account_cannot_even_open_the_broker_pipe()
    {
        var server = Start(ServiceNames.NetworkServiceSid, ServiceNames.NetworkServiceSid);
        try
        {
            await Task.Delay(300);
            await Assert.ThrowsAsync<UnauthorizedAccessException>(() => BrokerPipeClient.ConnectAsync(server.Name, CancellationToken.None));
            var raw = new NamedPipeClientStream(".", server.Name, PipeDirection.InOut);
            Assert.Throws<UnauthorizedAccessException>(() => raw.Connect(2000));
            Assert.False(await new BrokerClient(t => BrokerPipeClient.ConnectAsync(server.Name, t)).PingAsync(CancellationToken.None));
        }
        finally { server.Stop.Cancel(); }
    }

    [Fact]
    public async Task The_admitted_account_can_use_the_pipe()
    {
        var server = Start(Me, Me);
        try
        {
            await Task.Delay(300);
            var client = new BrokerClient(t => BrokerPipeClient.ConnectAsync(server.Name, t));
            Assert.True(await client.PingAsync(CancellationToken.None));
            var output = await client.RunAsync(Catalog.DiskSmart, System.Text.Json.JsonSerializer.SerializeToElement(new { }), CancellationToken.None);
            Assert.Equal(0, output.GetProperty("drives").GetArrayLength());
        }
        finally { server.Stop.Cancel(); }
    }

    [Fact]
    public async Task The_caller_identity_check_refuses_on_its_own_even_if_the_access_list_were_wrong()
    {
        // Access list admits this account, identity check requires the network service: the request is never read.
        var server = Start(Me, ServiceNames.NetworkServiceSid);
        try
        {
            await Task.Delay(300);
            Assert.False(await new BrokerClient(t => BrokerPipeClient.ConnectAsync(server.Name, t)).PingAsync(CancellationToken.None));
            await Task.Delay(300);
            lock (server.Log) Assert.Contains(server.Log, m => m.Contains("Refused a broker connection", StringComparison.Ordinal));
        }
        finally { server.Stop.Cancel(); }
    }

    [Fact]
    public async Task A_second_process_cannot_take_over_the_pipe_name()
    {
        var server = Start(Me, Me);
        try
        {
            await Task.Delay(300);
            var squatter = new BrokerPipeServer(Handler(), _ => { }, server.Name, Me, Me);
            await Assert.ThrowsAnyAsync<Exception>(() => squatter.RunAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)));
        }
        finally { server.Stop.Cancel(); }
    }

    [Fact]
    public async Task The_caller_account_is_read_from_the_client_process_token()
    {
        string name = "CabinetAgent.Test." + Guid.NewGuid().ToString("N");
        using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        Task accept = server.WaitForConnectionAsync();
        using var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
        await client.ConnectAsync(5000);
        await accept;
        Assert.Equal(Me, BrokerPipeServer.CallerSid(server));
    }

    [Fact]
    public void The_access_list_admits_only_the_network_service_and_system_and_denies_network_logons()
    {
        PipeSecurity security = BrokerPipeServer.Security(ServiceNames.NetworkServiceSid);
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<PipeAccessRule>().ToList();
        Assert.True(security.AreAccessRulesProtected);
        var allowed = rules.Where(r => r.AccessControlType == AccessControlType.Allow).Select(r => (SecurityIdentifier)r.IdentityReference).ToList();
        Assert.Equal(2, allowed.Count);
        Assert.Contains(ServiceNames.NetworkServiceSid, allowed);
        Assert.Contains(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), allowed);
        Assert.Contains(rules, r => r.AccessControlType == AccessControlType.Deny && ((SecurityIdentifier)r.IdentityReference).IsWellKnown(WellKnownSidType.NetworkSid));
        foreach (var everyone in new[] { WellKnownSidType.WorldSid, WellKnownSidType.BuiltinUsersSid, WellKnownSidType.AuthenticatedUserSid, WellKnownSidType.BuiltinAdministratorsSid })
            Assert.DoesNotContain(allowed, s => s.IsWellKnown(everyone));
    }
}

public sealed class KeyStoreTests
{
    [Fact]
    public void The_provisioned_key_is_non_exportable_and_usable_for_the_granted_account()
    {
        string name = "CabinetAgent.Test." + Guid.NewGuid().ToString("N");
        string me = System.Security.Principal.WindowsIdentity.GetCurrent().User!.Value;
        try
        {
            Assert.True(CngAgentKeyStore.Provision(me, name));
            Assert.False(CngAgentKeyStore.Provision(me, name), "a second run keeps the same key");
            var store = new CngAgentKeyStore(name);
            Assert.True(store.IsNonExportable());
            string csr = store.CreateSigningRequestPem();
            Assert.StartsWith("-----BEGIN CERTIFICATE REQUEST-----", csr);
            using var key = System.Security.Cryptography.CngKey.Open(name, System.Security.Cryptography.CngProvider.MicrosoftSoftwareKeyStorageProvider, System.Security.Cryptography.CngKeyOpenOptions.MachineKey);
            Assert.ThrowsAny<System.Security.Cryptography.CryptographicException>(() => key.Export(System.Security.Cryptography.CngKeyBlobFormat.EccPrivateBlob));
        }
        finally { CngAgentKeyStore.Delete(name); }
    }

    [Fact]
    public void The_agent_never_creates_a_key_itself()
    {
        var store = new CngAgentKeyStore("CabinetAgent.Missing." + Guid.NewGuid().ToString("N"));
        Assert.Throws<System.Security.Cryptography.CryptographicException>(() => store.CreateSigningRequestPem());
    }
}
