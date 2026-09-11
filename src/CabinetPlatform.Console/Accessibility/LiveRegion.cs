using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;

namespace CabinetPlatform.Console.Accessibility;

/// <summary>
/// Makes a <see cref="TextBlock"/> announce its own changes to a screen reader.
/// </summary>
/// <remarks>
/// <para>
/// <c>AutomationProperties.LiveSetting</c> alone declares that an element is a
/// live region; it does not tell the screen reader that the region has changed.
/// Without the accompanying <see cref="AutomationEvents.LiveRegionChanged"/>
/// event, the announcement never happens — which is the single most common way
/// a WPF application ends up with a live region that looks correct in markup
/// and says nothing in practice.
/// </para>
/// <para>
/// Attach with <c>accessibility:LiveRegion.Text="{Binding Announcement}"</c> on
/// a TextBlock that also carries a LiveSetting.
/// </para>
/// </remarks>
public static class LiveRegion
{
    public static readonly DependencyProperty TextProperty =
        DependencyProperty.RegisterAttached(
            "Text",
            typeof(string),
            typeof(LiveRegion),
            new PropertyMetadata(string.Empty, OnTextChanged));

    public static string GetText(DependencyObject element) =>
        (string)element.GetValue(TextProperty);

    public static void SetText(DependencyObject element, string value) =>
        element.SetValue(TextProperty, value);

    private static void OnTextChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is not TextBlock block)
        {
            return;
        }

        var text = e.NewValue as string ?? string.Empty;

        block.Text = text;

        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        // Nothing to raise the event to if no assistive technology is listening;
        // WPF reports that through ListenerExists, and skipping the call keeps
        // the cost at zero for everyone else.
        if (!AutomationPeer.ListenerExists(AutomationEvents.LiveRegionChanged))
        {
            return;
        }

        AutomationPeer? peer = UIElementAutomationPeer.FromElement(block)
                               ?? UIElementAutomationPeer.CreatePeerForElement(block);

        peer?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);
    }
}
