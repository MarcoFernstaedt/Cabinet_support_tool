namespace Mashura.CabinetSupport.Console.Core.Presentation;

/// <summary>
/// Drops announcements. Exists for tests that are not asserting on them; the
/// application always wires the real one.
/// </summary>
public sealed class NullLiveRegionAnnouncer : ILiveRegionAnnouncer
{
    public static NullLiveRegionAnnouncer Instance { get; } = new();

    public void Announce(string message) { }

    public void AnnounceImportant(string message) { }
}
