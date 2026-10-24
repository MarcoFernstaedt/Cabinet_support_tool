using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Upgrades;

/// <summary>
/// The updater's journal (agent/upgrade-journal.schema.json), in the broker's folder. Written before every step,
/// replaced atomically, and validated when read: a damaged journal is treated as no journal.
/// </summary>
public sealed class UpgradeJournalStore(string path)
{
    public string Path { get; } = path;

    public UpgradeJournal? Read()
    {
        try
        {
            if (!File.Exists(Path) || new FileInfo(Path).Length > 8192) return null;
            if (!StrictJson.TryParse(File.ReadAllBytes(Path), 8192, out JsonDocument? doc)) return null;
            using (doc)
                return ContractSchemas.Instance.IsValid(ContractSchemas.Local("upgrade-journal"), doc!.RootElement)
                    ? doc.RootElement.Deserialize<UpgradeJournal>(ContractJson.Options) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }

    public UpgradeJournal Write(UpgradeJournal journal)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        string temp = Path + ".tmp";
        File.WriteAllBytes(temp, JsonSerializer.SerializeToUtf8Bytes(journal, ContractJson.Options));
        File.Move(temp, Path, overwrite: true);
        return journal;
    }
}

/// <summary>The network service's record that a heartbeat reached the server (agent/check-in.schema.json).</summary>
public static class CheckInFile
{
    public static void Write(string path, string version, DateTimeOffset at)
    {
        string temp = path + ".tmp";
        File.WriteAllBytes(temp, JsonSerializer.SerializeToUtf8Bytes(new CheckIn { Version = version, At = at }, ContractJson.Options));
        File.Move(temp, path, overwrite: true);
    }

    public static CheckIn? Read(string path)
    {
        try
        {
            if (!File.Exists(path) || new FileInfo(path).Length > 1024) return null;
            if (!StrictJson.TryParse(File.ReadAllBytes(path), 1024, out JsonDocument? doc)) return null;
            using (doc)
                return ContractSchemas.Instance.IsValid(ContractSchemas.Local("check-in"), doc!.RootElement) ? doc.RootElement.Deserialize<CheckIn>(ContractJson.Options) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }
}

/// <param name="Install">The agent's program folder (one subfolder per program).</param>
/// <param name="Backup">Where the running version is kept while the new one proves itself.</param>
/// <param name="Staged">The verified release's files, in the broker's staging folder.</param>
/// <param name="CheckIn">The network service's check-in file.</param>
public sealed record UpdaterPaths(string Install, string Backup, string Staged, string CheckIn);

/// <summary>What only Windows can do for the updater: stop and start the two agent services.</summary>
public interface IUpdaterPlatform
{
    /// <summary>Stops the network service, then the broker, and waits until both processes have exited.</summary>
    void StopServices();
    /// <summary>Starts the broker, then the network service.</summary>
    void StartServices();
}

/// <summary>
/// The updater (docs/spec/07-upgrade-channel.md "Installing on the cabinet"): stops the services, keeps the
/// running version as a backup, puts the verified new version in place and starts the services. The new
/// version must check in with the server within 5 minutes; if it does not, or if anything fails on the way, the
/// backup is put back and the old version started again. Every step is written to the journal first, so an
/// updater cut short (a power cut, a reboot) is finished or undone by <see cref="Resume"/> when the broker starts.
/// It runs only a release the broker has already verified in full, and takes no path from anyone: the broker
/// starts it with a single fixed verb.
/// </summary>
public sealed class Updater(UpdaterPaths paths, UpgradeJournalStore journal, IUpdaterPlatform platform, TimeProvider clock, Action<string> log)
{
    public static readonly TimeSpan DefaultCheckInWindow = TimeSpan.FromMinutes(5);
    public TimeSpan CheckInWindow { get; init; } = DefaultCheckInWindow;
    private static readonly TimeSpan ClockSkew = TimeSpan.FromSeconds(30);
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(5);
    /// <summary>How long a locked file may keep a move or delete waiting.</summary>
    public TimeSpan FileRetry { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>Installs the release the journal records as verified.</summary>
    public UpgradeJournal Run()
    {
        UpgradeJournal j = journal.Read() ?? throw new InvalidOperationException("There is no upgrade to run.");
        if (j.Phase != UpgradePhase.Verified) return Resume() ?? j;
        log($"Upgrading the agent from {j.FromVersion} to {j.Version}.");
        j = journal.Write(j with { Phase = UpgradePhase.Stopping });
        try { platform.StopServices(); }
        catch (Exception e) { return Fail(j, $"The services could not be stopped ({e.GetType().Name}); nothing was changed."); }

        j = journal.Write(j with { Phase = UpgradePhase.BackingUp });
        try
        {
            Retry(() => { if (Directory.Exists(paths.Backup)) Directory.Delete(paths.Backup, recursive: true); });
            Retry(() => Directory.Move(paths.Install, paths.Backup));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Fail(j, $"The running version could not be set aside ({e.GetType().Name}); nothing was changed.");
        }

        j = journal.Write(j with { Phase = UpgradePhase.Installing });
        try { CopyFolder(paths.Staged, paths.Install); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Restore(j, UpgradeCheck.Install, $"The new version could not be put in place ({e.GetType().Name}).");
        }
        return StartAndWait(j);
    }

    /// <summary>Finishes or undoes an upgrade that was cut short. Does nothing when the journal is final or absent.</summary>
    public UpgradeJournal? Resume()
    {
        UpgradeJournal? j = journal.Read();
        if (j is null || j.Final) return j;
        log($"Resuming the upgrade to {j.Version}, which stopped while {j.Phase}.");
        switch (j.Phase)
        {
            case UpgradePhase.Verified:
                return Fail(j, "The upgrade stopped before it started; nothing was changed.");
            case UpgradePhase.Stopping:
                return Fail(j, "The upgrade stopped while stopping the services; nothing was changed.");
            case UpgradePhase.BackingUp when !Directory.Exists(paths.Backup) || Directory.Exists(paths.Install):
                // The move never happened (it is all or nothing), so the old version is still in place.
                return Fail(j, "The upgrade stopped before the running version was set aside; nothing was changed.");
            case UpgradePhase.BackingUp:
            case UpgradePhase.Installing:
                return Restore(j, UpgradeCheck.Install, "The upgrade stopped while the new version was being put in place.");
            case UpgradePhase.Waiting:
                return Wait(j);
            default:
                return j;
        }
    }

    private UpgradeJournal StartAndWait(UpgradeJournal j)
    {
        j = journal.Write(j with { Phase = UpgradePhase.Waiting, CheckInBy = clock.GetUtcNow() + CheckInWindow });
        try { platform.StartServices(); }
        catch (Exception e) { log($"The new version did not start ({e.GetType().Name}); waiting for its check-in anyway."); }
        return Wait(j);
    }

    private UpgradeJournal Wait(UpgradeJournal j)
    {
        DateTimeOffset by = j.CheckInBy ?? clock.GetUtcNow();
        // The check-in file is written by the network service, so a check-in counts only if it was written after the new
        // version was started (the start of this wait) and is not dated in the future: an old network service cannot leave
        // one in advance that would keep a broken release.
        DateTimeOffset startedWaiting = by - CheckInWindow;
        while (true)
        {
            DateTimeOffset now = clock.GetUtcNow();
            if (CheckInFile.Read(paths.CheckIn) is { } c && c.Version == j.Version && c.At >= startedWaiting && c.At <= now + ClockSkew)
            {
                log($"Version {j.Version} checked in with the server; the upgrade is complete.");
                TryDelete(paths.Staged);
                return journal.Write(j with { Phase = UpgradePhase.Succeeded, FinishedAt = clock.GetUtcNow(), Message = $"{j.Version} is running and checked in." });
            }
            if (clock.GetUtcNow() >= by) break;
            Thread.Sleep(PollInterval);
        }
        return Restore(j, UpgradeCheck.CheckIn, $"Version {j.Version} did not check in with the server within {CheckInWindow.TotalMinutes:0.#} minutes.");
    }

    /// <summary>Puts the backup back and starts the old version.</summary>
    private UpgradeJournal Restore(UpgradeJournal j, UpgradeCheck check, string why)
    {
        log($"{why} Restoring {j.FromVersion}.");
        try
        {
            try { platform.StopServices(); } catch (Exception e) { log($"Stopping the new version: {e.GetType().Name}."); }
            // The set-aside copy is what makes this the rollback it is called: without it there is nothing to put back,
            // so this is a failure to restore rather than a restore that was skipped.
            if (!Directory.Exists(paths.Backup)) throw new InvalidOperationException("The set-aside copy of the running version is gone.");
            Retry(() => { if (Directory.Exists(paths.Install)) Directory.Delete(paths.Install, recursive: true); });
            Retry(() => Directory.Move(paths.Backup, paths.Install));
            platform.StartServices();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            log($"Restoring {j.FromVersion} failed ({e.GetType().Name}).");
            // Deliberately not final and left as installing: the next start of the broker runs Resume and tries the
            // restore again, instead of leaving a half-installed agent that nothing repairs (spec 07). The services are
            // asked to start as well, so a retry does not begin with them stopped.
            try { platform.StartServices(); } catch (Exception start) { log($"Starting the services after the failed restore: {start.GetType().Name}."); }
            return journal.Write(j with { Phase = UpgradePhase.Installing, Check = check, FinishedAt = clock.GetUtcNow(),
                Message = Short($"{why} Restoring {j.FromVersion} also failed ({e.GetType().Name}); the cabinet needs a visit.") });
        }
        TryDelete(paths.Staged);
        return journal.Write(j with { Phase = UpgradePhase.RolledBack, Check = check, FinishedAt = clock.GetUtcNow(), Message = Short($"{why} {j.FromVersion} was restored.") });
    }

    private UpgradeJournal Fail(UpgradeJournal j, string why)
    {
        log(why);
        try { platform.StartServices(); } catch (Exception e) { log($"Starting the services: {e.GetType().Name}."); }
        TryDelete(paths.Staged);
        return journal.Write(j with { Phase = UpgradePhase.Failed, Check = UpgradeCheck.Install, FinishedAt = clock.GetUtcNow(), Message = Short(why) });
    }

    private void Retry(Action action)
    {
        DateTimeOffset until = clock.GetUtcNow() + FileRetry;
        while (true)
        {
            try { action(); return; }
            catch (Exception e) when ((e is IOException or UnauthorizedAccessException) && clock.GetUtcNow() < until) { Thread.Sleep(TimeSpan.FromSeconds(1)); }
        }
    }

    private static void CopyFolder(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (string dir in Directory.EnumerateDirectories(from, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(System.IO.Path.Combine(to, System.IO.Path.GetRelativePath(from, dir)));
        foreach (string file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
            File.Copy(file, System.IO.Path.Combine(to, System.IO.Path.GetRelativePath(from, file)));
    }

    private static void TryDelete(string folder)
    {
        try { if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    private static string Short(string s) => Helpers.EventText.ShortText(s);
}
