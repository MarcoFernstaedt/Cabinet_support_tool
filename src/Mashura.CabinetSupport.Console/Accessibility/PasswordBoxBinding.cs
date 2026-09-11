using System.Windows;
using System.Windows.Controls;

namespace Mashura.CabinetSupport.Console.Accessibility;

/// <summary>
/// Lets a <see cref="PasswordBox"/> participate in binding.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="PasswordBox.Password"/> is deliberately not a dependency property,
/// so it cannot be bound. The usual workarounds are a code-behind event handler
/// or passing the box itself into a command — both of which put the credential
/// into the view's logic and take the sign-in flow out of the ViewModel, where
/// it can be tested.
/// </para>
/// <para>
/// This carries the value into a ViewModel property that is held in memory only
/// and cleared the moment the server has answered. Nothing here logs it, and
/// nothing writes it anywhere.
/// </para>
/// </remarks>
public static class PasswordBoxBinding
{
    public static readonly DependencyProperty PasswordProperty =
        DependencyProperty.RegisterAttached(
            "Password",
            typeof(string),
            typeof(PasswordBoxBinding),
            new FrameworkPropertyMetadata(
                string.Empty,
                FrameworkPropertyMetadataOptions.BindsTwoWayByDefault,
                OnPasswordChanged));

    private static readonly DependencyProperty UpdatingProperty =
        DependencyProperty.RegisterAttached(
            "Updating", typeof(bool), typeof(PasswordBoxBinding), new PropertyMetadata(false));

    public static string GetPassword(DependencyObject element) =>
        (string)element.GetValue(PasswordProperty);

    public static void SetPassword(DependencyObject element, string value) =>
        element.SetValue(PasswordProperty, value);

    private static void OnPasswordChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is not PasswordBox box)
        {
            return;
        }

        box.PasswordChanged -= HandlePasswordChanged;

        // Guarded so the ViewModel clearing the property does not feed back as a
        // change from the box, which would otherwise blank the property a second
        // time and, in the wrong order, blank the user's keystrokes.
        if (!(bool)box.GetValue(UpdatingProperty))
        {
            box.Password = e.NewValue as string ?? string.Empty;
        }

        box.PasswordChanged += HandlePasswordChanged;
    }

    private static void HandlePasswordChanged(object sender, RoutedEventArgs e)
    {
        var box = (PasswordBox)sender;

        box.SetValue(UpdatingProperty, true);
        SetPassword(box, box.Password);
        box.SetValue(UpdatingProperty, false);
    }
}
