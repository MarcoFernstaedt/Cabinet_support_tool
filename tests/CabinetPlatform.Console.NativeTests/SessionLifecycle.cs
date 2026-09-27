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

// Reflection only drives/observes the private loop and provider, never mutates a client.
// The subclass supplies non-network transport at construction for EVERY graph.
internal static class SessionLifecycle
{
    public static int Run(bool forceFailure = false)
    {
        var app = new LifecycleApp();
        app.InitializeComponent();
        int result = 1;
        int stage = 0;
        int checks = 0;
        bool failed = false;
        bool stopping = false;
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
        void Stop()
        {
            timer.Stop();
            if (stopping) return;
            stopping = true;
            try { app.Shutdown(result); }
            // Let Application's normal-priority cleanup run before stopping our pump.
            finally { app.Dispatcher.BeginInvokeShutdown(DispatcherPriority.Background); }
        }
        void Fail(Exception ex)
        {
            failed = true;
            result = 1;
            System.Console.WriteLine("FAIL " + ex);
            Stop();
        }
        app.DispatcherUnhandledException += (_, e) =>
        {
            e.Handled = true;
            Fail(e.Exception);
        };
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
                    var handler = app.CurrentHandler ?? throw new InvalidOperationException("No synthetic transport installed");
                    Check(app.Windows.OfType<LoginWindow>().Where(w => w.IsVisible).SequenceEqual(new[] { login })
                        && ReferenceEquals(login.DataContext, provider.GetRequiredService<LoginViewModel>())
                        && app.TransportCount == stage / 2 + 1
                        && !ReferenceEquals(handler, previousHandler),
                        "every visible login belongs to the intended fresh synthetic graph");
                    if (forceFailure) throw new InvalidOperationException("Synthetic forced failure for dispatcher shutdown verification");
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
                Fail(ex);
            }
        };
        app.Dispatcher.BeginInvoke(new Action(async () =>
        {
            try
            {
                timer.Start();
                Check(app.StartupCount == 1, "one automatic startup was suppressed before the single explicit loop");
                await (Task)typeof(App).GetMethod("StartAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(app, null)!;
                Check(app.StartupCount == 1 && app.TransportCount == 3,
                    "exactly one startup and three synthetic-only graphs completed");
                Check(stage == 5 && cancelledLogin?.Password == "" && cancelledWindow?.DataContext is null
                    && cancelledSession is { IsSignedIn: false },
                    "cancel login clears secrets, detaches the dialog and ends the app loop");
                if (!failed) result = 0;
            }
            catch (Exception ex)
            {
                failed = true;
                result = 1;
                System.Console.WriteLine("FAIL " + ex);
            }
            finally
            {
                Stop();
            }
        }));
        try { Dispatcher.Run(); }
        catch (Exception ex) { Fail(ex); }
        finally { timer.Stop(); }
        System.Console.WriteLine($"Lifecycle checks={checks}; stage={stage}; exit={result}; synthetic transport only");
        return result;
    }

    private sealed class LifecycleApp : App
    {
        public int StartupCount { get; private set; }
        public int TransportCount { get; private set; }
        public HeldHandler? CurrentHandler { get; private set; }

        protected override HttpMessageHandler CreateTransportHandler()
        {
            TransportCount++;
            return CurrentHandler = new HeldHandler();
        }

        // Application queues this even when Dispatcher.Run owns the pump.
        // Suppress production startup; the harness drives StartAsync exactly once.
        protected override void OnStartup(StartupEventArgs e) => StartupCount++;
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
