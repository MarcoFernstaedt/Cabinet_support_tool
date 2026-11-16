using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Server;

/// <summary>One local session, durable history, and outbound control polling. No diagnostic capability is added here.</summary>
public sealed class LocalSessions(string recordPath, Func<bool> policy, Func<bool> certificateValid, TimeProvider clock,
    Func<bool>? shellEnabled = null, Func<ISessionTerminal>? terminalFactory = null)
{
    private readonly object _gate = new();
    private Guid? _active;
    private ISessionTerminal? _terminal;
    private System.Threading.Channels.Channel<byte[]> _output = System.Threading.Channels.Channel.CreateBounded<byte[]>(16);
    private Task? _reader;
    private CancellationTokenSource? _readStop;
    public bool IsShell { get { lock (_gate) return _terminal is not null; } }

    private DateTimeOffset _opened;
    public Guid? Active { get { lock (_gate) return _active; } }

    private void Record(Guid id, string state, string reason)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(recordPath))!);
        byte[] line = JsonSerializer.SerializeToUtf8Bytes(new { sessionId = id, state, reason, at = clock.GetUtcNow() });
        using var stream = new FileStream(recordPath, FileMode.Append, FileAccess.Write, FileShare.Read);
        stream.Write(line);
        stream.WriteByte((byte)'\n');
        stream.Flush(flushToDisk: true);
    }

    public Task<SessionOpenOutput> OpenAsync(SessionOpenParams input, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        lock (_gate)
        {
            string? refusal = !policy() ? "Local policy forbids sessions" :
                !certificateValid() ? "The cabinet certificate is not valid" :
                _active is not null ? "A session is already live on this cabinet" :
                input.Kind is not ("diagnostic" or "shell") ? "Unknown session kind" :
                input.Kind == "shell" && (shellEnabled?.Invoke() != true || terminalFactory is null) ? "Development shell is not configured" : null;
            if (refusal is not null)
            {
                Record(input.SessionId, "refused", refusal);
                throw new OperationFailedException("unavailable", refusal);
            }
            Record(input.SessionId, "opened", input.Kind + " session accepted");
            if (input.Kind == "shell")
            {
                try
                {
                    _output = System.Threading.Channels.Channel.CreateBounded<byte[]>(16);
                    var output = _output;
                    _terminal = terminalFactory!();
                    ISessionTerminal terminal = _terminal;
                    _readStop = new CancellationTokenSource();
                    CancellationToken readToken = _readStop.Token;
                    _reader = Task.Run(async () => {
                        byte[] buffer = new byte[4096];
                        try {
                            int n;
                            while ((n = await terminal.Output.ReadAsync(buffer, readToken).ConfigureAwait(false)) > 0)
                                await output.Writer.WriteAsync(buffer[..n], readToken).ConfigureAwait(false);
                        } catch (IOException) { } catch (ObjectDisposedException) { } catch (OperationCanceledException) {
                            // Closing ConPTY must have a reader even after session delivery is cancelled.
                            try { await terminal.Output.CopyToAsync(Stream.Null).ConfigureAwait(false); }
                            catch (IOException) { } catch (ObjectDisposedException) { }
                        }
                    });
                }
                catch { Record(input.SessionId, "refused", "Shell process failed to start"); throw; }
            }
            _active = input.SessionId;
            _opened = clock.GetUtcNow();
            return Task.FromResult(new SessionOpenOutput(input.SessionId));
        }
    }

    public void Close(string reason)
    {
        lock (_gate)
        {
            if (_active is not { } id) return;
            // Stop access even when recording a close fails. The earlier open record remains on disk.
            _active = null;
            _readStop?.Cancel();
            _terminal?.Dispose();
            _readStop?.Dispose(); _readStop = null;
            _terminal = null;
            Record(id, "closed", reason);
        }
    }

    public async Task PollAsync(AgentApiClient api, CancellationToken token)
    {
        Guid id;
        lock (_gate)
        {
            if (_active is not { } active) return;
            if (!policy() || !certificateValid() || (_terminal is not null && shellEnabled?.Invoke() != true) || clock.GetUtcNow() - _opened >= TimeSpan.FromMinutes(30))
            { Close("Local session authorization expired"); return; }
            id = active;
        }
        try
        {
            if (IsShell)
            {
                ISessionTerminal terminal;
                lock (_gate) terminal = _terminal!;
                if (_reader?.IsFaulted == true) throw new IOException("Shell output reader failed", _reader.Exception);
                object outgoing = new SessionDiagnosticFrame("");
                bool exiting = false;
                if (_output.Reader.TryRead(out byte[]? bytes)) { outgoing = new { kind = "shell.out", data = Convert.ToBase64String(bytes) }; lock (_gate) Record(id, "shell.out", Convert.ToBase64String(bytes)); }
                else
                {
                    int code = -1; // Unknown process state must still produce a terminal exit frame.
                    try
                    {
                        exiting = terminal.HasExited && _reader?.IsCompleted == true;
                    }
                    catch { exiting = true; }
                    if (exiting)
                    {
                        try { code = terminal.ExitCode; }
                        catch { /* Report unknown even if an implementation violates the terminal contract. */ }
                        outgoing = new { kind = "shell.exit", code };
                    }
                }
                JsonElement received = await api.ExchangeShellFrameAsync(id, outgoing, token).ConfigureAwait(false);
                if (exiting) { Close("Shell process exited"); return; }
                await HandleShellFrameAsync(received, token).ConfigureAwait(false);
                return;
            }
            SessionControl control = await api.ExchangeSessionFrameAsync(id, [], token).ConfigureAwait(false);
            if (control.Control == "close") Close("Server ended session");
            // open and keepalive carry no payload and cannot dispatch an operation.
        }
        catch { Close("Session exchange failed"); throw; }
    }
    public async Task HandleShellFrameAsync(JsonElement frame, CancellationToken token)
    {
        ISessionTerminal terminal;
        Guid id;
        lock (_gate)
        {
            if (_active is not { } active || _terminal is null || !policy() || !certificateValid() || shellEnabled?.Invoke() != true)
            { Close("Shell authorization expired"); throw new OperationFailedException("unavailable", "Shell is not authorized"); }
            terminal = _terminal; id = active;
        }
        if (frame.TryGetProperty("control", out var control))
        {
            if (control.GetString() == "close") Close("Server ended shell");
            else if (control.GetString() != "keepalive") throw new OperationFailedException("unavailable", "Unsupported shell control");
            return;
        }
        string? kind = frame.GetProperty("kind").GetString();
        // The transport schema validates before this dispatch. An unknown kind never reaches stdin.
        if (kind == "shell.in")
        {
            byte[] bytes = Convert.FromBase64String(frame.GetProperty("data").GetString()!);
            if (bytes.Length > 16384) throw new OperationFailedException("unavailable", "Shell input exceeds frame limit");
            lock (_gate) Record(id, "shell.in", Convert.ToBase64String(bytes));
            await terminal.Input.WriteAsync(bytes, token).ConfigureAwait(false);
            await terminal.Input.FlushAsync(token).ConfigureAwait(false);
        }
        else if (kind == "shell.resize") terminal.Resize(frame.GetProperty("columns").GetInt16(), frame.GetProperty("rows").GetInt16());
        else if (kind == "shell.exit") { lock (_gate) Record(id, "shell.exit", "Operator requested process termination"); terminal.Terminate(); }
        else { lock (_gate) Record(id, "refused", "Unsupported shell frame: " + kind); throw new OperationFailedException("unavailable", "Unsupported shell frame"); }
    }

}
