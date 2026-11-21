using System.Text.Json;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Server;

/// <summary>One local session, durable history, and outbound control polling. No diagnostic capability is added here.</summary>
public sealed class LocalSessions(string recordPath, Func<bool> policy, Func<bool> certificateValid, TimeProvider clock)
{
    private readonly object _gate = new();
    private Guid? _active;
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
                input.Kind != "diagnostic" ? "Unknown session kind" : null;
            if (refusal is not null)
            {
                Record(input.SessionId, "refused", refusal);
                throw new OperationFailedException("unavailable", refusal);
            }
            Record(input.SessionId, "opened", input.Kind + " session accepted");
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
            Record(id, "closed", reason);
        }
    }

    public async Task PollAsync(AgentApiClient api, CancellationToken token)
    {
        Guid id;
        lock (_gate)
        {
            if (_active is not { } active) return;
            if (!policy() || !certificateValid() || clock.GetUtcNow() - _opened >= TimeSpan.FromMinutes(30))
            { Close("Local session authorization expired"); return; }
            id = active;
        }
        try
        {
            SessionControl control = await api.ExchangeSessionFrameAsync(id, [], token).ConfigureAwait(false);
            if (control.Control == "close") Close("Server ended session");
            // open and keepalive carry no payload and cannot dispatch an operation.
        }
        catch { Close("Session exchange failed"); throw; }
    }
}
