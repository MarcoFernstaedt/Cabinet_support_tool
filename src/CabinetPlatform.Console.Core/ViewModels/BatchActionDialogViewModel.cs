using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CommunityToolkit.Mvvm.ComponentModel;

namespace CabinetPlatform.Console.Core.ViewModels;

/// <summary>
/// What the operator is asked before an action runs across many cabinets.
/// </summary>
/// <remarks>
/// <para>
/// The whole design of this dialog is to stop somebody agreeing to a blast
/// radius they did not read. It shows every cabinet by name, never a filter
/// expression; it states the count; and it will not submit until the operator
/// has typed that count back. Typing a number is a poor confirmation of most
/// things and an excellent one of this, because the number is the thing being
/// agreed to.
/// </para>
/// <para>
/// The list is frozen here and sent as identifiers. A filter re-evaluated on
/// the server would let a batch approved this afternoon act on cabinets that
/// joined the fleet this evening.
/// </para>
/// </remarks>
public sealed partial class BatchActionDialogViewModel : ObservableObject
{
    private readonly IReadOnlyList<CabinetSummary> _targets;

    /// <summary>Creates the dialog.</summary>
    /// <param name="prompt">The action, the resolved cabinets and the caller.</param>
    public BatchActionDialogViewModel(BatchActionPrompt prompt)
    {
        Prompt = prompt;

        _targets = prompt.Cabinets
            .OrderBy(c => c.ClientName, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(c => c.SiteName, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(c => c.Hostname, StringComparer.CurrentCultureIgnoreCase)
            .ToList();

        Targets = _targets.Select(c => new BatchTargetRow(c)).ToList();

        Parameters = prompt.Parameters
            .Select(p => new ParameterRow(p.Key, p.Value))
            .ToList();
    }

    /// <summary>The action, the resolved cabinets and the caller.</summary>
    public BatchActionPrompt Prompt { get; }

    /// <summary>Every cabinet this batch will act on, named.</summary>
    public IReadOnlyList<BatchTargetRow> Targets { get; }

    /// <summary>Named operands, applied identically to every target. Read-only.</summary>
    public IReadOnlyList<ParameterRow> Parameters { get; }

    /// <summary>How many cabinets the batch names.</summary>
    public int TargetCount => _targets.Count;

    /// <summary>How many distinct sites those cabinets sit at.</summary>
    public int SiteCount => _targets.Select(c => c.SiteId).Distinct().Count();

    /// <summary>How many distinct clients they belong to.</summary>
    public int ClientCount =>
        _targets.Select(c => c.ClientName).Distinct(StringComparer.CurrentCultureIgnoreCase).Count();

    public string Title => $"{Prompt.Catalogue.DisplayName} on {TargetCount} cabinets";

    /// <summary>
    /// The cabinets this batch will skip rather than act on, and why.
    /// </summary>
    /// <remarks>
    /// Shown before submission rather than reported afterwards. An operator who
    /// expects fifty reboots and gets forty-three needs to know which seven and
    /// why at the moment they decide, not in a results grid an hour later.
    /// </remarks>
    public IReadOnlyList<BatchTargetRow> Skipped =>
        Targets.Where(t => t.WillBeSkipped(Prompt.Catalogue)).ToList();

    /// <summary>How many cabinets are expected to be acted on.</summary>
    public int ExpectedCount => TargetCount - Skipped.Count;

    /// <summary>
    /// The count the operator must type back before this can be submitted.
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit), nameof(ValidationMessage))]
    private string _confirmedCount = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit), nameof(ValidationMessage))]
    private string _reason = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit), nameof(ValidationMessage))]
    private string _ticketReference = string.Empty;

    /// <summary>
    /// What this batch will do, and to how many machines, in words.
    /// </summary>
    public IReadOnlyList<string> Warnings
    {
        get
        {
            var warnings = new List<string>
            {
                $"This will act on {TargetCount} cabinet(s) across {SiteCount} site(s).",
            };

            if (ClientCount > 1)
            {
                warnings.Add(
                    $"Those cabinets belong to {ClientCount} different clients. A batch that spans " +
                    "clients affects several organisations at once.");
            }

            if (Prompt.Catalogue.IsDisruptive)
            {
                warnings.Add(
                    "This action is disruptive. It interrupts work on every cabinet it reaches, and " +
                    "a clinician may be mid-dispense at any of them.");
            }

            if (Prompt.Catalogue.MaintenanceWindowOnly)
            {
                warnings.Add(
                    "Each cabinet is judged against its own maintenance window, in its own time " +
                    "zone. Cabinets outside their window at dispatch are skipped, not queued.");
            }

            if (Prompt.Catalogue.BlockedIfUserLoggedOn)
            {
                warnings.Add(
                    "Any cabinet with somebody logged on is skipped, and so is any cabinet whose " +
                    "last check-in could not tell — not knowing is not the same as nobody being " +
                    "there.");
            }

            if (Skipped.Count > 0)
            {
                warnings.Add(
                    $"{Skipped.Count} of these cabinet(s) look likely to be skipped on the reading " +
                    $"the server has now, leaving about {ExpectedCount}. The server decides at " +
                    "dispatch and reports what it skipped.");
            }

            if (RequiresSupervisorApproval)
            {
                warnings.Add(
                    $"A batch of this size needs a Supervisor's approval, not a Tier 2 one. The " +
                    $"threshold is {Prompt.Catalogue.BatchSupervisorThreshold} cabinets.");
            }

            if (Prompt.Catalogue.MaximumBatchSize is { } cap && TargetCount > cap)
            {
                warnings.Add(
                    $"This is above the server's hard cap of {cap} cabinets for this action. The " +
                    "server will reject the whole batch rather than act on part of it.");
            }

            warnings.Add(
                "A batch that partially fails is not rolled back and is not retried. Each cabinet " +
                "keeps its own result.");

            return warnings;
        }
    }

    /// <summary>
    /// Whether a batch this large needs a Supervisor rather than a Tier 2
    /// approver. The server decides again; this is so the requester is not
    /// surprised.
    /// </summary>
    public bool RequiresSupervisorApproval =>
        Prompt.Catalogue.BatchSupervisorThreshold is { } threshold && TargetCount >= threshold;

    /// <summary>
    /// Why the confirm button is unavailable, or null. Never silent: a disabled
    /// confirm with no explanation is how an operator concludes it is broken.
    /// </summary>
    public string? ValidationMessage
    {
        get
        {
            if (TargetCount == 0)
            {
                return "This batch names no cabinets.";
            }

            if (Prompt.Catalogue.MaximumBatchSize is { } cap && TargetCount > cap)
            {
                return $"This batch names {TargetCount} cabinets, above the server's cap of {cap} " +
                       "for this action. Narrow the selection; the server rejects an over-sized " +
                       "batch outright rather than truncating it.";
            }

            if (string.IsNullOrWhiteSpace(ConfirmedCount))
            {
                return $"Type {TargetCount} to confirm you have read the list of cabinets above.";
            }

            if (!int.TryParse(ConfirmedCount.Trim(), out int typed) || typed != TargetCount)
            {
                return $"That is not the number of cabinets in this batch. It names {TargetCount}.";
            }

            if (Reason.Trim().Length < 3)
            {
                return "Enter a reason of at least three characters. It is recorded against every " +
                       "cabinet in the batch.";
            }

            if (string.IsNullOrWhiteSpace(TicketReference))
            {
                return "Enter a ticket reference. Every action on a cabinet is traceable to one.";
            }

            return null;
        }
    }

    public bool CanSubmit => ValidationMessage is null;

    /// <summary>
    /// One sentence a screen reader announces when the dialog opens.
    /// </summary>
    public string AccessibleSummary =>
        $"{Prompt.Catalogue.DisplayName} on {TargetCount} cabinets across {SiteCount} sites. " +
        string.Join(" ", Warnings);

    /// <summary>
    /// The request to send, or null while the dialog is incomplete.
    /// </summary>
    /// <remarks>
    /// The confirmed count travels with the identifiers so the server can check
    /// the two against each other. An operator cannot confirm one number and
    /// submit another, however the list was assembled on the way here.
    /// </remarks>
    public CreateBatchActionRequest? BuildSubmission() => CanSubmit
        ? new CreateBatchActionRequest
        {
            Action = Prompt.Catalogue.Action,
            CabinetIds = _targets.Select(c => c.Id).ToList(),
            ConfirmedCabinetCount = TargetCount,
            Parameters = Prompt.Parameters,
            Reason = Reason.Trim(),
            TicketReference = TicketReference.Trim(),
        }
        : null;
}

/// <summary>What the batch dialog is opened with.</summary>
/// <param name="Catalogue">The action, as the server describes it.</param>
/// <param name="Cabinets">The cabinets the operator's selection resolved to.</param>
/// <param name="Parameters">Named operands applied identically to every target.</param>
/// <param name="CallerRole">The requesting user's role.</param>
public sealed record BatchActionPrompt(
    ActionCatalogEntryDto Catalogue,
    IReadOnlyList<CabinetSummary> Cabinets,
    IReadOnlyDictionary<string, string> Parameters,
    Role CallerRole);

/// <summary>One cabinet in a batch, as the confirmation list shows it.</summary>
public sealed class BatchTargetRow
{
    /// <summary>Creates the row.</summary>
    /// <param name="cabinet">The cabinet.</param>
    public BatchTargetRow(CabinetSummary cabinet)
    {
        Cabinet = cabinet;
        Health = StatusPresentation.ForCabinet(cabinet.Health);
    }

    /// <summary>The cabinet as the list view describes it.</summary>
    public CabinetSummary Cabinet { get; }

    /// <summary>Identifier of the cabinet.</summary>
    public Guid Id => Cabinet.Id;

    /// <summary>Hostname, for display.</summary>
    public string Hostname => Cabinet.Hostname;

    /// <summary>Client and site, so a mis-selected clinic is visible at a glance.</summary>
    public string ClientAndSite => $"{Cabinet.ClientName} — {Cabinet.SiteName}";

    /// <summary>This cabinet's part in its site's topology.</summary>
    public string Role => Cabinet.Role.ToString();

    /// <summary>How the cabinet's health reads at a glance.</summary>
    public StatusPresentation Health { get; }

    /// <summary>Whether anyone was signed in at its last check-in, in words.</summary>
    public string LoggedOn => Cabinet.AnyUserLoggedOn switch
    {
        true => "Somebody is logged on",
        false => "Nobody is logged on",
        null => Format.NotReported,
    };

    /// <summary>
    /// Whether this cabinet is likely to be skipped when the batch is
    /// dispatched.
    /// </summary>
    /// <remarks>
    /// A prediction from the last check-in, not a promise: the server decides
    /// at dispatch, against a reading that may be newer than this one. Null
    /// counts as skipped for the same reason it does everywhere else — an
    /// unread logged-on flag is treated exactly as a user being there.
    /// </remarks>
    /// <param name="catalogue">The action, as the server describes it.</param>
    public bool WillBeSkipped(ActionCatalogEntryDto catalogue) =>
        !Cabinet.IsActive ||
        (catalogue.BlockedIfUserLoggedOn && Cabinet.AnyUserLoggedOn is not false);

    /// <summary>One sentence a screen reader announces for this row.</summary>
    public string AccessibleSummary =>
        $"{Hostname}. {ClientAndSite}. {Role}. Health {Health.Label}. {LoggedOn}.";
}
