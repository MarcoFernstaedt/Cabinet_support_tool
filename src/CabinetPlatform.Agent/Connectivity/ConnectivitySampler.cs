using System.Net;
using System.Net.NetworkInformation;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Agent.Connectivity;

public enum ProbeObservation { Reply, NoReply, Error }
public interface IConnectivityProbe
{
    Task<ProbeObservation> ProbeAsync(string address, CancellationToken ct);
}

/// <summary>One bounded managed ICMP operation. No subprocess, DNS, retries or event logging.</summary>
public sealed class ConnectivityProbe : IConnectivityProbe
{
    public async Task<ProbeObservation> ProbeAsync(string address, CancellationToken ct)
    {
        if (!ConnectivityLimits.IsAllowedAddress(address)) return ProbeObservation.Error;
        using var ping = new Ping();
        try
        {
            var reply = await ping.SendPingAsync(IPAddress.Parse(address), TimeSpan.FromSeconds(2),
                new byte[16], new PingOptions(32, true), ct);
            return reply.Status == IPStatus.Success ? ProbeObservation.Reply : ProbeObservation.NoReply;
        }
        catch (PingException) { return ProbeObservation.Error; }
        catch (System.Net.Sockets.SocketException) { return ProbeObservation.Error; }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return ProbeObservation.Error; }
    }
}

/// <summary>Fixed-size counters only. No threshold, incident decision or individual-ping history.</summary>
public sealed class ConnectivitySampler(Guid source, IConnectivityProbe probe, Func<ConnectivitySummary, bool> persist)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private ConnectivityPlan? _plan;
    private readonly Dictionary<Guid, Counter> _counters = new();
    private DateTimeOffset? _lastTick;

    public void ApplyPlan(ConnectivityPlan plan, DateTimeOffset now)
    {
        _gate.Wait();
        try
        {
            bool valid = plan is not null && plan.Version == 1 && plan.SourceCabinetId == source && plan.SiteId != Guid.Empty &&
                plan.IntervalSeconds == ConnectivityLimits.IntervalSeconds && plan.IssuedUtc <= now.AddSeconds(30) &&
                plan.IssuedUtc >= now.AddMinutes(-10) && plan.ExpiresUtc > now &&
                plan.ExpiresUtc - plan.IssuedUtc <= TimeSpan.FromMinutes(10) &&
                plan.Targets is not null && plan.Targets.Count <= ConnectivityLimits.MaximumTargets &&
                plan.Targets.All(t => t is not null && t.CabinetId != Guid.Empty && t.CabinetId != source && ConnectivityLimits.IsAllowedAddress(t.Address)) &&
                plan.Targets.Select(t => t.CabinetId).Distinct().Count() == plan.Targets.Count &&
                plan.Targets.Select(t => t.Address).Distinct().Count() == plan.Targets.Count &&
                plan.Targets.Count(t => t.IsSync) <= 1 && plan.Targets.Count(t => !t.IsSync) <= 3 &&
                (plan.ConfigurationId != Guid.Empty || plan.Targets.Count == 0);
            if (!valid) { Clear(); return; }
            if (_plan?.ConfigurationId != plan!.ConfigurationId || _plan?.SiteId != plan.SiteId ||
                !_plan.Targets.SequenceEqual(plan.Targets!)) _counters.Clear();
            _plan = plan;
        }
        finally { _gate.Release(); }
    }

    public void Revoke()
    {
        _gate.Wait();
        try { Clear(); }
        finally { _gate.Release(); }
    }

    private void Clear() { _plan = null; _counters.Clear(); }

    public async Task SampleAsync(DateTimeOffset now, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            if (_plan is null || _plan.ExpiresUtc <= now || _plan.IssuedUtc > now.AddSeconds(30)) { Clear(); return; }
            if (_lastTick is { } last)
            {
                if (now < last) { _counters.Clear(); _lastTick = now; return; }
                // PeriodicTimer is nominally 60 seconds; sub-second scheduler jitter
                // must not turn a minute schedule into one sample every two minutes.
                if (now - last < TimeSpan.FromSeconds(59)) return;
                if (now - last > TimeSpan.FromSeconds(75)) _counters.Clear();
            }
            _lastTick = now;
            foreach (var target in _plan.Targets)
            {
                ct.ThrowIfCancellationRequested();
                if (!_counters.TryGetValue(target.CabinetId, out var counter))
                    _counters[target.CabinetId] = counter = new Counter();
                var observation = await probe.ProbeAsync(target.Address, ct);
                counter.Add(now, observation);
                if (counter.Count == ConnectivityLimits.SamplesPerSummary)
                {
                    var summary = counter.Build(source, target.CabinetId, _plan.ConfigurationId);
                    // The sink must durably enqueue before returning true. Failure is explicit,
                    // and never causes a stream of per-failure network events.
                    _counters[target.CabinetId] = new Counter();
                    if (!persist(summary)) throw new IOException("Connectivity interval could not be retained and was lost.");
                }
            }
        }
        finally { _gate.Release(); }
    }

    private sealed class Counter
    {
        public int Count;
        private int _success, _failure, _error, _leading, _trailing, _maximum;
        private DateTimeOffset _first, _last;
        private DateTimeOffset? _lastSuccess, _lastFailure;
        public void Add(DateTimeOffset time, ProbeObservation value)
        {
            if (Count == 0) _first = time;
            _last = time;
            if (value == ProbeObservation.NoReply)
            {
                _failure++; _trailing++; _lastFailure = time;
                if (_leading == Count) _leading++;
                _maximum = Math.Max(_maximum, _trailing);
            }
            else
            {
                _trailing = 0;
                if (value == ProbeObservation.Reply) { _success++; _lastSuccess = time; }
                else _error++;
            }
            Count++;
        }
        public ConnectivitySummary Build(Guid sourceId, Guid targetId, Guid revision) => new()
        {
            Id = Guid.NewGuid(), SourceCabinetId = sourceId, TargetCabinetId = targetId, ConfigurationId = revision,
            FirstObservedUtc = _first, LastObservedUtc = _last, SuccessCount = _success, FailureCount = _failure,
            ErrorCount = _error, LeadingFailures = _leading, TrailingFailures = _trailing, MaximumFailureRun = _maximum,
            LastSuccessUtc = _lastSuccess, LastFailureUtc = _lastFailure
        };
    }
}
