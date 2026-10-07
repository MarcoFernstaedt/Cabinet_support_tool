using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cabinet.Agent.Contracts;
using Cabinet.Agent.Core.Helpers;

namespace Cabinet.Agent.Core.Monitoring;

/// <summary>
/// The firewall change detector: compares the whole firewall configuration with the
/// last one seen and reports what changed. A change the platform made itself is
/// recognised by the fingerprint the broker recorded just after making it, and the
/// event carries that command's ID; any other change is reported as unexplained.
/// </summary>
public sealed class FirewallWatch(StateFile<FirewallWatch.State> store, Func<string, Guid?>? platformChange = null)
{
    /// <summary>The firewall log's rule and setting change events, which make the watcher look at once instead of waiting.</summary>
    public static readonly IReadOnlyList<int> ChangeEventIds = new[] { 2002, 2003, 2004, 2005, 2006, 2033, 2052, 2097, 2099 };
    public const string FirewallLog = "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall";

    public sealed class State
    {
        public string? Hash { get; set; }
        public Dictionary<string, string> Items { get; set; } = new();
    }

    /// <summary>Each profile and rule as a name and a fingerprint of its settings.</summary>
    public static Dictionary<string, string> Items(FirewallStateOutput s)
    {
        var items = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var p in s.Profiles)
            items[$"profile:{p.Profile}"] = Fingerprint(p with { ReenableAt = null });
        foreach (var r in s.Rules)
        {
            string key = $"rule:{r.Name}";
            for (int n = 2; items.ContainsKey(key); n++) key = $"rule:{r.Name}#{n}"; // Windows allows rules with the same name
            items[key] = Fingerprint(r);
        }
        return items;
    }

    /// <summary>The fingerprint of a whole configuration: profiles (without timers) and rules, in name order.</summary>
    public static string Hash(FirewallStateOutput state) =>
        Fingerprint(Items(state).OrderBy(i => i.Key, StringComparer.Ordinal).Select(i => i.Key + "=" + i.Value).ToList());

    public AgentEvent? Check(FirewallStateOutput current, DateTimeOffset now)
    {
        State state = store.Load();
        var items = Items(current);
        string hash = Hash(current);
        if (state.Hash == hash) return null;
        bool first = state.Hash is null;
        var before = state.Items;
        store.Save(new State { Hash = hash, Items = items });
        if (first) return null; // the first look is the baseline

        var added = items.Keys.Except(before.Keys).OrderBy(k => k).ToList();
        var removed = before.Keys.Except(items.Keys).OrderBy(k => k).ToList();
        var changed = items.Keys.Intersect(before.Keys).Where(k => items[k] != before[k]).OrderBy(k => k).ToList();
        if (current.RulesTruncated && added.Count + removed.Count + changed.Count == 0) return null;
        var fields = new Dictionary<string, string>
        {
            ["added"] = added.Count.ToString(), ["removed"] = removed.Count.ToString(), ["changed"] = changed.Count.ToString(),
        };
        Guid? commandId = platformChange?.Invoke(hash);
        if (added.Count > 0) fields["addedNames"] = Names(added);
        if (removed.Count > 0) fields["removedNames"] = Names(removed);
        if (changed.Count > 0) fields["changedNames"] = Names(changed);
        return new AgentEvent
        {
            EventId = Guid.NewGuid(),
            Kind = EventKind.FirewallChanged,
            OccurredAt = now,
            CommandId = commandId,
            SeverityHint = commandId is null && (changed.Any(k => k.StartsWith("profile:", StringComparison.Ordinal)) || removed.Count > 0) ? SeverityHint.Major : SeverityHint.Minor,
            Detail = new EventDetail
            {
                Message = commandId is null
                    ? $"The firewall configuration changed outside the platform: {added.Count} added, {removed.Count} removed, {changed.Count} changed."
                    : $"The firewall configuration changed through the platform: {added.Count} added, {removed.Count} removed, {changed.Count} changed.",
                Fields = fields,
            },
        };
    }

    private static string Names(IEnumerable<string> keys)
    {
        var text = new StringBuilder();
        foreach (string k in keys)
        {
            string name = EventText.ShortText(k, 120);
            if (text.Length + name.Length + 2 > 240) { text.Append(", …"); break; }
            if (text.Length > 0) text.Append(", ");
            text.Append(name);
        }
        return text.ToString();
    }

    private static string Fingerprint(object value) =>
        Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, value.GetType(), ContractJson.Options)));
}
