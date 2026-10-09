using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Monitoring;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Upgrades;

/// <summary>
/// The network service's half of an upgrade (docs/spec/07-upgrade-channel.md steps 5 to 7). After each heartbeat
/// that reaches the server it: records the check-in the updater waits for; reports an upgrade the updater has
/// finished (once); and, when the server offers a newer version, downloads the release into its downloads folder
/// and asks the broker to install it, by version only. It checks nothing that matters itself; the broker does.
/// Every refusal is reported with its exact check, and also sent as a security event, because a release that
/// fails its checks means someone tried to run code on the cabinet.
/// </summary>
public sealed class UpgradeCoordinator(string downloads, string runningVersion, UpgradeJournalStore journal, string checkInPath, string reportedPath,
    Func<string, CancellationToken, Task<(bool Ok, ResultError? Error)>> brokerUpgrade, EventQueue? events, TimeProvider clock, Action<string> log)
{
    private readonly object _gate = new();
    private readonly HashSet<string> _attempted = new(StringComparer.Ordinal);
    private readonly Queue<UpgradeStatus> _unsent = new();
    private Task _current = Task.CompletedTask;

    /// <summary>The attempt in progress (tests wait on it).</summary>
    public Task Current { get { lock (_gate) return _current; } }

    public async Task AfterHeartbeatAsync(AgentApiClient api, HeartbeatResponse answer, CancellationToken token)
    {
        try { CheckInFile.Write(checkInPath, runningVersion, clock.GetUtcNow()); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { log($"Could not record the check-in ({e.GetType().Name})."); }
        await ReportAsync(api, token).ConfigureAwait(false);
        if (answer.Upgrade is { } offer) Offer(api, offer.Version, token);
    }

    private async Task ReportAsync(AgentApiClient api, CancellationToken token)
    {
        UpgradeJournal? done = journal.Read();
        if (done is { Final: true } && ReadReported() != done.UpgradeId.ToString("D"))
        {
            var status = new UpgradeStatus
            {
                Version = done.Version, FromVersion = done.FromVersion,
                Outcome = done.Phase switch { UpgradePhase.Succeeded => UpgradeOutcome.Succeeded, UpgradePhase.RolledBack => UpgradeOutcome.RolledBack, _ => UpgradeOutcome.Failed },
                Check = done.Phase == UpgradePhase.Succeeded ? null : done.Check ?? UpgradeCheck.Install,
                Message = done.Message ?? done.Phase.ToString(),
            };
            if (await SendAsync(api, status, token).ConfigureAwait(false))
                try { File.WriteAllText(reportedPath, done.UpgradeId.ToString("D")); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
        while (true)
        {
            UpgradeStatus next;
            lock (_gate) { if (_unsent.Count == 0) break; next = _unsent.Peek(); }
            if (!await SendAsync(api, next, token).ConfigureAwait(false)) break;
            lock (_gate) _unsent.Dequeue();
        }
    }

    private async Task<bool> SendAsync(AgentApiClient api, UpgradeStatus status, CancellationToken token)
    {
        try
        {
            await api.PostUpgradeStatusAsync(status, token).ConfigureAwait(false);
            log($"Reported the upgrade to {status.Version}: {status.Outcome}{(status.Check is { } c ? $" ({c})" : "")}.");
            return true;
        }
        catch (AgentApiException e) when (e.Status is System.Net.HttpStatusCode.BadRequest or System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Conflict)
        {
            log($"The server did not take the upgrade report ({e.Code}).");
            return true; // not retried: the server has no rollout for it
        }
        catch (AgentApiException) { return false; }
    }

    private void Offer(AgentApiClient api, string version, CancellationToken token)
    {
        if (!SemVersion.TryParse(version, out SemVersion offered) || offered <= SemVersion.Parse(runningVersion)) return;
        lock (_gate)
        {
            if (!_current.IsCompleted || _attempted.Contains(offered.ToString())) return;
            // Busy, or this version already ended here without succeeding (a rolled-back release is not tried again; the server stops offering it).
            // A version offered while busy is not marked attempted, so the next offer after the earlier upgrade ends still counts.
            if (journal.Read() is { } last && (!last.Final || (last.Version == offered.ToString() && last.Phase != UpgradePhase.Succeeded))) return;
            _attempted.Add(offered.ToString());
            _current = Task.Run(() => AttemptAsync(api, offered.ToString(), token), token);
        }
    }

    private async Task AttemptAsync(AgentApiClient api, string version, CancellationToken token)
    {
        log($"The server offers agent {version}; downloading it.");
        string folder = ReleaseVerifier.DownloadFolder(downloads, version);
        try
        {
            if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
            Directory.CreateDirectory(folder);
            UpdateResponse release = await api.GetUpdateAsync(version, token).ConfigureAwait(false);
            byte[] manifest;
            try { manifest = Convert.FromBase64String(release.Manifest); } catch (FormatException) { manifest = []; }
            await File.WriteAllBytesAsync(Path.Combine(folder, ReleaseVerifier.ManifestFile), manifest, token).ConfigureAwait(false);
            await File.WriteAllBytesAsync(Path.Combine(folder, ReleaseVerifier.SignatureFile),
                System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(release.Signature, ContractJson.Options), token).ConfigureAwait(false);
            await api.DownloadUpdateAsync(version, Path.Combine(folder, ReleaseVerifier.PackageFile), ReleaseVerifier.MaxPackageBytes, token).ConfigureAwait(false);
        }
        catch (Exception e) when (e is AgentApiException or IOException or UnauthorizedAccessException)
        {
            Queue(new UpgradeStatus { Version = version, FromVersion = runningVersion, Outcome = UpgradeOutcome.Failed, Check = UpgradeCheck.Download,
                Message = Helpers.EventText.ShortText($"The release could not be downloaded: {e.Message}") });
            return;
        }

        (bool ok, ResultError? error) outcome;
        try { outcome = await brokerUpgrade(version, token).ConfigureAwait(false); }
        finally
        {
            // The broker works only from its own copy, so the network service removes its download whatever happened.
            try { if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
        var (ok, error) = outcome;
        if (!ok && error is null or { Code: "unavailable" })
            lock (_gate) _attempted.Remove(version); // the broker was busy or unreachable: the release was never judged, so a later offer may try again
        if (ok)
        {
            log($"The broker verified agent {version} and started the updater.");
            return;
        }
        UpgradeCheck check = error?.Check ?? UpgradeCheck.Install;
        bool refused = check is UpgradeCheck.ManifestSignature or UpgradeCheck.Manifest or UpgradeCheck.PackageHash or UpgradeCheck.Version or UpgradeCheck.Authenticode;
        string message = error?.Message ?? "The broker did not answer.";
        Queue(new UpgradeStatus { Version = version, FromVersion = runningVersion, Outcome = refused ? UpgradeOutcome.Refused : UpgradeOutcome.Failed, Check = check, Message = message });
        if (refused)
        {
            // signature_invalid, hash_mismatch and publisher_not_trusted map to their own security alerts; the rest is a refused package.
            string kind = error?.Code is "signature_invalid" or "hash_mismatch" or "publisher_not_trusted" ? error.Code : "package_refused";
            events?.Enqueue(new AgentEvent
            {
                EventId = EventIds.For($"upgrade-refused|{version}|{check}|{clock.GetUtcNow():yyyy-MM-dd}"), Kind = EventKind.Security, OccurredAt = clock.GetUtcNow(),
                SeverityHint = SeverityHint.Major,
                Detail = new EventDetail
                {
                    Message = Helpers.EventText.ShortText($"Agent release {version} was refused at the {check} check: {message}"),
                    Fields = new Dictionary<string, string> { ["check"] = kind, ["upgradeCheck"] = Snake(check), ["version"] = version },
                },
            });
        }
    }

    private void Queue(UpgradeStatus status)
    {
        log($"Agent {status.Version}: {status.Outcome} at the {status.Check} check: {status.Message}");
        lock (_gate) _unsent.Enqueue(status);
    }

    private string? ReadReported()
    {
        try { return File.Exists(reportedPath) ? File.ReadAllText(reportedPath).Trim() : null; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
    }

    private static string Snake(UpgradeCheck c) => System.Text.Json.JsonNamingPolicy.SnakeCaseLower.ConvertName(c.ToString());
}
