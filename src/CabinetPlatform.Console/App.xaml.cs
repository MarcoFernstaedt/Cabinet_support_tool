using System.Windows;
using System.Windows.Threading;
using CabinetPlatform.Console.Accessibility;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Console.Dialogs;
using CabinetPlatform.Console.Views;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Console;

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

        SignInReason reason = SignInReason.SignedOut;
        while (true)
        {
            // Singletons belong to one login attempt/session, never the process.
            // A new account gets a new store, client, announcer and every screen.
            ServiceCollection services = new();
            ConfigureServices(services, configuration);
            using ServiceProvider provider = services.BuildServiceProvider();
            _services = provider;
            try
            {
                if (!await SignInAsync(reason)) break;

                var shell = provider.GetRequiredService<ShellViewModel>();
                provider.GetRequiredService<WpfLiveRegionAnnouncer>().Attach(shell);
                var window = new MainWindow { DataContext = shell };
                using var probeLifetime = new CancellationTokenSource();
                var sessionProbe = new DispatcherTimer(DispatcherPriority.Background, Dispatcher)
                {
                    Interval = TimeSpan.FromSeconds(15)
                };
                bool probeBusy = false;
                async void ProbeSession(object? sender, EventArgs args)
                {
                    if (probeBusy || probeLifetime.IsCancellationRequested) return;
                    probeBusy = true;
                    try { await shell.CheckSessionAsync(probeLifetime.Token); }
                    catch (OperationCanceledException) when (probeLifetime.IsCancellationRequested) { }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"Session check: {ex.GetType().Name}");
                    }
                    finally { probeBusy = false; }
                }
                sessionProbe.Tick += ProbeSession;
                var finished = new TaskCompletionSource<SignInReason?>(TaskCreationOptions.RunContinuationsAsynchronously);
                void RequireSignIn(object? sender, SignInReason nextReason)
                {
                    finished.TrySetResult(nextReason);
                    window.Close(); // Synchronous: no authenticated window behind login.
                }
                shell.SignInRequired += RequireSignIn;
                window.Closed += (_, _) =>
                {
                    shell.Dispose();
                    window.DataContext = null;
                    finished.TrySetResult(null); // A normal window close exits.
                };
                MainWindow = window;
                try
                {
                    window.Show();
                    sessionProbe.Start();
                    Task loading = shell.StartSessionAsync();
                    // Sign-out must not wait for a slow server or a late body.
                    if (await Task.WhenAny(loading, finished.Task) == loading)
                        await loading;
                    else
                        _ = ObserveRetiredLoadAsync(loading);
                    SignInReason? next = await finished.Task;
                    if (next is null) break;
                    reason = next.Value;
                }
                finally
                {
                    sessionProbe.Stop();
                    sessionProbe.Tick -= ProbeSession;
                    probeLifetime.Cancel();
                    shell.SignInRequired -= RequireSignIn;
                    shell.Dispose();
                    window.Close();
                    window.DataContext = null;
                }
            }
            finally
            {
                provider.GetRequiredService<ISessionStore>().SignOut();
                _services = null;
            }
            // provider.Dispose runs before the next login is created.
        }
        Shutdown();
    }

    private static async Task ObserveRetiredLoadAsync(Task loading)
    {
        try { await loading; }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            // The retired graph cannot report into another operator's window.
            System.Diagnostics.Debug.WriteLine($"Retired session load: {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// Shows the login window and returns whether a usable session resulted.
    /// </summary>
    /// <remarks>No authenticated window exists while this dialog is open.</remarks>
    private async Task<bool> SignInAsync(SignInReason reason)
    {
        var login = _services!.GetRequiredService<LoginViewModel>();
        login.Reset();
        if (reason == SignInReason.SessionExpired) login.ExplainExpiredSession();
        var dialog = new LoginWindow { DataContext = login };
        MainWindow = dialog;
        bool signedIn;
        try
        {
            signedIn = dialog.ShowDialog() == true;
        }
        finally
        {
            login.Deactivate();
            login.ClearSecrets();
            dialog.DataContext = null;
        }
        if (!signedIn) _services!.GetRequiredService<ISessionStore>().SignOut();
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

                http.BaseAddress = options.GetHttpsOrigin();
                http.Timeout = TimeSpan.FromSeconds(Math.Max(5, options.TimeoutSeconds));
                http.DefaultRequestHeaders.Accept.Add(
                    new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
            })
            .RedactLoggedHeaders(_ => true)
            .ConfigurePrimaryHttpMessageHandler(CreateTransportHandler)
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
        services.AddSingleton<CabinetFinderViewModel>();
        services.AddSingleton<MachineTabViewModel>();
        services.AddSingleton<CabinetTabViewModel>();
        services.AddSingleton<AuditTabViewModel>();
        services.AddSingleton<FleetTabViewModel>();
        services.AddSingleton<ApprovalsViewModel>();
        services.AddSingleton<RegistrationsViewModel>();
        services.AddSingleton<StaffViewModel>();
        services.AddSingleton<ConnectivityAlertsViewModel>();
        services.AddSingleton<ShellViewModel>();
    }

    // Narrow composition seam: native tests supply a non-network handler before
    // any client/ViewModel/window is resolved. Shipping transport is unchanged.
    protected virtual System.Net.Http.HttpMessageHandler CreateTransportHandler() =>
        ApiClientOptions.CreateTransportHandler();

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
        const string prefix = "pack://application:,,,/CabinetPlatform.Console;component/Resources/";

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
