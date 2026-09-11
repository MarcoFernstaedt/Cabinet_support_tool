using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using CabinetPlatform.Console.Core.Presentation;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;

namespace CabinetPlatform.Console.Core.Sections;

/// <summary>
/// One action button inside a section.
/// </summary>
/// <remarks>
/// <para>
/// The button's label, its warnings and whether it is enabled all come from the
/// server's catalogue entry. The console holds no second copy of which actions
/// are disruptive or which roles may run them, so the two cannot drift.
/// </para>
/// <para>
/// Disabling the button for a role the catalogue says may not run the action is
/// a courtesy and nothing more. The server checks the caller's role against the
/// same catalogue on every request and refuses regardless of what this console
/// drew.
/// </para>
/// </remarks>
public sealed partial class SectionActionViewModel : ObservableObject
{
    private readonly Func<SectionActionViewModel, CancellationToken, Task> _execute;
    private readonly Func<Role?> _roleAccessor;

    public SectionActionViewModel(
        ActionCatalogEntryDto catalogue,
        Func<Role?> roleAccessor,
        Func<SectionActionViewModel, CancellationToken, Task> execute,
        Func<IReadOnlyDictionary<string, string>>? parameterFactory = null)
    {
        Catalogue = catalogue;
        _roleAccessor = roleAccessor;
        _execute = execute;
        ParameterFactory = parameterFactory;
    }

    public ActionCatalogEntryDto Catalogue { get; }

    /// <summary>
    /// Supplies the parameters this invocation needs from its context — the
    /// service name of the selected row, for example. Only keys the catalogue
    /// allows ever reach it, and there is no path by which a user types one.
    /// </summary>
    public Func<IReadOnlyDictionary<string, string>>? ParameterFactory { get; }

    public string DisplayName => Catalogue.DisplayName;
    public string Description => Catalogue.Description;

    public bool IsDisruptive => Catalogue.IsDisruptive;
    public bool RequiresApproval => Catalogue.RequiresApproval;

    /// <summary>
    /// Set by the owning section when the action needs something selected —
    /// a service row, for instance — and nothing is.
    /// </summary>
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(InvokeCommand))]
    private bool _isContextSatisfied = true;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(InvokeCommand))]
    private bool _isBusy;

    /// <summary>
    /// Whether the signed-in role meets the catalogue's minimum. The server is
    /// the authority; this only decides whether the button looks available.
    /// </summary>
    public bool RoleAllows => _roleAccessor() is { } role && role >= Catalogue.MinimumRole;

    /// <summary>
    /// Why the button is unavailable, or null. Never left unexplained: a greyed
    /// control with no reason is indistinguishable from a broken one.
    /// </summary>
    public string? UnavailableReason
    {
        get
        {
            if (!RoleAllows)
            {
                return $"{Catalogue.DisplayName} requires the {Catalogue.MinimumRole} role. " +
                       $"You are signed in as {_roleAccessor()?.ToString() ?? "an unknown role"}.";
            }

            return IsContextSatisfied ? null : "Select a row first.";
        }
    }

    /// <summary>
    /// The full consequence, spelled out on the button itself rather than only
    /// inside the dialog that follows it. Someone navigating by tab order hears
    /// this before they press it, which is the point.
    /// </summary>
    public string AccessibleName
    {
        get
        {
            List<string> parts = new() { Catalogue.DisplayName };

            if (Catalogue.IsDisruptive)
            {
                parts.Add("disruptive: this interrupts work on the cabinet");
            }

            if (Catalogue.RequiresApproval)
            {
                parts.Add("requires approval by a second person before it runs");
            }

            if (Catalogue.MaintenanceWindowOnly)
            {
                parts.Add("only runs inside the maintenance window");
            }

            if (Catalogue.BlockedIfUserLoggedOn)
            {
                parts.Add("blocked while a user is logged on to the cabinet");
            }

            if (UnavailableReason is { } reason)
            {
                parts.Add(reason);
            }

            return string.Join(". ", parts) + ".";
        }
    }

    private bool CanInvoke => !IsBusy && IsContextSatisfied && RoleAllows;

    [RelayCommand(CanExecute = nameof(CanInvoke))]
    private async Task InvokeAsync(CancellationToken ct)
    {
        IsBusy = true;

        try
        {
            await _execute(this, ct);
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>Re-evaluates role-dependent state after a sign-in or role change.</summary>
    public void RefreshAvailability()
    {
        OnPropertyChanged(nameof(RoleAllows));
        OnPropertyChanged(nameof(UnavailableReason));
        OnPropertyChanged(nameof(AccessibleName));
        InvokeCommand.NotifyCanExecuteChanged();
    }

    partial void OnIsContextSatisfiedChanged(bool value) => RefreshAvailability();
}
