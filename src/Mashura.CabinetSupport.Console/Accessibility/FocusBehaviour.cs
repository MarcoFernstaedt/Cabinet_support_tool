using System.Windows;
using System.Windows.Input;

namespace Mashura.CabinetSupport.Console.Accessibility;

/// <summary>
/// Places keyboard focus on an element when it loads.
/// </summary>
/// <remarks>
/// Used to put initial focus on Cancel in confirmation dialogs. A dialog that
/// opens with focus on Confirm can consume a Return keystroke the user was
/// already pressing for something else and treat it as consent — which, for an
/// action that reboots a cabinet mid-dispense, is not a theoretical problem.
/// </remarks>
public static class FocusBehaviour
{
    public static readonly DependencyProperty FocusOnLoadProperty =
        DependencyProperty.RegisterAttached(
            "FocusOnLoad",
            typeof(bool),
            typeof(FocusBehaviour),
            new PropertyMetadata(false, OnFocusOnLoadChanged));

    public static bool GetFocusOnLoad(DependencyObject element) =>
        (bool)element.GetValue(FocusOnLoadProperty);

    public static void SetFocusOnLoad(DependencyObject element, bool value) =>
        element.SetValue(FocusOnLoadProperty, value);

    private static void OnFocusOnLoadChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is not FrameworkElement element || e.NewValue is not true)
        {
            return;
        }

        element.Loaded += (_, _) =>
        {
            // Queued at Input priority so the focus lands after the window has
            // finished arranging; setting it during Loaded is routinely
            // overridden by the window's own initial focus.
            element.Dispatcher.InvokeAsync(
                () =>
                {
                    element.Focus();
                    Keyboard.Focus(element);
                },
                System.Windows.Threading.DispatcherPriority.Input);
        };
    }
}
