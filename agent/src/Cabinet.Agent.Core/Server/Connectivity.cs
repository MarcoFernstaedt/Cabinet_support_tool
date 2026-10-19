using System.Net;
using Cabinet.Agent.Contracts;

namespace Cabinet.Agent.Core.Server;

/// <summary>
/// Decorrelated-jitter backoff (docs/spec/03-protocol.md "Protocol 1.1"): each wait is
/// min(cap, random(base, previous * 3)), capped at 5 minutes, so a fleet that lost the
/// server at the same instant spreads out instead of retrying in step.
/// </summary>
public sealed class Backoff(TimeSpan? first = null, TimeSpan? cap = null, Random? random = null)
{
    private readonly TimeSpan _base = first ?? TimeSpan.FromSeconds(2);
    private readonly TimeSpan _cap = cap ?? TimeSpan.FromMinutes(5);
    private readonly Random _random = random ?? Random.Shared;
    private readonly object _gate = new();
    private double _previousMs;
    public int Attempt { get; private set; }

    public TimeSpan Cap => _cap;

    public TimeSpan Next()
    {
        lock (_gate)
        {
            double low = _base.TotalMilliseconds;
            double high = Math.Max(low, (_previousMs <= 0 ? low : _previousMs) * 3);
            double next = Math.Min(_cap.TotalMilliseconds, low + _random.NextDouble() * (high - low));
            _previousMs = next;
            Attempt++;
            return TimeSpan.FromMilliseconds(next);
        }
    }

    public void Reset() { lock (_gate) { _previousMs = 0; Attempt = 0; } }
}

/// <summary>How a failed request reflects on the connection to the server.</summary>
public enum FailureKind
{
    /// <summary>No answer: the network, the TLS connection or a timeout. The server is treated as unreachable.</summary>
    Network,
    /// <summary>
    /// 502, 503 or 504: the server (or its front) answered but is shedding load or restarting. It was reached, so the shared state is left
    /// alone; only the endpoint that got the answer waits (at least its Retry-After), and the other loops, the long poll above all, go on.
    /// </summary>
    Unavailable,
    /// <summary>429: this cabinet's quota on one endpoint. Only the loop that hit it waits.</summary>
    Quota,
    /// <summary>401: the certificate was refused.</summary>
    CertificateRefused,
    /// <summary>Any other answer: the server was reached and refused or garbled this one request.</summary>
    Answered,
}

/// <summary>
/// The one connectivity state every loop shares (protocol 1.1). While the server is unreachable
/// a single request at a time probes it, at the pace of one backoff; the other loops wait for
/// "connected" instead of each backing off on its own. Only real network failures (no answer at all)
/// take the whole connection down; an answer, even 503 or 429, means the server was reached, and the
/// loop that got it waits for itself (<see cref="AgentConnection"/> honours its Retry-After). A poll
/// the server turns away answers 200 with reconnectAfterMs, which does hold every loop. A connection
/// that was up and is reset waits a random 0–30 s before the first retry, and a network change resets the backoff.
/// </summary>
public sealed class Connectivity
{
    /// <summary>The longest any server-sent wait is honoured (Retry-After from a hostile or broken server cannot park the agent).</summary>
    public static readonly TimeSpan MaxServerWait = TimeSpan.FromMinutes(10);

    private readonly object _gate = new();
    private readonly Backoff _backoff;
    private readonly TimeProvider _clock;
    private readonly Random _random;
    private readonly TimeSpan _resetJitter;
    private readonly TimeSpan _networkChangeJitter;
    private bool _connected;
    private bool _everConnected;
    private bool _probing;
    private DateTimeOffset _failedAt;
    private DateTimeOffset _backoffUntil;
    private DateTimeOffset _serverWaitUntil;
    private TaskCompletionSource _changed = New();
    private TaskCompletionSource _connectedSignal = New();

    public Connectivity(Backoff? backoff = null, TimeProvider? clock = null, Random? random = null, TimeSpan? resetJitter = null, TimeSpan? networkChangeJitter = null)
    {
        _backoff = backoff ?? new Backoff();
        _clock = clock ?? TimeProvider.System;
        _random = random ?? Random.Shared;
        _resetJitter = resetJitter ?? TimeSpan.FromSeconds(30);
        _networkChangeJitter = networkChangeJitter ?? TimeSpan.FromSeconds(10);
    }

    public bool IsConnected { get { lock (_gate) return _connected; } }

    /// <summary>Raised (outside the lock) on every move from not connected to connected, with whether it was a reconnection after a loss.</summary>
    public event Action<bool>? Connected;
    /// <summary>Raised (outside the lock) when a connection that was up is lost.</summary>
    public event Action<string>? Lost;

    public static FailureKind Classify(AgentApiException e) => e.Status switch
    {
        null => FailureKind.Network,
        HttpStatusCode.Unauthorized => FailureKind.CertificateRefused,
        HttpStatusCode.TooManyRequests => FailureKind.Quota,
        HttpStatusCode.BadGateway or HttpStatusCode.ServiceUnavailable or HttpStatusCode.GatewayTimeout => FailureKind.Unavailable,
        _ => FailureKind.Answered,
    };

    /// <summary>
    /// Waits until this loop may send. While connected that is at once (unless the server asked for a pause);
    /// while not, one caller at a time becomes the probe and waits out the backoff, and the rest wait for "connected".
    /// </summary>
    /// <param name="maxBackoff">Caps the backoff part of the wait for this caller (the heartbeat never waits longer than its interval); server-sent waits still apply in full.</param>
    /// <param name="probe">False for loops that should never probe (they only send once connected).</param>
    public async Task<Lease> EnterAsync(CancellationToken token, TimeSpan? maxBackoff = null, bool probe = true)
    {
        while (true)
        {
            token.ThrowIfCancellationRequested();
            Task wake;
            TimeSpan wait;
            lock (_gate)
            {
                DateTimeOffset now = _clock.GetUtcNow();
                DateTimeOffset until = _serverWaitUntil;
                if (_connected)
                {
                    if (until <= now) return new Lease(this, false);
                    wait = until - now;
                    wake = _changed.Task;
                }
                else if (probe && !_probing)
                {
                    DateTimeOffset backoffUntil = _backoffUntil;
                    if (maxBackoff is { } cap && backoffUntil > _failedAt + cap) backoffUntil = _failedAt + cap;
                    if (backoffUntil > until) until = backoffUntil;
                    if (until <= now) { _probing = true; return new Lease(this, true); }
                    wait = until - now;
                    wake = _changed.Task;
                }
                else
                {
                    wait = Timeout.InfiniteTimeSpan;
                    wake = _changed.Task;
                }
            }
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(token);
            Task delay = wait == Timeout.InfiniteTimeSpan ? Task.Delay(Timeout.Infinite, cts.Token) : Task.Delay(wait, _clock, cts.Token);
            await Task.WhenAny(delay, wake).ConfigureAwait(false);
            cts.Cancel();
            token.ThrowIfCancellationRequested();
        }
    }

    /// <summary>Waits until connected (never probes).</summary>
    public Task WaitConnectedAsync(CancellationToken token)
    {
        Task signal;
        lock (_gate) { if (_connected) return Task.CompletedTask; signal = _connectedSignal.Task; }
        return signal.WaitAsync(token);
    }

    /// <summary>The server answered (any answer counts as reaching it).</summary>
    public void Reached()
    {
        bool reconnected = false, changed = false;
        lock (_gate)
        {
            if (!_connected)
            {
                reconnected = _everConnected;
                _connected = _everConnected = true;
                _backoff.Reset();
                _backoffUntil = default;
                Interlocked.Exchange(ref _connectedSignal, New()).TrySetResult();
                changed = true;
            }
        }
        if (changed) { Signal(); Connected?.Invoke(reconnected); }
    }

    /// <summary>Records a failure. Returns how the failure was classified; only Network takes the shared state down (an answer, even 503 or 429, proves the server was reached).</summary>
    public FailureKind Failed(AgentApiException e)
    {
        FailureKind kind = Classify(e);
        switch (kind)
        {
            case FailureKind.Answered:
                Reached();
                break;
            case FailureKind.Quota:
            case FailureKind.Unavailable:
                Reached();
                break;
            case FailureKind.Network:
                Down(e.Message, networkReset: true, e.RetryAfter);
                break;
        }
        return kind;
    }

    /// <summary>The server asked every request to wait (reconnectAfterMs on a poll answer: it is shutting down or shedding load).</summary>
    public void ServerAskedToWait(TimeSpan wait) => Down("The platform server asked the agent to reconnect later.", networkReset: false, serverWait: wait);

    private void Down(string reason, bool networkReset, TimeSpan? serverWait)
    {
        bool lost;
        lock (_gate)
        {
            DateTimeOffset now = _clock.GetUtcNow();
            lost = _connected;
            _connected = false;
            _failedAt = now;
            TimeSpan backoff = _backoff.Next();
            // A connection that was up and has just been reset: every cabinet behind the same failure sees it at once,
            // so the first retry is spread over 0–30 s instead of coming at the first backoff step.
            if (lost && networkReset) backoff = TimeSpan.FromMilliseconds(_random.NextDouble() * _resetJitter.TotalMilliseconds);
            _backoffUntil = now + backoff;
            if (serverWait is { } w)
            {
                if (w < TimeSpan.Zero) w = TimeSpan.Zero;
                if (w > MaxServerWait) w = MaxServerWait;
                DateTimeOffset until = now + w;
                if (until > _serverWaitUntil) _serverWaitUntil = until;
            }
        }
        Signal();
        if (lost) Lost?.Invoke(reason);
    }

    /// <summary>A network address changed (cable back, Wi-Fi rejoined): retry soon, with jitter, instead of sitting out a long backoff.</summary>
    public void NetworkChanged()
    {
        lock (_gate)
        {
            if (_connected) return;
            _backoff.Reset();
            DateTimeOffset soon = _clock.GetUtcNow() + TimeSpan.FromMilliseconds(_random.NextDouble() * _networkChangeJitter.TotalMilliseconds);
            if (soon < _backoffUntil) _backoffUntil = soon;
        }
        Signal();
    }

    private void Release()
    {
        lock (_gate) _probing = false;
        Signal();
    }

    private void Signal() => Interlocked.Exchange(ref _changed, New()).TrySetResult();

    private static TaskCompletionSource New() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Permission for one request. Disposing it releases the probe slot.</summary>
    public sealed class Lease(Connectivity owner, bool probe) : IDisposable
    {
        private int _done;
        public bool IsProbe { get; } = probe;
        public void Dispose() { if (IsProbe && Interlocked.Exchange(ref _done, 1) == 0) owner.Release(); }
    }
}

/// <summary>
/// Server-directed pacing (protocol 1.1): heartbeat interval, long-poll hold and the pause between
/// event batches while a backlog drains. Every value the server sends is clamped to the contract's
/// range; a server that sends none is treated as 1.0 and the agent's own defaults stay.
/// </summary>
public sealed class Pacing
{
    public const int DefaultPollSeconds = 25;
    private readonly object _gate = new();
    private readonly TimeSpan _heartbeat10;
    private readonly TimeSpan _heartbeat11;
    private readonly TimeSpan _minHeartbeat;
    private readonly TimeSpan _maxHeartbeat;
    private int? _heartbeatSeconds;
    private int _pollSeconds = DefaultPollSeconds;
    private int _eventsPaceMs;

    /// <param name="heartbeat10">The interval while the server speaks 1.0 (no pacing fields seen): 60 s.</param>
    /// <param name="heartbeat11">The interval once the server speaks 1.1 and names none: 300 s.</param>
    public Pacing(TimeSpan heartbeat10, TimeSpan heartbeat11, TimeSpan minHeartbeat, TimeSpan maxHeartbeat)
    {
        _heartbeat10 = heartbeat10;
        _heartbeat11 = heartbeat11;
        _minHeartbeat = minHeartbeat;
        _maxHeartbeat = maxHeartbeat < minHeartbeat ? minHeartbeat : maxHeartbeat;
    }

    /// <summary>Whether the server has shown it speaks protocol 1.1 (it sent a pacing field).</summary>
    public bool Server11 { get; private set; }

    public TimeSpan Heartbeat
    {
        get
        {
            lock (_gate)
            {
                if (!Server11) return _heartbeat10;
                TimeSpan t = _heartbeatSeconds is { } s ? TimeSpan.FromSeconds(s) : _heartbeat11;
                return t < _minHeartbeat ? _minHeartbeat : t > _maxHeartbeat ? _maxHeartbeat : t;
            }
        }
    }

    public int PollSeconds { get { lock (_gate) return _pollSeconds; } }
    public TimeSpan EventsPace { get { lock (_gate) return TimeSpan.FromMilliseconds(_eventsPaceMs); } }

    public void Apply(ServerIntervals? intervals)
    {
        if (intervals is null) return;
        lock (_gate)
        {
            Server11 = true;
            _heartbeatSeconds = intervals.HeartbeatSeconds is { } h ? Math.Clamp(h, 60, 900) : null;
            if (intervals.PollSeconds is { } p) _pollSeconds = Math.Clamp(p, 15, 110);
            _eventsPaceMs = intervals.EventsPaceMs is { } e ? Math.Clamp(e, 0, 60_000) : 0;
        }
    }

    public void ApplyPoll(int? pollSeconds)
    {
        if (pollSeconds is not { } p) return;
        lock (_gate) { Server11 = true; _pollSeconds = Math.Clamp(p, 15, 110); }
    }
}
