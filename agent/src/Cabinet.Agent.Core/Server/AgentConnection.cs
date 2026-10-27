using System.Net;
using System.Net.NetworkInformation;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Threading.Channels;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Core.Server;

public sealed class AgentConnectionOptions
{
    public required Uri ServerUri { get; init; }
    public required X509Certificate2 PlatformCa { get; init; }
    public required IAgentKeyStore Keys { get; init; }
    public required IdentityStore Store { get; init; }
    public required AgentConfig Config { get; init; }
    /// <summary>Builds the command processor for the enrolled cabinet ID (the validator's step 2 checks it).</summary>
    public required Func<AgentConfig, CommandProcessor> ProcessorFor { get; init; }
    public required Func<EnrollFingerprints> Fingerprints { get; init; }
    public required string AgentVersion { get; init; }
    public required Func<long> UptimeSeconds { get; init; }
    public required Action<string> Log { get; init; }
    /// <summary>Events from the background monitors, waiting to be sent.</summary>
    public EventQueue? Events { get; init; }
    /// <summary>Settings the server sends with each heartbeat answer, kept for the monitors.</summary>
    public MonitorSettings? Settings { get; init; }
    /// <summary>Configuration snapshots (changed categories only) waiting to be sent.</summary>
    public Cabinet.Agent.Core.Configuration.ConfigQueue? ConfigUploads { get; init; }
    public TimeSpan ConfigSendInterval { get; init; } = TimeSpan.FromSeconds(20);
    public TimeSpan EventSendInterval { get; init; } = TimeSpan.FromSeconds(15);
    /// <summary>Downloads packages for package.install while online.</summary>
    public Packages.PackageDownloads? Packages { get; init; }
    /// <summary>Check-ins, upgrade offers and upgrade reports, handled after each heartbeat that reaches the server.</summary>
    public Upgrades.UpgradeCoordinator? Upgrades { get; init; }
    /// <summary>Each firewall profile's on/off state for the heartbeat (from the firewall watcher), so the server can compare it with the client's policy.</summary>
    public Func<FirewallProfileSwitches?>? FirewallProfiles { get; init; }
    /// <summary>The cabinet's Windows time zone ID, compared by the server with its site's zone. Null when it cannot be read or is not a reportable ID.</summary>
    public Func<string?>? TimeZoneId { get; init; }
    /// <summary>A small load sample sent with each heartbeat, or null when none can be taken yet.</summary>
    public Func<HealthSample?>? Health { get; init; }
    /// <summary>Called with the sample after the server accepted the heartbeat that carried it.</summary>
    public Action<HealthSample>? HealthSent { get; init; }
    /// <summary>Tells the broker the server was reached after a safety-net change; null when this agent makes no changes.</summary>
    public Func<Guid, CancellationToken, Task<SafetyNetStatus>>? ConfirmSafetyNet { get; init; }
    /// <summary>Called after every successful write (the firewall change detector looks at once, to attribute it).</summary>
    public Action? AfterWrite { get; init; }
    /// <summary>The result outbox folder; by default "results" in the state folder that holds the identity (same access list).</summary>
    public string? ResultsFolder { get; init; }
    public TimeSpan EnrollPollInterval { get; init; } = TimeSpan.FromSeconds(60);
    /// <summary>The heartbeat interval while the server speaks protocol 1.0 (sends no pacing).</summary>
    public TimeSpan HeartbeatInterval { get; init; } = TimeSpan.FromSeconds(60);
    /// <summary>The heartbeat interval once the server speaks protocol 1.1 and names none (presence then also comes from the long poll).</summary>
    public TimeSpan HeartbeatInterval11 { get; init; } = TimeSpan.FromSeconds(300);
    /// <summary>The range a server-directed heartbeat interval is clamped to (the contract's 60–900 s).</summary>
    public TimeSpan MinHeartbeat { get; init; } = TimeSpan.FromSeconds(60);
    public TimeSpan MaxHeartbeat { get; init; } = TimeSpan.FromSeconds(900);
    /// <summary>After a reconnection, the main event lane waits a random time up to this before its first send, so a fleet does not flush at once.</summary>
    public TimeSpan ReconnectFlushJitter { get; init; } = TimeSpan.FromSeconds(120);
    /// <summary>After a connection that was up is reset, the first retry comes a random time up to this later.</summary>
    public TimeSpan ResetJitter { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan NetworkChangeJitter { get; init; } = TimeSpan.FromSeconds(10);
    /// <summary>Consecutive refusals of a single event, sent alone, before it is set aside.</summary>
    public int MaxEventFailures { get; init; } = 5;
    public TimeSpan RenewCheckInterval { get; init; } = TimeSpan.FromHours(6);
    public TimeSpan RenewBefore { get; init; } = TimeSpan.FromDays(30);
    /// <summary>The shared backoff after real network failures (refused, timed out, reset): decorrelated jitter from 2 s, capped at 60 s, so a cabinet is never away much more than a minute after the server is back.</summary>
    public Backoff Backoff { get; init; } = new(TimeSpan.FromSeconds(2), NetworkBackoffCap);
    public static readonly TimeSpan NetworkBackoffCap = TimeSpan.FromSeconds(60);
    /// <summary>The backoff a loop uses on its own after an answer only it must wait for (a quota, a refusal, a malformed answer).</summary>
    public Func<Backoff> LocalBackoff { get; init; } = () => new Backoff();
    /// <summary>The backoff before a loop that failed unexpectedly is started again.</summary>
    public Func<Backoff> LoopRestartBackoff { get; init; } = () => new Backoff(TimeSpan.FromSeconds(1));
    /// <summary>Tests only: replaces the real TLS handler.</summary>
    public Func<X509Certificate2?, HttpMessageHandler>? HandlerFactory { get; init; }
    public Random Random { get; init; } = Random.Shared;
}

/// <summary>
/// The agent's connection to the platform server: enrollment, then the loops that share one long-lived
/// connection and one connectivity state (protocol 1.1): heartbeat, long poll, the command worker, the
/// result sender, the event sender and renewal. Every command still goes through the six checks in
/// <see cref="CommandProcessor"/>; the server is not trusted to have sent only valid ones.
/// </summary>
public sealed class AgentConnection(AgentConnectionOptions o)
{
    private enum Ended { Cancelled, CertificateRefused }

    /// <summary>Commands received but not yet answered, at most this many; more are left to be offered again.</summary>
    public const int MaxQueuedCommands = 200;

    private readonly Pacing _pacing = new(o.HeartbeatInterval, o.HeartbeatInterval11, o.MinHeartbeat, o.MaxHeartbeat);
    private ResultOutbox? _outbox;

    /// <summary>The pacing currently in force (tests and diagnostics).</summary>
    public Pacing Pacing => _pacing;

    /// <summary>Runs until <paramref name="token"/> is cancelled, then returns normally.</summary>
    public async Task RunAsync(CancellationToken token)
    {
        try { await RunLoopAsync(token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private async Task RunLoopAsync(CancellationToken token)
    {
        Backoff failures = o.LoopRestartBackoff();
        while (!token.IsCancellationRequested)
        {
            Ended ended;
            try
            {
                AgentIdentity? identity = o.Store.LoadIdentity() ?? await EnrollAsync(token).ConfigureAwait(false);
                if (identity is null) return;
                ended = await OnlineAsync(identity, token).ConfigureAwait(false);
                failures.Reset();
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception e)
            {
                // Anything unexpected (the key store, the disk, a bug) is reported and retried, never left to end the connection silently.
                o.Log($"The server connection stopped on an unexpected error ({e.GetType().Name}: {OperationRunner.Truncate(e.Message)}); retrying.");
                await Delay(failures.Next(), token).ConfigureAwait(false);
                continue;
            }
            if (ended == Ended.CertificateRefused)
            {
                if (o.Store.LoadToken() is not null)
                {
                    o.Log("A new bootstrap token is present; enrolling again.");
                    File.Delete(Path.Combine(Path.GetDirectoryName(o.Store.TokenPath)!, "identity.json"));
                    continue;
                }
                o.Log("The platform server refused this cabinet's certificate (removed or revoked). Waiting; install a new bootstrap token to enroll again.");
                await Delay(TimeSpan.FromMinutes(5), token).ConfigureAwait(false);
            }
        }
    }

    // ---- Enrollment ------------------------------------------------------------------

    private async Task<AgentIdentity?> EnrollAsync(CancellationToken token)
    {
        using var api = new AgentApiClient(o.ServerUri, o.PlatformCa, clientCertificate: null, o.HandlerFactory);
        bool waitingForToken = false;
        while (!token.IsCancellationRequested)
        {
            try
            {
                Guid? requestId = o.Store.LoadRequestId();
                if (requestId is null)
                {
                    string? bootstrap = o.Store.LoadToken();
                    if (bootstrap is null)
                    {
                        if (!waitingForToken) o.Log("Not enrolled and no bootstrap token is installed; waiting for one.");
                        waitingForToken = true;
                        await Delay(o.EnrollPollInterval, token).ConfigureAwait(false);
                        continue;
                    }
                    waitingForToken = false;
                    EnrollResponse sent = await api.EnrollAsync(new EnrollRequest
                    {
                        Csr = o.Keys.CreateSigningRequestPem(), BootstrapToken = bootstrap,
                        // Stamped here rather than left to whoever builds the fingerprints, so every enrollment request
                        // names the architecture of the build that sends it. Optional in the contract, so a request from
                        // an agent built before the second architecture stays valid without it.
                        Fingerprints = o.Fingerprints() with { Architecture = AgentArchitecture.Current },
                    }, token).ConfigureAwait(false);
                    o.Store.SaveRequestId(sent.RequestId);
                    o.Store.DeleteToken(); // the server has consumed it
                    o.Log($"Enrollment request {sent.RequestId} sent; waiting for an administrator to approve it.");
                    o.Backoff.Reset();
                    continue;
                }

                EnrollStatus status = await api.EnrollStatusAsync(requestId.Value, token).ConfigureAwait(false);
                o.Backoff.Reset();
                switch (status.Status)
                {
                    case EnrollState.Pending:
                        await Delay(o.EnrollPollInterval, token).ConfigureAwait(false);
                        break;
                    case EnrollState.Rejected:
                        o.Log($"Enrollment request {requestId} was rejected. Install a new bootstrap token to try again.");
                        o.Store.ClearRequestId();
                        break;
                    case EnrollState.Issued:
                        var identity = new AgentIdentity(status.CabinetId!.Value, status.Certificate!);
                        CheckCertificate(identity);
                        o.Store.SaveIdentity(identity);
                        o.Store.ClearRequestId();
                        o.Log($"Enrolled as cabinet {identity.CabinetId}.");
                        return identity;
                }
            }
            catch (AgentApiException e) when (e.Status == HttpStatusCode.Forbidden)
            {
                o.Log("The bootstrap token was refused (unknown, already used or expired). Install a new one.");
                o.Store.DeleteToken();
            }
            catch (AgentApiException e) when (e.Status == HttpStatusCode.NotFound)
            {
                o.Log("The server no longer knows this enrollment request; starting again with a new bootstrap token.");
                o.Store.ClearRequestId();
            }
            catch (Exception e) when (e is AgentApiException or InvalidDataException)
            {
                o.Log($"Enrollment: {e.Message}");
                TimeSpan wait = o.Backoff.Next();
                if (e is AgentApiException { RetryAfter: { } after } && after > wait) wait = after;
                await Delay(wait, token).ConfigureAwait(false);
            }
        }
        return null;
    }

    /// <summary>The issued certificate must be for our key, name the cabinet ID we were given, and chain to the platform CA.</summary>
    private void CheckCertificate(AgentIdentity identity)
    {
        X509Certificate2 withKey;
        try { withKey = o.Keys.WithPrivateKey(identity.CertificatePem); }
        catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or ArgumentException)
        {
            throw new InvalidDataException("The issued certificate is not for this agent's key.");
        }
        using (withKey)
        {
            if (withKey.GetNameInfo(X509NameType.SimpleName, false) != identity.CabinetId.ToString("D"))
                throw new InvalidDataException("The issued certificate does not name the cabinet ID the server returned.");
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(o.PlatformCa);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            if (!chain.Build(withKey)) throw new InvalidDataException("The issued certificate does not chain to the platform CA.");
        }
    }

    // ---- Online ----------------------------------------------------------------------

    /// <summary>What every loop of one online session shares.</summary>
    private sealed class Session(AgentApiClient api, Connectivity link, ResultOutbox outbox, AgentIdentity identity, X509Certificate2 certificate)
    {
        public AgentApiClient Api { get; } = api;
        public Connectivity Link { get; } = link;
        public ResultOutbox Outbox { get; } = outbox;
        public AgentIdentity Identity { get; set; } = identity;
        public X509Certificate2 Certificate { get; set; } = certificate;
        public List<X509Certificate2> Certificates { get; } = [certificate];
        public Channel<(Guid? Id, byte[] Raw)> Work { get; } = Channel.CreateUnbounded<(Guid?, byte[])>(new UnboundedChannelOptions { SingleReader = true });
        /// <summary>Commands queued for the worker or running now.</summary>
        public HashSet<Guid> InFlight { get; } = new();
        private long _flushNotBeforeTicks;
        /// <summary>The main event lane waits until then after a reconnection (the priority lane does not).</summary>
        public DateTimeOffset FlushNotBefore
        {
            get => new(Interlocked.Read(ref _flushNotBeforeTicks), TimeSpan.Zero);
            set => Interlocked.Exchange(ref _flushNotBeforeTicks, value.UtcTicks);
        }
        public TimeSpan FlushHold => FlushNotBefore - DateTimeOffset.UtcNow;
    }

    private async Task<Ended> OnlineAsync(AgentIdentity identity, CancellationToken token)
    {
        X509Certificate2 certificate = o.Keys.WithPrivateKey(identity.CertificatePem);
        using var api = new AgentApiClient(o.ServerUri, o.PlatformCa, certificate, o.HandlerFactory) { GzipAllowed = _pacing.Server11 };
        _outbox ??= new ResultOutbox(o.ResultsFolder ?? Path.Combine(Path.GetDirectoryName(Path.GetFullPath(o.Store.TokenPath))!, "results"), TimeProvider.System, o.Log);
        var link = new Connectivity(o.Backoff, TimeProvider.System, o.Random, o.ResetJitter, o.NetworkChangeJitter);
        var session = new Session(api, link, _outbox, identity, certificate);
        link.Connected += reconnected =>
        {
            o.Log(reconnected ? "Reconnected to the platform server." : "Connected to the platform server.");
            if (reconnected) session.FlushNotBefore = DateTimeOffset.UtcNow + TimeSpan.FromMilliseconds(o.Random.NextDouble() * o.ReconnectFlushJitter.TotalMilliseconds);
        };
        link.Lost += reason => o.Log($"Lost the platform server: {reason}");
        NetworkAddressChangedEventHandler changed = (_, _) => link.NetworkChanged();
        bool watching = false;
        try { NetworkChange.NetworkAddressChanged += changed; watching = true; }
        catch (Exception e) when (e is PlatformNotSupportedException or NetworkInformationException) { }
        if (o.Packages is not null) o.Packages.Client = api;
        try { return await LoopsAsync(session, token).ConfigureAwait(false); }
        finally
        {
            if (o.Packages is not null) o.Packages.Client = null;
            if (watching) NetworkChange.NetworkAddressChanged -= changed;
            api.Dispose();
            foreach (X509Certificate2 c in session.Certificates) c.Dispose();
        }
    }

    private async Task<Ended> LoopsAsync(Session s, CancellationToken token)
    {
        CommandProcessor processor = o.ProcessorFor(o.Config with { CabinetId = s.Identity.CabinetId });
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        var loops = new[]
        {
            Supervise("heartbeat", t => HeartbeatLoopAsync(s, t), stop.Token),
            Supervise("command poll", t => PollLoopAsync(s, t), stop.Token),
            Supervise("command worker", t => WorkerLoopAsync(s, processor, t), stop.Token),
            Supervise("result sender", t => ResultLoopAsync(s, t), stop.Token),
            Supervise("event sender", t => EventLoopAsync(s, t), stop.Token),
            Supervise("configuration sender", t => ConfigLoopAsync(s, t), stop.Token),
            Supervise("certificate renewal", t => RenewLoopAsync(s, t), stop.Token),
        };
        Task<Ended> first = await Task.WhenAny(loops).ConfigureAwait(false);
        stop.Cancel();
        try { await Task.WhenAll(loops).ConfigureAwait(false); } catch (OperationCanceledException) { }
        return token.IsCancellationRequested ? Ended.Cancelled : await first.ConfigureAwait(false);
    }

    /// <summary>A loop that fails unexpectedly is logged and started again after a backoff; the other loops and the connection carry on.</summary>
    private async Task<Ended> Supervise(string name, Func<CancellationToken, Task<Ended>> loop, CancellationToken token)
    {
        Backoff backoff = o.LoopRestartBackoff();
        while (!token.IsCancellationRequested)
        {
            try { return await loop(token).ConfigureAwait(false); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception e)
            {
                TimeSpan wait = backoff.Next();
                o.Log($"The {name} loop failed ({e.GetType().Name}: {OperationRunner.Truncate(e.Message)}); restarting it in {wait.TotalSeconds:0.#} s.");
                FaultCode("loop_restart", name.Replace(' ', '_'), e.GetType().Name);
                try { await Delay(wait, token).ConfigureAwait(false); } catch (OperationCanceledException) { break; }
            }
        }
        return Ended.Cancelled;
    }

    /// <summary>
    /// How long a loop waits after a failure only it should wait for (a shed 503, a quota, or an answer the server refused): its own
    /// backoff, or the server's Retry-After when that is longer. A Retry-After is never trusted past <see cref="Connectivity.MaxServerWait"/>
    /// (the client already clamps it; this keeps the wait bounded whatever reaches here) and a negative or missing one counts as none.
    /// </summary>
    internal static TimeSpan LocalWait(AgentApiException e, Backoff backoff, TimeSpan? cap = null)
    {
        TimeSpan wait = backoff.Next();
        if (cap is { } c && wait > c) wait = c;
        if (e.RetryAfter is { } after && after > wait) wait = after > Connectivity.MaxServerWait ? Connectivity.MaxServerWait : after;
        return wait;
    }

    private async Task<Ended> HeartbeatLoopAsync(Session s, CancellationToken token)
    {
        Backoff local = o.LocalBackoff();
        while (!token.IsCancellationRequested)
        {
            TimeSpan next;
            using (await s.Link.EnterAsync(token, maxBackoff: _pacing.Heartbeat).ConfigureAwait(false))
            {
                try
                {
                    double? skew = s.Api.LastServerTime is { } t ? Math.Clamp(Math.Round((t.Local - t.Server).TotalSeconds, 1), -86_400, 86_400) : null;
                    HealthSample? health = o.Health?.Invoke();
                    HeartbeatResponse answer = await s.Api.HeartbeatAsync(new Heartbeat
                    {
                        // Which architecture this cabinet runs, from the process's own bitness: the platform records it
                        // and offers only the releases that match. Optional in the contract, so an agent built before
                        // the second architecture — which sends nothing here — stays valid.
                        Architecture = AgentArchitecture.Current,
                        // A development build that would install unsigned agent programs says so, so the console can mark it.
                        UnsignedUpgrades = Upgrades.UpgradeTrust.AcceptsUnsignedPrograms ? true : null,
                        AgentVersion = o.AgentVersion, UptimeSeconds = o.UptimeSeconds(), ReadOnlyMode = o.Config.ReadOnlyMode, ClockSkewSeconds = skew,
                        FirewallProfiles = o.FirewallProfiles?.Invoke(), TimeZoneId = o.TimeZoneId?.Invoke(), Health = health,
                    }, token).ConfigureAwait(false);
                    s.Link.Reached();
                    local.Reset();
                    _pacing.Apply(answer.Intervals);
                    s.Api.GzipAllowed = _pacing.Server11;
                    if (health is not null) o.HealthSent?.Invoke(health);
                    o.Settings?.Apply(answer);
                    if (o.Upgrades is not null) await o.Upgrades.AfterHeartbeatAsync(s.Api, answer, token).ConfigureAwait(false);
                    next = _pacing.Heartbeat;
                }
                catch (AgentApiException e)
                {
                    switch (s.Link.Failed(e))
                    {
                        case FailureKind.CertificateRefused: return Ended.CertificateRefused;
                        case FailureKind.Network: continue; // the shared state paces the retry
                        default: next = LocalWait(e, local, _pacing.Heartbeat); break; // a 503 or 429 here pauses the heartbeat only, for at least its Retry-After
                    }
                }
            }
            await Delay(next, token).ConfigureAwait(false);
        }
        return Ended.Cancelled;
    }

    /// <summary>
    /// The long poll (protocol 1.1 leased delivery). Each poll acknowledges the commands the previous one brought;
    /// a command offered again is answered from the result outbox if it has run, and ignored if it is still queued
    /// or running. Commands run on the worker, so polling (and the presence it gives) goes on during a long command.
    /// </summary>
    private async Task<Ended> PollLoopAsync(Session s, CancellationToken token)
    {
        Backoff local = o.LocalBackoff();
        var ack = new List<Guid>();
        while (!token.IsCancellationRequested)
        {
            CommandBatch batch;
            DateTimeOffset started = DateTimeOffset.UtcNow;
            using (await s.Link.EnterAsync(token).ConfigureAwait(false))
            {
                try
                {
                    batch = await s.Api.CommandsAsync(ack, _pacing.PollSeconds, token).ConfigureAwait(false);
                    s.Link.Reached();
                    local.Reset();
                }
                catch (AgentApiException e)
                {
                    TimeSpan wait;
                    switch (s.Link.Failed(e))
                    {
                        case FailureKind.CertificateRefused: return Ended.CertificateRefused;
                        case FailureKind.Network: continue;
                        default: wait = LocalWait(e, local); break; // the poll's own shed answer is a 200 with reconnectAfterMs; a bare 503 or 429 pauses only this loop
                    }
                    await Delay(wait, token).ConfigureAwait(false);
                    continue;
                }
            }
            // Acknowledged now; from here a lost answer is covered by the outbox, not by the server's lease.
            ack = TakeCommands(s, batch.Commands);
            _pacing.ApplyPoll(batch.PollSeconds);
            s.Api.GzipAllowed = _pacing.Server11;
            if (batch.ReconnectAfterMs is { } ms)
            {
                o.Log($"The platform server asked the agent to reconnect in {ms / 1000.0:0.#} s.");
                s.Link.ServerAskedToWait(TimeSpan.FromMilliseconds(ms));
            }
            else if (batch.Commands.Count == 0 && DateTimeOffset.UtcNow - started < TimeSpan.FromSeconds(1))
                await Delay(TimeSpan.FromSeconds(1), token).ConfigureAwait(false); // a server that does not hold the poll cannot make the agent spin
        }
        return Ended.Cancelled;
    }

    /// <summary>Hands new commands to the worker and decides what to acknowledge on the next poll.</summary>
    private List<Guid> TakeCommands(Session s, IReadOnlyList<byte[]> commands)
    {
        var ack = new List<Guid>();
        foreach (byte[] raw in commands)
        {
            Guid? id = CommandIdOf(raw);
            if (id is { } known)
            {
                lock (s.InFlight)
                {
                    if (s.InFlight.Contains(known)) { ack.Add(known); continue; } // still queued or running: the result follows
                }
                switch (s.Outbox.StateOf(known))
                {
                    case ResultOutbox.State.Pending:
                        ack.Add(known); // answered; the sender is delivering it
                        continue;
                    case ResultOutbox.State.Delivered:
                        o.Log($"Command {known} was offered again; answering with its stored result.");
                        s.Outbox.Requeue(known);
                        ack.Add(known);
                        continue;
                }
                lock (s.InFlight)
                {
                    if (s.InFlight.Count >= MaxQueuedCommands) continue; // not acknowledged: the server offers it again later
                    s.InFlight.Add(known);
                }
                ack.Add(known);
            }
            s.Work.Writer.TryWrite((id, raw));
        }
        return ack;
    }

    /// <summary>The command ID, when the command is readable enough to have one; anything else goes to the checks, which drop it.</summary>
    public static Guid? CommandIdOf(byte[] raw)
    {
        if (!StrictJson.TryParse(raw, CommandValidator.MaxCommandBytes, out JsonDocument? doc)) return null;
        using (doc)
            return doc!.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("commandId", out JsonElement id) &&
                   ContractSchemas.Instance.IsValid(ContractSchemas.CommandProperty("commandId"), id) ? Guid.Parse(id.GetString()!) : null;
    }

    /// <summary>
    /// Runs commands one at a time, as before: never two writes at once, and a write under the safety net holds the worker
    /// until it is settled. Polling, heartbeats, results and events carry on meanwhile.
    /// </summary>
    private async Task<Ended> WorkerLoopAsync(Session s, CommandProcessor processor, CancellationToken token)
    {
        while (await s.Work.Reader.WaitToReadAsync(token).ConfigureAwait(false))
        {
            if (!s.Work.Reader.TryRead(out var item)) continue;
            try
            {
                var (result, dropped) = await processor.ProcessAsync(item.Raw, token).ConfigureAwait(false);
                if (result is null) { o.Log($"Dropped a command from the server: {dropped}"); continue; }
                o.Log($"Command {result.CommandId} {result.Status.ToString().ToLowerInvariant()}{(result.Error is null ? "" : " " + result.Error.Code)}.");
                if (result.Status == ResultStatus.Succeeded && result.Output is { } output && output.ValueKind == JsonValueKind.Object &&
                    output.TryGetProperty("safetyNetDeadline", out JsonElement d) && d.TryGetDateTimeOffset(out DateTimeOffset deadline) && o.ConfirmSafetyNet is not null)
                {
                    o.AfterWrite?.Invoke();
                    await DeliverUnderSafetyNetAsync(s, result, deadline, token).ConfigureAwait(false);
                }
                else
                {
                    if (result.Status == ResultStatus.Succeeded && result.Output is not null && o.ConfirmSafetyNet is not null) o.AfterWrite?.Invoke();
                    s.Outbox.Add(result);
                }
            }
            finally
            {
                if (item.Id is { } id) lock (s.InFlight) s.InFlight.Remove(id);
            }
        }
        return Ended.Cancelled;
    }

    /// <summary>Posts stored results oldest first until the server has each one (2xx, or 409: it already has it).</summary>
    private async Task<Ended> ResultLoopAsync(Session s, CancellationToken token)
    {
        Backoff local = o.LocalBackoff();
        while (!token.IsCancellationRequested)
        {
            Task added = s.Outbox.Added;
            if (s.Outbox.Next() is not { } next) { await added.WaitAsync(token).ConfigureAwait(false); continue; }
            TimeSpan? wait = null;
            using (await s.Link.EnterAsync(token, probe: false).ConfigureAwait(false))
            {
                try
                {
                    await s.Api.PostResultRawAsync(next.Json, token).ConfigureAwait(false);
                    s.Link.Reached();
                    s.Outbox.Delivered(next.Id);
                    local.Reset();
                }
                catch (AgentApiException e)
                {
                    FailureKind kind = s.Link.Failed(e);
                    if (kind == FailureKind.CertificateRefused) return Ended.CertificateRefused;
                    if (e.Status == HttpStatusCode.Conflict) s.Outbox.Delivered(next.Id);
                    else if (kind == FailureKind.Answered && e.Status is { } status && (int)status is >= 400 and < 500)
                    {
                        // The server will never take this one (malformed, unknown command, too large): retrying would block every later result.
                        o.Log($"The server did not accept the result for {next.Id} ({(int)status} {e.Code}); it is not sent again.");
                        s.Outbox.Delivered(next.Id);
                    }
                    else if (kind is FailureKind.Answered or FailureKind.Quota or FailureKind.Unavailable) wait = LocalWait(e, local);
                }
            }
            if (wait is { } w) await Delay(w, token).ConfigureAwait(false);
        }
        return Ended.Cancelled;
    }

    /// <summary>
    /// Sends queued events oldest first (the security and agent-status lane before the rest), in batches of at most
    /// 100 events and 256 KB, gzip-compressed when the server takes it. A 413 halves the batch; a refused batch is halved
    /// until the event the server refuses is alone, and an event refused alone <see cref="AgentConnectionOptions.MaxEventFailures"/>
    /// times is set aside so it cannot stall the queue. A backlog drains at the pace the server sets, and after a
    /// reconnection the main lane waits a random 0–120 s first. Dropped and set-aside counts are reported as an agent_status event.
    /// </summary>
    private async Task<Ended> EventLoopAsync(Session s, CancellationToken token)
    {
        if (o.Events is null) return await Idle(token).ConfigureAwait(false);
        EventQueue queue = o.Events;
        Backoff local = o.LocalBackoff();
        int maxCount = EventQueue.MaxBatch;
        Guid? failingHead = null;
        int failuresAlone = 0;
        (long Dropped, long SetAside) reported = (0, 0);
        while (!token.IsCancellationRequested)
        {
            reported = ReportLosses(queue, s.Identity.CabinetId, reported);
            if (queue.PriorityCount == 0 && s.FlushHold is { Ticks: > 0 } hold)
            {
                await Delay(hold < o.EventSendInterval ? hold : o.EventSendInterval, token).ConfigureAwait(false);
                continue;
            }
            var batch = queue.PeekBatch(maxCount);
            if (batch.Count == 0) { await Delay(o.EventSendInterval, token).ConfigureAwait(false); continue; }
            TimeSpan? wait = null;
            using (await s.Link.EnterAsync(token, probe: false).ConfigureAwait(false))
            {
                // Released by a reconnection: the main lane first waits out its jitter (checked again at the top).
                if (queue.PriorityCount == 0 && s.FlushHold > TimeSpan.Zero) continue;
                try
                {
                    await s.Api.PostEventsRawAsync(batch.Select(b => b.Json).ToList(), token).ConfigureAwait(false);
                    s.Link.Reached();
                    queue.Acknowledge(batch.Select(b => b.Id));
                    local.Reset();
                    maxCount = Math.Min(EventQueue.MaxBatch, maxCount * 2);
                    failingHead = null;
                    failuresAlone = 0;
                    if (queue.Count > 0 && _pacing.EventsPace > TimeSpan.Zero) wait = _pacing.EventsPace; // draining a backlog
                }
                catch (AgentApiException e)
                {
                    FailureKind kind = s.Link.Failed(e);
                    if (kind == FailureKind.CertificateRefused) return Ended.CertificateRefused;
                    if (kind is FailureKind.Quota or FailureKind.Unavailable) wait = LocalWait(e, local);
                    else if (kind == FailureKind.Answered)
                    {
                        maxCount = Math.Max(1, batch.Count / 2);
                        if (batch.Count == 1)
                        {
                            failuresAlone = failingHead == batch[0].Id ? failuresAlone + 1 : 1;
                            failingHead = batch[0].Id;
                            if (failuresAlone >= o.MaxEventFailures)
                            {
                                o.Log($"The server refused event {batch[0].Id} {failuresAlone} times ({e.Code}); it was set aside.");
                                queue.SetAsideEvent(batch[0].Id);
                                failingHead = null;
                                failuresAlone = 0;
                            }
                        }
                        // A 413 is answered at once with the smaller batch; anything else waits a little first.
                        if (e.Status != HttpStatusCode.RequestEntityTooLarge) wait = LocalWait(e, local);
                    }
                }
            }
            if (wait is { } w) await Delay(w, token).ConfigureAwait(false);
        }
        return Ended.Cancelled;
    }

    /// <summary>
    /// Sends queued configuration snapshots oldest first, up to 8 at a time and under a size limit; the queue keeps them until the server has
    /// accepted them. A quota or a shed request waits (the server's Retry-After at least); an answer that refuses the snapshots (the contract
    /// or hash check) drops them and makes the watcher look at those categories again, so one bad snapshot never blocks the queue.
    /// </summary>
    private async Task<Ended> ConfigLoopAsync(Session s, CancellationToken token)
    {
        if (o.ConfigUploads is null) return await Idle(token).ConfigureAwait(false);
        var queue = o.ConfigUploads;
        Backoff local = o.LocalBackoff();
        while (!token.IsCancellationRequested)
        {
            var next = queue.Peek();
            if (next is null) { await Delay(o.ConfigSendInterval, token).ConfigureAwait(false); continue; }
            TimeSpan? wait = null;
            using (await s.Link.EnterAsync(token, probe: false).ConfigureAwait(false))
            {
                try
                {
                    await s.Api.PostConfigAsync(next.Value.Body, token).ConfigureAwait(false);
                    s.Link.Reached();
                    queue.Acknowledge(next.Value.Count);
                    local.Reset();
                    if (queue.Count > 0) wait = TimeSpan.FromSeconds(1); // draining a backlog, gently
                }
                catch (AgentApiException e)
                {
                    FailureKind kind = s.Link.Failed(e);
                    if (kind == FailureKind.CertificateRefused) return Ended.CertificateRefused;
                    if (kind is FailureKind.Quota or FailureKind.Unavailable) wait = LocalWait(e, local);
                    else if (kind == FailureKind.Answered)
                    {
                        o.Log($"The server refused {next.Value.Count} configuration snapshot(s) ({e.Code}); they were dropped and will be looked at again.");
                        queue.Discard(next.Value.Count);
                    }
                }
            }
            if (wait is { } w) await Delay(w, token).ConfigureAwait(false);
        }
        return Ended.Cancelled;
    }

    /// <summary>Queues an agent_status event when the queue has dropped or set aside events since the last report.</summary>
    private (long, long) ReportLosses(EventQueue queue, Guid cabinetId, (long Dropped, long SetAside) reported)
    {
        long dropped = queue.Dropped, setAside = queue.SetAside;
        if ((dropped, setAside) == reported || (dropped == 0 && setAside == 0)) return reported;
        string message = $"The agent's event queue has dropped {dropped} event(s) because it was full and set aside {setAside} the server kept refusing.";
        queue.Enqueue(new AgentEvent
        {
            EventId = EventIds.For($"event-queue-losses|{cabinetId:D}|{dropped}|{setAside}"), Kind = EventKind.AgentStatus, OccurredAt = DateTimeOffset.UtcNow,
            SeverityHint = SeverityHint.Minor,
            Detail = new EventDetail
            {
                Message = message,
                Fields = new Dictionary<string, string>
                {
                    ["check"] = "event_queue", ["droppedEvents"] = dropped.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["setAsideEvents"] = setAside.ToString(System.Globalization.CultureInfo.InvariantCulture),
                },
            },
        });
        o.Log(message);
        return (queue.Dropped, queue.SetAside);
    }

    /// <summary>
    /// Reports one of the agent's own faults to the server as a CODE only (an agent_status event: which check, a short code, the exception's type name),
    /// at most once an hour per check and code, so a fault that repeats cannot flood the queue. Never a message, a path, file contents or anything from the cabinet.
    /// </summary>
    private void FaultCode(string check, string code, string exception)
    {
        if (o.Events is null) return;
        DateTimeOffset now = DateTimeOffset.UtcNow;
        o.Events.Enqueue(new AgentEvent
        {
            EventId = EventIds.For($"fault|{check}|{code}|{now.ToUnixTimeSeconds() / 3600}"), Kind = EventKind.AgentStatus, OccurredAt = now, SeverityHint = SeverityHint.Minor,
            Detail = new EventDetail { Message = $"Agent fault: {check} ({code}).", Fields = new Dictionary<string, string> { ["check"] = check, ["code"] = code, ["exception"] = exception } },
        });
    }

    private static async Task<Ended> Idle(CancellationToken token)
    {
        try { await Task.Delay(Timeout.Infinite, token).ConfigureAwait(false); } catch (OperationCanceledException) { }
        return Ended.Cancelled;
    }

    /// <summary>
    /// The safety net, network side: the change stays only if this agent reaches the server within the window.
    /// Delivering the result is that proof, so it is posted directly, every 3 seconds, ignoring the shared backoff.
    /// Only a result the server has taken, and a broker that then answers that the change is kept, leave it in place:
    /// a refused result (400, 404, 409), an answer that never comes and a confirmation the broker refuses all leave the
    /// change under the safety net, and what the broker reports decides the result, so a rollback that failed is never
    /// reported as one that happened.
    /// </summary>
    private async Task DeliverUnderSafetyNetAsync(Session s, Result result, DateTimeOffset deadline, CancellationToken token)
    {
        bool accepted = false;
        HttpStatusCode? refused = null;
        while (!token.IsCancellationRequested && DateTimeOffset.UtcNow < deadline - TimeSpan.FromSeconds(3))
        {
            try { await s.Api.PostResultAsync(result, token).ConfigureAwait(false); accepted = true; break; }
            catch (AgentApiException e) when (e.CertificateRefused) { break; }
            catch (AgentApiException e) when (e.Status is HttpStatusCode.BadRequest or HttpStatusCode.NotFound or HttpStatusCode.Conflict)
            {
                // The server answered but would not take this result. That proves it is reachable, not that the change
                // may stay, so the change is not confirmed and stays under the safety net.
                refused = e.Status;
                break;
            }
            catch (AgentApiException) { await Delay(TimeSpan.FromSeconds(3), token).ConfigureAwait(false); }
        }
        if (refused is not null) s.Link.Reached();

        if (accepted)
        {
            s.Link.Reached();
            // Stored before the broker is asked, so a connection cut here cannot leave the server without an answer,
            // and set aside as delivered only once the broker has settled the change.
            s.Outbox.Add(result);
            SafetyNetStatus? status = await ConfirmSafetyNetAsync(result.CommandId, token).ConfigureAwait(false);
            if (status?.State == SafetyNetState.Kept)
            {
                // Kept as delivered, so a repeat offer of this command is answered with this result.
                s.Outbox.Delivered(result.CommandId);
                o.Log($"Command {result.CommandId}: the server took its result and the broker kept the change.");
                return;
            }
            ReportRolledBack(s, result, status?.State == SafetyNetState.RolledBack, status?.State == SafetyNetState.RolledBack
                ? "The server was reached after the safety-net window had run out: the change had already been rolled back."
                : "The broker did not confirm this change as kept, so it may still be rolled back by the safety net.");
            return;
        }

        // Not accepted in time: the broker rolls the change back at the deadline (and again at start-up, if it was not running).
        o.Log($"Command {result.CommandId}: {(refused is { } code ? $"the server refused its result ({(int)code}), so the change is not confirmed" : "the server was not reached in time")}; the safety net rolls the change back.");
        TimeSpan wait = deadline + TimeSpan.FromSeconds(15) - DateTimeOffset.UtcNow;
        if (wait > TimeSpan.Zero) await Delay(wait, token).ConfigureAwait(false);
        SafetyNetStatus? settled = await ConfirmSafetyNetAsync(result.CommandId, token).ConfigureAwait(false);
        if (settled?.State == SafetyNetState.Kept)
        {
            s.Outbox.Add(result);
            s.Outbox.Delivered(result.CommandId);
            o.Log($"Command {result.CommandId}: the server took the result after all; the change is kept.");
            return;
        }
        ReportRolledBack(s, result, settled?.State == SafetyNetState.RolledBack, settled?.State == SafetyNetState.RolledBack
            ? "The cabinet could not reach the server within the safety-net window after this change, so the change was rolled back."
            : "The cabinet could not reach the server within the safety-net window, and the broker could not confirm the change was rolled back: it may still be in place and the cabinet may need a visit.");
    }

    /// <summary>Asks the broker to keep a change; null when the broker could not be asked at all, so the change is not treated as kept.</summary>
    private async Task<SafetyNetStatus?> ConfirmSafetyNetAsync(Guid commandId, CancellationToken token)
    {
        SafetyNetStatus? status = null;
        for (int attempt = 0; attempt < 5 && status is null && !token.IsCancellationRequested; attempt++)
        {
            try { status = await o.ConfirmSafetyNet!(commandId, token).ConfigureAwait(false); }
            catch (OperationFailedException) { await Delay(TimeSpan.FromSeconds(1), token).ConfigureAwait(false); }
        }
        return status;
    }

    /// <summary>
    /// The change did not survive the safety net: a security event says what the broker reported, and the result left
    /// for the server says the command failed, because the change that result reported is not in place.
    /// </summary>
    private void ReportRolledBack(Session s, Result result, bool confirmed, string message)
    {
        SafetyNetEvent(result.CommandId, message);
        s.Outbox.Add(result with
        {
            Status = ResultStatus.Failed, Output = null, FinishedAt = DateTimeOffset.UtcNow,
            Error = new ResultError
            {
                Code = "safety_net_rollback",
                Message = confirmed
                    ? "The change was rolled back: the cabinet could not reach the server, or the result took too long to be taken."
                    : "The change may still be in place: the cabinet could not reach the server within the safety-net window and the rollback was not confirmed.",
            },
        });
    }

    private void SafetyNetEvent(Guid commandId, string message)
    {
        o.Log($"Command {commandId}: {message}");
        o.Events?.Enqueue(new AgentEvent
        {
            EventId = EventIds.For($"safety-net|{commandId}"), Kind = EventKind.Security, OccurredAt = DateTimeOffset.UtcNow, SeverityHint = SeverityHint.Major,
            Detail = new EventDetail { Message = message, Fields = new Dictionary<string, string> { ["commandId"] = commandId.ToString("D"), ["check"] = "safety_net_rollback" } },
        });
    }

    /// <summary>
    /// Renews the certificate before it expires. The new certificate is used for new connections; nothing running is
    /// cancelled (a result under the safety net finishes on the connection it started on).
    /// </summary>
    private async Task<Ended> RenewLoopAsync(Session s, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            if (s.Certificate.NotAfter.ToUniversalTime() - DateTime.UtcNow < o.RenewBefore)
            {
                try
                {
                    RenewResponse renewed = await s.Api.RenewAsync(new RenewRequest { Csr = o.Keys.CreateSigningRequestPem() }, token).ConfigureAwait(false);
                    var next = s.Identity with { CertificatePem = renewed.Certificate };
                    CheckCertificate(next);
                    o.Store.SaveIdentity(next);
                    X509Certificate2 certificate = o.Keys.WithPrivateKey(next.CertificatePem);
                    s.Certificates.Add(certificate);
                    s.Api.SwapClientCertificate(certificate);
                    s.Identity = next;
                    s.Certificate = certificate;
                    o.Log("Renewed the cabinet's certificate; new connections use it.");
                }
                catch (AgentApiException e) when (e.CertificateRefused) { return Ended.CertificateRefused; }
                catch (Exception e) when (e is AgentApiException or InvalidDataException)
                {
                    o.Log($"Certificate renewal: {e.Message}");
                    FaultCode("renewal_failed", e is AgentApiException { Status: { } st } ? $"http_{(int)st}" : e is AgentApiException ? "unreachable" : "invalid_certificate", e.GetType().Name);
                }
            }
            await Delay(o.RenewCheckInterval, token).ConfigureAwait(false);
        }
        return Ended.Cancelled;
    }

    private static Task Delay(TimeSpan delay, CancellationToken token) => Task.Delay(delay, token);
}
