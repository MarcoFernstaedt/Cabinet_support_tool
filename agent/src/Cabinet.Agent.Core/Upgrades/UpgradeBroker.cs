using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Upgrades;

/// <summary>Starts the signed updater program. Windows copies it out of the program folder first, so it can replace that folder.</summary>
public interface IUpdaterLauncher
{
    /// <summary>Whether an updater is running now.</summary>
    bool Running { get; }
    /// <summary>Starts the updater with one fixed verb ("run" or "resume"), by full path, and returns at once.</summary>
    void Launch(string verb);
}

/// <summary>
/// The broker's half of an upgrade: a request names a version only; the broker verifies that release in full
/// (<see cref="ReleaseVerifier"/>), records it in the journal and starts the updater. At start-up it resumes an
/// upgrade a restart cut short. It answers with the exact check that refused a release. It only ever reads from the
/// network service's downloads folder (the network service removes its own download): SYSTEM never deletes or writes
/// through a folder a less trusted account can change, since that account could turn it into a link elsewhere.
/// </summary>
public sealed class UpgradeBroker(ReleaseVerifier verifier, UpgradeJournalStore journal, string downloads, string staging, string runningVersion,
    IUpdaterLauncher launcher, TimeProvider clock, Action<string> log)
{
    public (JsonElement? Output, ResultError? Error) Start(string version)
    {
        if (launcher.Running || journal.Read() is { Final: false })
            return (null, new ResultError { Code = "unavailable", Message = "An upgrade is already in progress.", Check = UpgradeCheck.Install });
        try
        {
            VerifiedRelease release = verifier.Verify(downloads, version, runningVersion, staging);
            log($"Release {release.Manifest.Version} passed every check: signature, hash, version and Authenticode.");
            var entry = journal.Write(new UpgradeJournal
            {
                UpgradeId = Guid.NewGuid(), Version = release.Manifest.Version, FromVersion = runningVersion, Phase = UpgradePhase.Verified, StartedAt = clock.GetUtcNow(),
            });
            try { launcher.Launch("run"); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                journal.Write(entry with { Phase = UpgradePhase.Failed, Check = UpgradeCheck.Install, FinishedAt = clock.GetUtcNow(), Message = "The updater could not be started." });
                ReleaseVerifier.ResetFolder(staging);
                return (null, new ResultError { Code = "execution_failed", Message = "The updater could not be started.", Check = UpgradeCheck.Install });
            }
            return (JsonSerializer.SerializeToElement(new { started = true, version = release.Manifest.Version }), null);
        }
        catch (UpgradeRefusedException e)
        {
            log($"Release {version} refused at the {e.Check} check: {e.Message}");
            return (null, new ResultError { Code = e.Code, Message = Helpers.EventText.ShortText(e.Message), Check = e.Check });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            log($"Release {version} could not be checked ({e.GetType().Name}).");
            return (null, new ResultError { Code = "execution_failed", Message = "The release could not be read for checking.", Check = UpgradeCheck.Download });
        }
    }

    /// <summary>At broker start-up: an upgrade the journal shows unfinished, with no updater running, is finished or undone.</summary>
    public void ResumeIfNeeded()
    {
        if (journal.Read() is { Final: false } j && !launcher.Running)
        {
            log($"The upgrade to {j.Version} was cut short while {j.Phase}; starting the updater to finish or undo it.");
            launcher.Launch("resume");
        }
    }
}
