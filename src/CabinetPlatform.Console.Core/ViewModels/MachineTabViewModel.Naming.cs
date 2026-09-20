using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace CabinetPlatform.Console.Core.ViewModels;

public sealed partial class MachineTabViewModel
{
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(RenameCommand))]
    private string _friendlyName = string.Empty;
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(RenameCommand))]
    private string _renameReason = string.Empty;
    [ObservableProperty] private string _renameOutcome = string.Empty;

    public bool CanRename => _session.IsSignedIn && !_session.MustChangePassword &&
        _session.Role == Role.Supervisor && Path is not null;
    private bool CanSaveName() => CanRename && !IsLoading &&
        !string.IsNullOrWhiteSpace(FriendlyName) && FriendlyName.Length <= 120 &&
        !string.IsNullOrWhiteSpace(RenameReason) && RenameReason.Length <= 2000;

    [RelayCommand(CanExecute = nameof(CanSaveName))]
    private async Task RenameAsync()
    {
        if (!CanSaveName()) return;
        var id = Path!.CabinetId;
        var generation = _generation;
        var request = new RenameCabinetRequest { FriendlyName = FriendlyName.Trim(), Reason = RenameReason.Trim() };
        var result = await RunAsync(ct => _api.RenameCabinetAsync(id, request, ct));
        if (generation != _generation) return;
        RenameReason = string.Empty;
        if (result is null)
        {
            RenameOutcome = "Rename not confirmed. Refresh this cabinet before trying again; the server may have saved it.";
            return;
        }
        await LoadAsync(id);
        if (Path?.CabinetId == id)
            RenameOutcome = "Cabinet name saved. Device identity and hostname are unchanged.";
    }
}
