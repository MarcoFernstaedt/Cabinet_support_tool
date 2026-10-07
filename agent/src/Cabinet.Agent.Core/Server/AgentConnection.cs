using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;

namespace Cabinet.Agent.Core.Server;

/// <summary>
/// Exponential backoff with full random jitter, capped at 5 minutes
/// (docs/spec/03-protocol.md), so a fleet does not reconnect in step.
/// </summary>
public sealed class Backoff(TimeSpan? first = null, TimeSpan? cap = null, Random? random = null)
{
    private readonly TimeSpan _first = first ?? TimeSpan.FromSeconds(2);
    private readonly TimeSpan _cap = cap ?? TimeSpan.FromMinutes(5);
    private readonly Random _random = random ?? Random.Shared;
    public int Attempt { get; private set; }

    public TimeSpan Next()
    {
        double ceiling = Math.Min(_cap.TotalMilliseconds, _first.TotalMilliseconds * Math.Pow(2, Math.Min(Attempt, 20)));
        Attempt++;
        return TimeSpan.FromMilliseconds(_first.TotalMilliseconds / 2 + _random.NextDouble() * (ceiling - _first.TotalMilliseconds / 2));
    }

    public void Reset() => Attempt = 0;
}

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
    public TimeSpan EventSendInterval { get; init; } = TimeSpan.FromSeconds(15);
    /// <summary>Downloads packages for package.install while online.</summary>
    public Packages.PackageDownloads? Packages { get; init; }
    /// <summary>Tells the broker the server was reached after a safety-net change; null when this agent makes no changes.</summary>
    public Func<Guid, CancellationToken, Task<SafetyNetStatus>>? ConfirmSafetyNet { get; init; }
    /// <summary>Called after every successful write (the firewall change detector looks at once, to attribute it).</summary>
    public Action? AfterWrite { get; init; }
    public TimeSpan EnrollPollInterval { get; init; } = TimeSpan.FromSeconds(60);
    public TimeSpan HeartbeatInterval { get; init; } = TimeSpan.FromSeconds(60);
    public TimeSpan RenewCheckInterval { get; init; } = TimeSpan.FromHours(6);
    public TimeSpan RenewBefore { get; init; } = TimeSpan.FromDays(30);
    public Backoff Backoff { get; init; } = new();
}

/// <summary>
/// The agent's connection to the platform server: enrollment, then the
/// heartbeat, long-poll and renewal loops. Every command still goes through
/// the six checks in <see cref="CommandProcessor"/>; the server is not trusted
/// to have sent only valid ones.
/// </summary>
public sealed class AgentConnection(AgentConnectionOptions o)
{
    private enum Ended { Cancelled, CertificateRefused, Renewed }

    /// <summary>Completed (and replaced) each time the heartbeat reaches the server after losing it, so waiting senders retry at once.</summary>
    private TaskCompletionSource _reconnected = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Runs until <paramref name="token"/> is cancelled, then returns normally.</summary>
    public async Task RunAsync(CancellationToken token)
    {
        try { await RunLoopAsync(token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private async Task RunLoopAsync(CancellationToken token)
    {
        var failures = new Backoff();
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
        using var api = new AgentApiClient(o.ServerUri, o.PlatformCa, clientCertificate: null);
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
                        Csr = o.Keys.CreateSigningRequestPem(), BootstrapToken = bootstrap, Fingerprints = o.Fingerprints(),
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
                await Delay(o.Backoff.Next(), token).ConfigureAwait(false);
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

    private async Task<Ended> OnlineAsync(AgentIdentity identity, CancellationToken token)
    {
        using X509Certificate2 certificate = o.Keys.WithPrivateKey(identity.CertificatePem);
        using var api = new AgentApiClient(o.ServerUri, o.PlatformCa, certificate);
        if (o.Packages is not null) o.Packages.Client = api;
        try { return await LoopsAsync(api, certificate, identity, token).ConfigureAwait(false); }
        finally { if (o.Packages is not null) o.Packages.Client = null; }
    }

    private async Task<Ended> LoopsAsync(AgentApiClient api, X509Certificate2 certificate, AgentIdentity identity, CancellationToken token)
    {
        CommandProcessor processor = o.ProcessorFor(o.Config with { CabinetId = identity.CabinetId });
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        var loops = new[]
        {
            HeartbeatLoopAsync(api, stop.Token),
            CommandLoopAsync(api, processor, stop.Token),
            RenewLoopAsync(api, certificate, identity, stop.Token),
            EventLoopAsync(api, stop.Token),
        };
        Task<Ended> first = await Task.WhenAny(loops).ConfigureAwait(false);
        stop.Cancel();
        try { await Task.WhenAll(loops).ConfigureAwait(false); } catch (OperationCanceledException) { }
        return token.IsCancellationRequested ? Ended.Cancelled : await first.ConfigureAwait(false);
    }

    private async Task<Ended> HeartbeatLoopAsync(AgentApiClient api, CancellationToken token)
    {
        bool online = false;
        while (!token.IsCancellationRequested)
        {
            try
            {
                double? skew = api.LastServerTime is { } t ? Math.Clamp(Math.Round((t.Local - t.Server).TotalSeconds, 1), -86_400, 86_400) : null;
                HeartbeatResponse answer = await api.HeartbeatAsync(new Heartbeat
                {
                    AgentVersion = o.AgentVersion, UptimeSeconds = o.UptimeSeconds(), ReadOnlyMode = o.Config.ReadOnlyMode, ClockSkewSeconds = skew,
                }, token).ConfigureAwait(false);
                o.Settings?.Apply(answer);
                if (!online)
                {
                    o.Log("Connected to the platform server.");
                    o.Backoff.Reset();
                    Interlocked.Exchange(ref _reconnected, new(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();
                }
                online = true;
                await Delay(o.HeartbeatInterval, token).ConfigureAwait(false);
            }
            catch (AgentApiException e) when (e.CertificateRefused) { return Ended.CertificateRefused; }
            catch (AgentApiException e)
            {
                if (online) o.Log($"Lost the platform server: {e.Message}");
                online = false;
                await Delay(o.Backoff.Next(), token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
        }
        return Ended.Cancelled;
    }

    private async Task<Ended> CommandLoopAsync(AgentApiClient api, CommandProcessor processor, CancellationToken token)
    {
        var backoff = new Backoff();
        while (!token.IsCancellationRequested)
        {
            try
            {
                IReadOnlyList<byte[]> commands = await api.CommandsAsync(token).ConfigureAwait(false);
                backoff.Reset();
                foreach (byte[] command in commands)
                {
                    var (result, dropped) = await processor.ProcessAsync(command, token).ConfigureAwait(false);
                    if (result is null) { o.Log($"Dropped a command from the server: {dropped}"); continue; }
                    o.Log($"Command {result.CommandId} {result.Status.ToString().ToLowerInvariant()}{(result.Error is null ? "" : " " + result.Error.Code)}.");
                    if (result.Status == ResultStatus.Succeeded && result.Output is { } output && output.TryGetProperty("safetyNetDeadline", out JsonElement d) &&
                        d.TryGetDateTimeOffset(out DateTimeOffset deadline) && o.ConfirmSafetyNet is not null)
                    {
                        o.AfterWrite?.Invoke();
                        if (await DeliverUnderSafetyNetAsync(api, result, deadline, token).ConfigureAwait(false)) return Ended.CertificateRefused;
                    }
                    else
                    {
                        if (result.Status == ResultStatus.Succeeded && result.Output is not null && o.ConfirmSafetyNet is not null) o.AfterWrite?.Invoke();
                        await PostResultAsync(api, result, token).ConfigureAwait(false);
                    }
                }
            }
            catch (AgentApiException e) when (e.CertificateRefused) { return Ended.CertificateRefused; }
            catch (AgentApiException) { await Delay(backoff.Next(), token).ConfigureAwait(false); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
        }
        return Ended.Cancelled;
    }

    /// <summary>
    /// Sends queued events oldest first, at most 100 at a time (docs/spec/03-protocol.md).
    /// The queue keeps them until the server has accepted them, so an outage only delays them.
    /// </summary>
    private async Task<Ended> EventLoopAsync(AgentApiClient api, CancellationToken token)
    {
        if (o.Events is null) return await Idle(token).ConfigureAwait(false);
        var backoff = new Backoff();
        while (!token.IsCancellationRequested)
        {
            Task reconnected = Volatile.Read(ref _reconnected).Task;
            var batch = o.Events.Peek(EventQueue.MaxBatch);
            try
            {
                if (batch.Count == 0) { await Delay(o.EventSendInterval, token).ConfigureAwait(false); continue; }
                var events = batch.Select(e => JsonSerializer.Deserialize<AgentEvent>(e.Json, ContractJson.Options)!).ToList();
                await api.PostEventsAsync(new EventBatch { Events = events }, token).ConfigureAwait(false);
                o.Events.Acknowledge(batch.Select(e => e.Id));
                backoff.Reset();
            }
            catch (AgentApiException e) when (e.CertificateRefused) { return Ended.CertificateRefused; }
            catch (AgentApiException e) when (e.Status == HttpStatusCode.BadRequest)
            {
                // The server's contract check refused the batch; keeping it would block every later event.
                o.Log($"The server refused {batch.Count} queued event(s) as malformed; they were dropped.");
                o.Events.Acknowledge(batch.Select(e => e.Id));
            }
            catch (AgentApiException)
            {
                // Wait out the backoff, but send at once when the heartbeat finds the server again: after an outage
                // the queued events (a safety-net rollback among them) should not sit behind a long backoff.
                if (await Task.WhenAny(Delay(backoff.Next(), token), reconnected).ConfigureAwait(false) == reconnected) backoff.Reset();
                token.ThrowIfCancellationRequested();
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
        }
        return Ended.Cancelled;
    }

    private static async Task<Ended> Idle(CancellationToken token)
    {
        try { await Task.Delay(Timeout.Infinite, token).ConfigureAwait(false); } catch (OperationCanceledException) { }
        return Ended.Cancelled;
    }

    /// <summary>
    /// The safety net, network side: the change stays only if this agent reaches the server within the window.
    /// Delivering the result is that proof, and only then is the broker told to keep the change. If the server
    /// cannot be reached in time the broker rolls the change back by itself, and the result reports that once
    /// the agent is connected again, with a security event.
    /// </summary>
    /// <returns>True when the server refused the certificate.</returns>
    private async Task<bool> DeliverUnderSafetyNetAsync(AgentApiClient api, Result result, DateTimeOffset deadline, CancellationToken token)
    {
        bool reached = false;
        while (!token.IsCancellationRequested && DateTimeOffset.UtcNow < deadline - TimeSpan.FromSeconds(3))
        {
            try { await api.PostResultAsync(result, token).ConfigureAwait(false); reached = true; break; }
            catch (AgentApiException e) when (e.CertificateRefused) { break; }
            catch (AgentApiException e) when (e.Status is HttpStatusCode.BadRequest or HttpStatusCode.NotFound or HttpStatusCode.Conflict)
            {
                reached = true; // the server answered, so it is reachable; it just did not want this result
                break;
            }
            catch (AgentApiException) { await Delay(TimeSpan.FromSeconds(3), token).ConfigureAwait(false); }
        }

        if (reached)
        {
            SafetyNetStatus? status = null;
            for (int attempt = 0; attempt < 5 && status is null && !token.IsCancellationRequested; attempt++)
            {
                try { status = await o.ConfirmSafetyNet!(result.CommandId, token).ConfigureAwait(false); }
                catch (OperationFailedException) { await Delay(TimeSpan.FromSeconds(1), token).ConfigureAwait(false); }
            }
            if (status?.State == SafetyNetState.RolledBack)
                SafetyNetEvent(result.CommandId, "The server was reached too late: the change had already been rolled back by the safety net.");
            else o.Log($"Command {result.CommandId}: the server was reached; the change is kept.");
            return false;
        }

        // Not reached in time: the broker rolls back at the deadline (and again at start-up, if it was not running).
        o.Log($"Command {result.CommandId}: the server was not reached in time; the safety net rolls the change back.");
        TimeSpan wait = deadline + TimeSpan.FromSeconds(15) - DateTimeOffset.UtcNow;
        if (wait > TimeSpan.Zero) await Delay(wait, token).ConfigureAwait(false);
        SafetyNetEvent(result.CommandId, "The cabinet could not reach the server within the safety-net window after this change, so the change was rolled back.");
        var rolledBack = result with
        {
            Status = ResultStatus.Failed, Output = null, FinishedAt = DateTimeOffset.UtcNow,
            Error = new ResultError { Code = "safety_net_rollback", Message = "The change was rolled back because the cabinet could not reach the server within the safety-net window." },
        };
        var backoff = new Backoff();
        while (!token.IsCancellationRequested)
        {
            try { await api.PostResultAsync(rolledBack, token).ConfigureAwait(false); return false; }
            catch (AgentApiException e) when (e.CertificateRefused) { return true; }
            catch (AgentApiException e) when (e.Status is HttpStatusCode.BadRequest or HttpStatusCode.NotFound or HttpStatusCode.Conflict) { return false; }
            catch (AgentApiException) { await Delay(backoff.Next(), token).ConfigureAwait(false); }
        }
        return false;
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

    /// <summary>Delivers a result, retrying network failures; a result the server will not take (already answered, unknown) is not retried.</summary>
    private async Task PostResultAsync(AgentApiClient api, Result result, CancellationToken token)
    {
        var backoff = new Backoff();
        for (int attempt = 0; attempt < 8 && !token.IsCancellationRequested; attempt++)
        {
            try { await api.PostResultAsync(result, token).ConfigureAwait(false); return; }
            catch (AgentApiException e) when (e.Status is HttpStatusCode.BadRequest or HttpStatusCode.NotFound or HttpStatusCode.Conflict)
            {
                o.Log($"The server did not accept the result for {result.CommandId} ({e.Code}).");
                return;
            }
            catch (AgentApiException e) when (!e.CertificateRefused) { await Delay(backoff.Next(), token).ConfigureAwait(false); }
        }
    }

    private async Task<Ended> RenewLoopAsync(AgentApiClient api, X509Certificate2 current, AgentIdentity identity, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            if (current.NotAfter.ToUniversalTime() - DateTime.UtcNow < o.RenewBefore)
            {
                try
                {
                    RenewResponse renewed = await api.RenewAsync(new RenewRequest { Csr = o.Keys.CreateSigningRequestPem() }, token).ConfigureAwait(false);
                    var next = identity with { CertificatePem = renewed.Certificate };
                    CheckCertificate(next);
                    o.Store.SaveIdentity(next);
                    o.Log("Renewed the cabinet's certificate.");
                    return Ended.Renewed;
                }
                catch (AgentApiException e) when (e.CertificateRefused) { return Ended.CertificateRefused; }
                catch (Exception e) when (e is AgentApiException or InvalidDataException) { o.Log($"Certificate renewal: {e.Message}"); }
            }
            try { await Delay(o.RenewCheckInterval, token).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
        return Ended.Cancelled;
    }

    private static Task Delay(TimeSpan delay, CancellationToken token) => Task.Delay(delay, token);
}
