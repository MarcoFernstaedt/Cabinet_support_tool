using System.Windows;
using Mashura.CabinetSupport.Console.Accessibility;
using Mashura.CabinetSupport.Console.Core.Api;
using Mashura.CabinetSupport.Console.Core.Presentation;
using Mashura.CabinetSupport.Console.Core.ViewModels;
using Mashura.CabinetSupport.Console.Dialogs;
using Mashura.CabinetSupport.Console.Views;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Mashura.CabinetSupport.Console;

/// <summary>
/// Composition root. Everything is resolved from the container; nothing in this
/// application constructs a ViewModel with <c>new</c>.
/// </summary>
public partial class App : Application
{
    private ServiceProvider? _services;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // async void, because the override is void and start-up genuinely has
        // to await a modal sign-in. Everything inside is wrapped, since an
        // escaped exception here would take the process down with no message.
        try
        {
            await StartAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"The support console could not start.\n\n{ex.Message}",
                "Mashura Support Console",
                MessageBoxButton.OK,
                MessageBoxImage.Error);

            Shutdown(1);
        }
    }

    private async Task StartAsync()
    {
        ApplyTheme();
        SystemParameters.StaticPropertyChanged += OnSystemParametersChanged;

        IConfigurationRoot configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true)
            .AddEnvironmentVariables("MASHURA_CONSOLE_")
            .Build();

        ServiceCollection services = new();
        ConfigureServices(services, configuration);

        ServiceProvider provider = services.BuildServiceProvider();
        _services = provider;

        var shell = provider.GetRequiredService<ShellViewModel>();

        // The announcer is constructed before the shell, because the ViewModels
        // that write to it are constructed before the shell that owns them.
        provider.GetRequiredService<WpfLiveRegionAnnouncer>().Attach(shell);

        var window = new MainWindow { DataContext = shell };

        window.Closed += (_, _) =>
        {
            // The token does not outlive the window. Also cancels anything in
            // flight, so a response cannot arrive against a discarded session.
            shell.DeactivateAll();
            provider.GetRequiredService<ISessionStore>().SignOut();
            Shutdown();
        };

        // An expiry or a sign-out puts the login window back in front of the
        // main window rather than closing the application. A support engineer
        // whose token lapsed while they were reading a cabinet should be one
        // sign-in away from the same cabinet, not one restart.
        shell.SignInRequired += async (_, reason) =>
        {
            try
            {
                if (!await SignInAsync(window, reason))
                {
                    window.Close();
                    return;
                }

                await shell.StartSessionAsync();
            }
            catch (Exception ex)
            {
                // async void: an escaped exception here would terminate the
                // process without a word, which is the one outcome worse than a
                // failed re-authentication.
                MessageBox.Show(
                    $"Signing back in failed.\n\n{ex.Message}",
                    "Mashura Support Console",
                    MessageBoxButton.OK,
                    MessageBoxImage.Error);

                window.Close();
            }
        };

        MainWindow = window;

        if (!await SignInAsync(owner: null, SignInReason.SignedOut))
        {
            // Cancelled at the first sign-in prompt: there is nothing to show.
            Shutdown();
            return;
        }

        window.Show();
        await shell.StartSessionAsync();
    }

    /// <summary>
    /// Shows the login window and returns whether a usable session resulted.
    /// </summary>
    /// <remarks>
    /// The login window is modal and separate from the main window, so there is
    /// no state in which the console is showing cabinet data behind a sign-in
    /// prompt. On an expiry the main window stays open behind it: the user gets
    /// their place back rather than a restart.
    /// </remarks>
    private async Task<bool> SignInAsync(Window? owner, SignInReason reason)
    {
        var login = _services!.GetRequiredService<LoginViewModel>();

        login.Reset();

        if (reason == SignInReason.SessionExpired)
        {
            login.ExplainExpiredSession();
        }

        var dialog = new LoginWindow { DataContext = login };

        if (owner is not null && owner.IsVisible)
        {
            dialog.Owner = owner;
        }

        bool signedIn = dialog.ShowDialog() == true;

        // Whatever happened, nothing typed into the dialog stays in memory.
        login.ClearSecrets();

        // ShowDialog runs its own message loop, so there is nothing genuinely
        // asynchronous to await here. The yield keeps the signature honest
        // rather than returning an already-completed task from a method the
        // callers treat as async.
        await Task.Yield();

        return signedIn;
    }

    private void ConfigureServices(IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<ApiClientOptions>(configuration.GetSection(ApiClientOptions.SectionName));

        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<ISessionStore, SessionStore>();
        services.AddTransient<BearerTokenHandler>();

        // One announcer, registered under both its concrete type and the
        // interface, so the ViewModels take the abstraction while startup can
        // still attach the shell to the one instance.
        services.AddSingleton(_ => new WpfLiveRegionAnnouncer(Dispatcher));
        services.AddSingleton<ILiveRegionAnnouncer>(
            sp => sp.GetRequiredService<WpfLiveRegionAnnouncer>());

        services.AddHttpClient<ApiClient>((sp, http) =>
            {
                ApiClientOptions options = sp.GetRequiredService<IOptions<ApiClientOptions>>().Value;

                http.BaseAddress = new Uri(options.BaseAddress);
                http.Timeout = TimeSpan.FromSeconds(Math.Max(5, options.TimeoutSeconds));
                http.DefaultRequestHeaders.Accept.Add(
                    new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
            })
            .AddHttpMessageHandler<BearerTokenHandler>();

        // AddHttpClient registers its typed client as transient, and every
        // ViewModel here is a singleton — so left alone, each of the seven would
        // capture its own client. One is enough and is what was intended.
        //
        // The cost of pinning it is that its handler is never rotated, so a DNS
        // change behind the server's name would not be picked up until the
        // console restarts. For a desktop tool pointed at one fixed internal
        // host for the length of a shift, that is the right trade; a service
        // making continuous calls would want the factory per request instead.
        services.AddSingleton<IApiClient>(sp => sp.GetRequiredService<ApiClient>());

        services.AddSingleton<IActionRequestDialog, ActionRequestDialogService>();
        services.AddSingleton<IApprovalDecisionDialog, ApprovalDecisionDialogService>();
        services.AddSingleton<ActionInvoker>();

        services.AddSingleton<LoginViewModel>();
        services.AddSingleton<CabinetListViewModel>();
        services.AddSingleton<MachineTabViewModel>();
        services.AddSingleton<CabinetTabViewModel>();
        services.AddSingleton<AuditTabViewModel>();
        services.AddSingleton<FleetTabViewModel>();
        services.AddSingleton<ApprovalsViewModel>();
        services.AddSingleton<ShellViewModel>();
    }

    /// <summary>
    /// Swaps the palette when the user turns high contrast on or off, without
    /// restarting. A support engineer who needs high contrast should not have
    /// to close the tool to get it.
    /// </summary>
    private void OnSystemParametersChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(SystemParameters.HighContrast))
        {
            Dispatcher.InvokeAsync(ApplyTheme);
        }
    }

    private void ApplyTheme()
    {
        // Absolute pack URI: a relative one built at runtime resolves against
        // the working directory rather than the assembly, which fails as soon
        // as the console is launched from anywhere but its own folder.
        const string prefix = "pack://application:,,,/Mashura.CabinetSupport.Console;component/Resources/";

        string source = SystemParameters.HighContrast
            ? prefix + "Theme.HighContrast.xaml"
            : prefix + "Theme.Default.xaml";

        var palette = new ResourceDictionary
        {
            Source = new Uri(source, UriKind.Absolute)
        };

        if (Resources.MergedDictionaries.Count == 0)
        {
            Resources.MergedDictionaries.Add(palette);
        }
        else
        {
            // Index 0 by convention: the palette is merged first so Shared.xaml
            // can resolve against it.
            Resources.MergedDictionaries[0] = palette;
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        SystemParameters.StaticPropertyChanged -= OnSystemParametersChanged;

        _services?.GetService<ISessionStore>()?.SignOut();
        _services?.Dispose();

        base.OnExit(e);
    }
}
