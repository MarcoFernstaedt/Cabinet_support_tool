namespace Mashura.CabinetSupport.Console.Core.Presentation;

/// <summary>
/// Keeps every announcement so a test can assert that an async result was
/// actually announced — the accessibility requirement that is easiest to break
/// silently, and so the one most worth pinning down in a test.
/// </summary>
public sealed class RecordingLiveRegionAnnouncer : ILiveRegionAnnouncer
{
    private readonly List<Announcement> _announcements = new();

    public IReadOnlyList<Announcement> Announcements => _announcements;

    public void Announce(string message) => _announcements.Add(new Announcement(message, false));

    public void AnnounceImportant(string message) => _announcements.Add(new Announcement(message, true));

    public bool Any(string substring) => _announcements
        .Any(a => a.Message.Contains(substring, StringComparison.OrdinalIgnoreCase));

    public sealed record Announcement(string Message, bool IsImportant);
}
