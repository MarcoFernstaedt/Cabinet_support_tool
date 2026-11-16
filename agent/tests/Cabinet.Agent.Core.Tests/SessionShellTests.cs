using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32.SafeHandles;
using Cabinet.Agent.Windows;
using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Server;

namespace Cabinet.Agent.Core.Tests;

public sealed class SessionShellTests : IDisposable
{
    private readonly string _folder = Path.Combine(AppContext.BaseDirectory, "shell-" + Guid.NewGuid());
    private string PathName => Path.Combine(_folder, "sessions.jsonl");
    private static JsonElement Frame(object frame) => JsonSerializer.SerializeToElement(frame);
    private sealed class Terminal : ISessionTerminal
    {
        public Stream Input { get; } = new MemoryStream();
        public Stream Output { get; } = new MemoryStream();
        public Func<bool> ReadHasExited = () => false;
        public Func<int> ReadExitCode = () => 0;
        public bool HasExited => ReadHasExited();
        public int ExitCode => ReadExitCode();
        public (short, short)? Size;
        public bool Disposed;
        public void Terminate() => Disposed = true;
        public void Resize(short columns, short rows) => Size = (columns, rows);
        public void Dispose() => Disposed = true;
    }

    [Fact]
    public async Task Absent_shell_key_refuses_even_when_session_policy_is_on_and_never_creates_process()
    {
        var config = Fixtures.Config() with { SessionsEnabled = true };
        int started = 0;
        var local = new LocalSessions(PathName, () => config.SessionsEnabled, () => true, TimeProvider.System,
            () => config.DevelopmentShellEnabled, () => { started++; return new Terminal(); });
        await Assert.ThrowsAsync<OperationFailedException>(() => local.OpenAsync(new(Guid.NewGuid(), "shell"), CancellationToken.None));
        Assert.Equal(0, started);
        Assert.Null(local.Active);
        Assert.Contains("not configured", File.ReadAllText(PathName));
    }

    [Fact]
    public async Task Named_input_is_recorded_before_process_write_unknown_kinds_never_reach_it_and_death_keeps_log()
    {
        var terminal = new Terminal();
        var local = new LocalSessions(PathName, () => true, () => true, TimeProvider.System, () => true, () => terminal);
        var id = Guid.NewGuid();
        await local.OpenAsync(new(id, "shell"), CancellationToken.None);
        string data = Convert.ToBase64String(Encoding.UTF8.GetBytes("whoami\r"));
        await local.HandleShellFrameAsync(Frame(new { kind = "shell.in", data }), CancellationToken.None);
        Assert.Contains(data, File.ReadAllText(PathName));
        Assert.Equal("whoami\r", Encoding.UTF8.GetString(((MemoryStream)terminal.Input).ToArray()));
        await Assert.ThrowsAsync<OperationFailedException>(() => local.HandleShellFrameAsync(Frame(new { kind = "pipe", data }), CancellationToken.None));
        Assert.Equal(7, terminal.Input.Length);
        await local.HandleShellFrameAsync(Frame(new { kind = "shell.resize", columns = 90, rows = 25 }), CancellationToken.None);
        Assert.Equal(((short)90, (short)25), terminal.Size);
        local.Close("Process died");
        Assert.True(terminal.Disposed);
        Assert.Null(local.Active);
        Assert.Contains(data, File.ReadAllText(PathName));
        Assert.Contains("Process died", File.ReadAllText(PathName));
    }

    [Theory]
    [InlineData("policy")]
    [InlineData("certificate")]
    [InlineData("shell")]
    public async Task Revocation_stops_input_and_kills_process(string revoked)
    {
        bool policy = true, certificate = true, shell = true;
        var terminal = new Terminal();
        var local = new LocalSessions(PathName, () => policy, () => certificate, TimeProvider.System, () => shell, () => terminal);
        await local.OpenAsync(new(Guid.NewGuid(), "shell"), CancellationToken.None);
        if (revoked == "policy") policy = false;
        if (revoked == "certificate") certificate = false;
        if (revoked == "shell") shell = false;
        await Assert.ThrowsAsync<OperationFailedException>(() => local.HandleShellFrameAsync(Frame(new { kind = "shell.in", data = "YQ==" }), CancellationToken.None));
        Assert.Equal(0, terminal.Input.Length);
        Assert.True(terminal.Disposed);
    }
    [Theory]
    [InlineData("process")]
    [InlineData("exit-code-unreadable")]
    [InlineData("state-unreadable")]
    public async Task Exit_frame_survives_nonzero_process_exit_and_unreadable_state(string scenario)
    {
        using var process = Process.Start(new ProcessStartInfo(
            OperatingSystem.IsWindows() ? "cmd.exe" : "/bin/sh") {
            ArgumentList = { OperatingSystem.IsWindows() ? "/c" : "-c", "exit 7" },
            UseShellExecute = false
        })!;
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(7, process.ExitCode);
        var terminal = new Terminal {
            ReadHasExited = () => scenario == "state-unreadable" ? throw new InvalidOperationException("state unavailable") : process.HasExited,
            ReadExitCode = () => scenario == "exit-code-unreadable" ? throw new InvalidOperationException("Process was not started by this object") : process.ExitCode
        };
        var local = new LocalSessions(PathName, () => true, () => true, TimeProvider.System, () => true, () => terminal);
        var id = Guid.NewGuid();
        using var key = ECDsa.Create();
        using var certificate = new CertificateRequest("CN=test", key, HashAlgorithmName.SHA256)
            .CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        var handler = new ExitHandler(id);
        using var api = new AgentApiClient(new Uri("https://platform.test"), certificate, certificate, _ => handler);
        await local.OpenAsync(new(id, "shell"), CancellationToken.None);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            while (local.Active is not null)
            {
                await local.PollAsync(api, timeout.Token);
                await Task.Delay(1, timeout.Token);
            }
            var exit = Assert.Single(handler.Frames, f => f.TryGetProperty("kind", out var kind) && kind.GetString() == "shell.exit");
            Assert.Equal(scenario == "exit-code-unreadable" ? -1 : 7, exit.GetProperty("code").GetInt32());
            Assert.True(terminal.Disposed);
            int count = handler.Frames.Count;
            await local.PollAsync(api, CancellationToken.None);
            Assert.Equal(count, handler.Frames.Count);
        }
        finally { local.Close("Test cleanup"); }
    }

    [Fact]
    public void Native_exit_code_reader_returns_unknown_for_unreadable_handle()
    {
        using var handle = new SafeProcessHandle(IntPtr.Zero, ownsHandle: false);
        Assert.Equal(-1, SessionProcessExitCode.Read(handle));
        handle.Dispose();
        Assert.Equal(-1, SessionProcessExitCode.Read(handle));
    }

    [Fact]
    public async Task Native_exit_code_reader_reads_nonzero_exit_from_retained_handle_on_Windows()
    {
        // Linux proves the polling and fallback paths; the native API requires Windows.
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("SKIP native nonzero exit: requires Windows"); return; }
        using var process = Process.Start(new ProcessStartInfo("cmd.exe") {
            ArgumentList = { "/c", "exit 7" }, UseShellExecute = false
        })!;
        var handle = process.SafeHandle; // Retain before exit, just as CreateProcessW does.
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(7, SessionProcessExitCode.Read(handle));
    }

    private sealed class ExitHandler(Guid id) : HttpMessageHandler
    {
        public List<JsonElement> Frames { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Assert.Equal($"/agent/v1/sessions/{id:D}/frames", request.RequestUri!.AbsolutePath);
            using var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Frames.Add(document.RootElement.Clone());
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"control\":\"keepalive\"}", Encoding.UTF8, "application/json") };
        }
    }

    public void Dispose() { if (Directory.Exists(_folder)) Directory.Delete(_folder, true); }
}
