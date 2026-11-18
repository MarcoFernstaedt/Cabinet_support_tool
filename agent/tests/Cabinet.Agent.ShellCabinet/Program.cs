// Real Windows enrollment host using the production agent connection, validation, and CNG identity.
// No operation stubs, HTTP handler doubles, executable arguments or server-supplied startup command.
using System.Runtime.Versioning;
using System.Security.Principal;
using System.Security.Cryptography.X509Certificates;
using Cabinet.Agent.Core;
using Cabinet.Agent.Core.Server;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Windows;
[assembly: SupportedOSPlatform("windows")]
if (args.Length != 2) throw new ArgumentException("usage: ShellCabinet <server-uri> <state-directory>");
string state = Path.GetFullPath(args[1]);
var server = new Uri(args[0]);
var config = AgentConfigLoader.Load(Path.Combine(state, "agent-config.json"));
string keyName = "Mashura.ShellAcceptance." + new DirectoryInfo(state).Name;
using var identity = WindowsIdentity.GetCurrent();
CngAgentKeyStore.Provision(identity.User!.Value, keyName);
var keys = new CngAgentKeyStore(keyName);
using var ca = X509Certificate2.CreateFromPem(File.ReadAllText(Path.Combine(state, "platform-ca.pem")));
using var stop = new CancellationTokenSource(TimeSpan.FromMinutes(10));
var watch = Task.Run(async () => {
    while (!stop.IsCancellationRequested) {
        if (File.Exists(Path.Combine(state, "stop"))) { stop.Cancel(); break; }
        await Task.Delay(100);
    }
});
var connection = new AgentConnection(new AgentConnectionOptions {
    ServerUri = server, PlatformCa = ca, Keys = keys, Store = new IdentityStore(state), Config = config,
    ProcessorFor = c => new CommandProcessor(new CommandValidator(c, new ReplayStore(Path.Combine(state, "replay.log"), TimeProvider.System),
        new RateLimiter(null, TimeProvider.System), TimeProvider.System), new OperationRegistry(), TimeProvider.System),
    Fingerprints = () => new EnrollFingerprints { Hostname = Environment.MachineName, SerialNumber = null, MacAddresses = [], ProvisionedClient = null, ProvisionedSite = null,
        OnlineSince = DateTimeOffset.UtcNow, OsVersion = Environment.OSVersion.VersionString, AgentVersion = "0.2.0" },
    AgentVersion = "0.2.0", UptimeSeconds = () => Environment.TickCount64 / 1000,
    Log = message => File.AppendAllText(Path.Combine(state, "agent.log"), message + Environment.NewLine),
    EnrollPollInterval = TimeSpan.FromSeconds(1),
});
try { await connection.RunAsync(stop.Token); }
finally {
    stop.Cancel(); await watch;
    if (File.Exists(Path.Combine(state, "delete-key"))) CngAgentKeyStore.Delete(keyName);
}
