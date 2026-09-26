using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Threading;
using CabinetPlatform.Console.Accessibility;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Console.Views;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.SequenceEqual(new[] { "--lifecycle" })) return SessionLifecycle.Run();
        try
        {
            // No App startup, window.Show, command execution, HTTP client or real credentials.
            var app = new Application();
            foreach (var resource in new[] { "Theme.Default", "Shared" })
                app.Resources.MergedDictionaries.Add(new ResourceDictionary
                {
                    Source = new Uri($"pack://application:,,,/CabinetPlatform.Console;component/Resources/{resource}.xaml")
                });
            var vm = new LoginViewModel(null!, new SessionStore(), NullLiveRegionAnnouncer.Instance);
            var window = new LoginWindow { DataContext = vm };
            var controls = Descendants(window).ToArray();
            var password = controls.OfType<PasswordBox>().Single(x => AutomationProperties.GetName(x) == "Password");
            var current = controls.OfType<PasswordBox>().Single(x => AutomationProperties.GetName(x) == "Current password");
            var button = controls.OfType<Button>().Single(x => AutomationProperties.GetName(x) == "Sign in");
            Pump();
            vm.Username = "synthetic-user";
            Pump();
            Check(vm.Password == "" && !button.IsEnabled, "initial empty binding disables sign in");
            password.Password = "synthetic-one";
            Pump();
            Check(vm.Password == "synthetic-one" && vm.SignInCommand.CanExecute(null) && button.IsEnabled,
                "typing into initially empty real LoginWindow enables sign in");
            Check(current.Password == vm.Password && !current.IsVisible, "hidden current-password field shares source");
            Check(BindingOperations.IsDataBound(password, PasswordBoxBinding.PasswordProperty), "typing retains binding");
            vm.ClearSecrets();
            Pump();
            Check(password.Password == "" && current.Password == "" && !button.IsEnabled, "VM clear reaches both fields and button");
            vm.Password = "synthetic-vm";
            Pump();
            Check(password.Password == vm.Password && current.Password == vm.Password, "VM update reaches both fields");
            for (int i = 0; i < 5; i++)
            {
                vm.ClearSecrets();
                Pump();
                Check(password.Password == "" && current.Password == "" && !button.IsEnabled,
                    "repeat VM clear " + i);
                var input = i % 2 == 0 ? password : current;
                input.Password = "synthetic-repeat-" + i;
                Pump();
                Check(vm.Password == input.Password && password.Password == vm.Password && current.Password == vm.Password && button.IsEnabled,
                    "repeat shared-field input " + i);
                Check(BindingOperations.IsDataBound(password, PasswordBoxBinding.PasswordProperty)
                    && BindingOperations.IsDataBound(current, PasswordBoxBinding.PasswordProperty),
                    "repeat shared bindings retained " + i);
            }
            password.Password = "";
            Pump();
            Check(vm.Password == "" && current.Password == "" && !button.IsEnabled, "input clear disables button");
            var newPassword = controls.OfType<PasswordBox>().Single(x => AutomationProperties.GetName(x) == "New password");
            var confirm = controls.OfType<PasswordBox>().Single(x => AutomationProperties.GetName(x) == "Confirm new password");
            newPassword.Password = "synthetic-new";
            confirm.Password = "synthetic-new";
            Pump();
            Check(vm.NewPassword == "synthetic-new" && vm.ConfirmNewPassword == "synthetic-new",
                "initially empty new-password fields update sources");
            vm.ClearSecrets();
            Pump();
            Check(newPassword.Password == "" && confirm.Password == "",
                "VM clear reaches new-password fields");
            PasswordBoxBinding.SetAttach(password, false);
            password.Password = "synthetic-detached";
            Pump();
            Check(vm.Password == "", "detached input does not update source");
            PasswordBoxBinding.SetAttach(password, true);
            PasswordBoxBinding.SetAttach(password, true);
            Check(password.Password == "", "reattach restores source value");
            password.Password = "synthetic-reattached";
            Pump();
            Check(vm.Password == password.Password && current.Password == vm.Password && button.IsEnabled,
                "idempotent reattach restores shared input");
            vm.ClearSecrets();
            Pump();
            Check(controls.OfType<PasswordBox>().All(x => x.Password == ""
                    && BindingOperations.IsDataBound(x, PasswordBoxBinding.PasswordProperty)) && !button.IsEnabled,
                "final clear retains every binding");
            window.Close();
            app.Shutdown();
            System.Console.WriteLine("PASS native regression suite; no submissions or shown windows");
            return 0;
        }
        catch (Exception ex)
        {
            System.Console.WriteLine("FAIL " + ex.Message);
            return 1;
        }
    }

    private static IEnumerable<DependencyObject> Descendants(DependencyObject parent)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(parent).OfType<DependencyObject>())
        {
            yield return child;
            foreach (var descendant in Descendants(child)) yield return descendant;
        }
    }

    private static void Pump() => Dispatcher.CurrentDispatcher.Invoke(() => { }, DispatcherPriority.ApplicationIdle);
    private static void Check(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException(name);
        System.Console.WriteLine("PASS " + name);
    }
}
