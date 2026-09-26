using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Windows;
using System.Windows.Threading;
using CabinetPlatform.Console;
using CabinetPlatform.Console.Core.Api;
using CabinetPlatform.Console.Core.ViewModels;
using CabinetPlatform.Console.Views;
using CabinetPlatform.Contracts.Auth;
using Microsoft.Extensions.DependencyInjection;

// Test-only reflection keeps transport replacement out of the shipping API.
// Drives the real App loop and real synthetic windows, never a running Console.
internal static class SessionLifecycle
{
    public static int Run()
    {
        var app = new App();
        app.InitializeComponent();
        int result = 1;
        int stage = 0;
        int checks = 0;
        MainWindow? previous = null;
        ShellViewModel? previousShell = null;
        IServiceProvider? previousProvider = null;
        HeldHandler? previousHandler = null;
        SessionStore? previousSession = null;
        LoginWindow? cancelledWindow = null;
        LoginViewModel? cancelledLogin = null;
        SessionStore? cancelledSession = null;
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(25) };
        void Check(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException(name);
            checks++;
            System.Console.WriteLine("PASS " + name);
        }
        timer.Tick += (_, _) =>
        {
            try
            {
                if (elapsed.Elapsed > TimeSpan.FromSeconds(20)) throw new TimeoutException("Synthetic lifecycle exceeded 20 seconds");
                if (app.MainWindow is LoginWindow login && login.IsVisible)
                {
                    var provider = (IServiceProvider)typeof(App).GetField("_services", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(app)!;
                    var session = (SessionStore)provider.GetRequiredService<ISessionStore>();
                    var api = (ApiClient)provider.GetRequiredService<IApiClient>();
                    // Replace the unused transport before any command or shell load.
                    // Disposing the original client closes the only real transport.
                    var field = typeof(ApiClient).GetField("_http", BindingFlags.Instance | BindingFlags.NonPublic)!;
                    ((HttpClient)field.GetValue(api)!).Dispose();
                    var handler = new HeldHandler();
                    field.SetValue(api, new HttpClient(handler) { BaseAddress = new Uri("https://synthetic.invalid/") });
                    if (stage == 0 || stage == 2)
                    {
                        if (stage == 2)
                        {
                            Check(previous is not null && !previous.IsVisible && previous.DataContext is null,
                                "old native shell is closed and detached before next login");
                            Check(!ReferenceEquals(provider, previousProvider) && !ReferenceEquals(session, previousSession),
                                "next login owns a fresh provider and session store");
                            Check(previousSession is not null && !previousSession.IsSignedIn && previousHandler!.Token.IsCancellationRequested,
                                "old session is signed out and pending HTTP canceled");
                            previousHandler!.Response.SetResult(new HttpResponseMessage(HttpStatusCode.Unauthorized));
                        }
                        session.SignIn("synthetic-token", DateTimeOffset.UtcNow.AddHours(1), "synthetic-refresh",
                            "Synthetic operator", stage == 0 ? Role.Supervisor : Role.Tier1, false);
                        previousProvider = provider;
                        previousSession = session;
                        previousHandler = handler;
                        stage++;
                        login.DialogResult = true; // Synthetic accepted login; portable tests cover real login HTTP.
                    }
                    else if (stage == 4)
                    {
                        Check(previous is not null && !previous.IsVisible && previous.DataContext is null,
                            "expiry closes and detaches the second native shell before login");
                        Check(!ReferenceEquals(provider, previousProvider) && !session.IsSignedIn,
                            "expiry creates another empty session");
                        Check(((LoginViewModel)login.DataContext).ErrorMessage is not null,
                            "expiry explanation is shown on the fresh login");
                        ((LoginViewModel)login.DataContext).Password = "synthetic-cancelled";
                        cancelledWindow = login;
                        cancelledLogin = (LoginViewModel)login.DataContext;
                        cancelledSession = session;
                        login.Close();
                        stage = 5;
                        timer.Stop();
                    }
                }
                else if (app.MainWindow is MainWindow shellWindow && shellWindow.IsVisible)
                {
                    var shell = (ShellViewModel)shellWindow.DataContext;
                    if (stage == 1)
                    {
                        previous = shellWindow;
                        previousShell = shell;
                        stage = 2;
                        shell.SignOutCommand.Execute(null);
                        Check(!shellWindow.IsVisible && shellWindow.DataContext is null,
                            "signout synchronously closes the native shell");
                    }
                    else if (stage == 3)
                    {
                        Check(!ReferenceEquals(previous, shellWindow) && !ReferenceEquals(previousShell, shell),
                            "second login creates a different native window and shell");
                        Check(shell.Machine.ActionHistory.Count == 0 && shell.Cabinets.Cabinets.Count == 0,
                            "old delayed response cannot populate the second shell");
                        previous = shellWindow;
                        previousShell = shell;
                        stage = 4;
                        previousHandler!.Response.SetResult(new HttpResponseMessage(HttpStatusCode.Unauthorized));
                    }
                }
            }
            catch (Exception ex)
            {
                System.Console.WriteLine("FAIL " + ex);
                timer.Stop();
                app.Shutdown(1);
            }
        };
        app.Dispatcher.BeginInvoke(new Action(async () =>
        {
            try
            {
                timer.Start();
                await (Task)typeof(App).GetMethod("StartAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, null)!;
                Check(stage == 5 && cancelledLogin?.Password == "" && cancelledWindow?.DataContext is null
                    && cancelledSession is { IsSignedIn: false },
                    "cancel login clears secrets, detaches the dialog and ends the app loop");
                result = 0;
            }
            catch (Exception ex)
            {
                System.Console.WriteLine("FAIL " + ex);
                result = 1;
                app.Shutdown(1);
            }
        }));
        Dispatcher.Run();
        System.Console.WriteLine($"Lifecycle checks={checks}; stage={stage}; exit={result}; synthetic transport only");
        return result;
    }

    private sealed class HeldHandler : HttpMessageHandler
    {
        public CancellationToken Token { get; private set; }
        private int _requests;
        public TaskCompletionSource<HttpResponseMessage> Response { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Token = cancellationToken;
            return ++_requests == 1 ? Response.Task
                : Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized));
        }
    }
}
