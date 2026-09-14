using CabinetPlatform.Agent.Platform.Wmi;

namespace CabinetPlatform.Agent.Collectors;

/// <summary>
/// Counts the humans actually signed in to a cabinet.
/// </summary>
/// <remarks>
/// <para>
/// This is not a cosmetic statistic. It is the check that stands between a
/// remotely requested reboot and a technician mid-dispense, so it errs towards
/// reporting somebody present.
/// </para>
/// <para>
/// Only interactive logon types are counted. A cabinet runs a dozen service
/// logons at all times; counting those would report a permanently occupied
/// machine and make the reboot guard useless, while counting none of them and
/// also missing an RDP session would make it dangerous.
/// </para>
/// </remarks>
public sealed class LogonSessionReader
{
    /// <summary>
    /// The logon types that mean a person is at, or attached to, the console.
    /// </summary>
    /// <remarks>
    /// 2 is a local interactive logon, 10 an RDP session, 11 a logon served
    /// from cached credentials. Types not listed here (3 network, 4 batch,
    /// 5 service, 8 network clear-text, 9 new-credentials) never imply a person.
    /// </remarks>
    private static readonly int[] InteractiveLogonTypes = { 2, 10, 11 };

    private readonly IWmiRepository _wmi;

    public LogonSessionReader(IWmiRepository wmi) => _wmi = wmi;

    /// <summary>The distinct accounts holding an interactive session.</summary>
    public IReadOnlyList<string> GetInteractiveUsers()
    {
        var interactiveLogonIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var typeFilter = string.Join(" OR ", InteractiveLogonTypes.Select(t => $"LogonType = {t}"));
        var sessions = _wmi.Query(
            WmiScopes.CimV2,
            $"SELECT LogonId, LogonType FROM Win32_LogonSession WHERE {typeFilter}");

        foreach (var session in sessions)
        {
            var logonId = session.GetString("LogonId");
            if (string.IsNullOrWhiteSpace(logonId))
                throw new InvalidOperationException("An interactive logon session has no readable identity.");
            interactiveLogonIds.Add(logonId);
        }

        if (interactiveLogonIds.Count == 0)
        {
            return Array.Empty<string>();
        }

        // Win32_LoggedOnUser is the association between an account and a logon
        // session. Joining through it is what turns "some interactive session
        // exists" into "this person is signed in".
        var users = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var associations = _wmi.Query(
            WmiScopes.CimV2,
            "SELECT Antecedent, Dependent FROM Win32_LoggedOnUser");

        foreach (var association in associations)
        {
            var logonId = WmiReference.GetKeyValue(association.GetString("Dependent"), "LogonId");
            if (logonId is null || !interactiveLogonIds.Contains(logonId))
            {
                continue;
            }

            var antecedent = association.GetString("Antecedent");
            var name = WmiReference.GetKeyValue(antecedent, "Name");
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            var domain = WmiReference.GetKeyValue(antecedent, "Domain");
            users.Add(string.IsNullOrWhiteSpace(domain) ? name : $@"{domain}\{name}");
        }

        // Sessions were found but the association query named nobody. Rather
        // than report an empty cabinet, fall back to the session count: the
        // reboot guard must not be defeated by an unreadable association.
        if (users.Count == 0)
        {
            return interactiveLogonIds
                .Select(id => $"(unresolved session {id})")
                .ToArray();
        }

        return users.OrderBy(user => user, StringComparer.OrdinalIgnoreCase).ToArray();
    }
}
