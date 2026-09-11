using System.Windows.Threading;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;

namespace CabinetPlatform.Console.Accessibility;

/// <summary>
/// Routes ViewModel announcements to the window's live region.
/// </summary>
/// <remarks>
/// <para>
/// Marshals to the UI thread, because announcements are raised from the
/// continuation of an HTTP call and that continuation is not guaranteed to be
/// on it.
/// </para>
/// <para>
/// Two consecutive identical messages would not be announced a second time —
/// the bound text does not change, so no change event fires. "Refreshed"
/// pressed twice has to be heard twice, so a repeat is nudged through with a
/// trailing space that screen readers do not voice.
/// </para>
/// </remarks>
public sealed class WpfLiveRegionAnnouncer : ILiveRegionAnnouncer
{
    private readonly Dispatcher _dispatcher;
    private ShellViewModel? _shell;
    private string _last = string.Empty;

    public WpfLiveRegionAnnouncer(Dispatcher dispatcher) => _dispatcher = dispatcher;

    /// <summary>
    /// Attached once the shell exists. The announcer is constructed first
    /// because the ViewModels that depend on it are constructed before the
    /// shell that owns them.
    /// </summary>
    public void Attach(ShellViewModel shell) => _shell = shell;

    public void Announce(string message) => Post(message);

    public void AnnounceImportant(string message) => Post(message);

    private void Post(string message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return;
        }

        if (!_dispatcher.CheckAccess())
        {
            _dispatcher.InvokeAsync(() => Post(message));
            return;
        }

        string text = message == _last ? message + " " : message;
        _last = message;

        _shell?.SetAnnouncement(text);
    }
}
