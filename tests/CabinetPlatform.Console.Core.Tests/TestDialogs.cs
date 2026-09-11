using CabinetPlatform.Console.Core.Presentation;

namespace CabinetPlatform.Console.Core.Tests;

/// <summary>
/// Stands in for the WPF action dialog. Records what it was asked and answers
/// with a scripted result.
/// </summary>
/// <remarks>
/// The dialog is the one part of the action path that has to be faked, because
/// it is the part whose whole job is to wait for a human. Everything on either
/// side of it — the catalogue, the submission, the server's decision — is real.
/// </remarks>
public sealed class ScriptedActionDialog : IActionRequestDialog
{
    private readonly Func<ActionRequestPrompt, ActionRequestSubmission?> _answer;

    public ScriptedActionDialog(Func<ActionRequestPrompt, ActionRequestSubmission?> answer) =>
        _answer = answer;

    /// <summary>Approves everything with a stock reason and ticket.</summary>
    public static ScriptedActionDialog Accepting(string reason = "Investigating ticket SUP-1042") =>
        new(_ => new ActionRequestSubmission(reason, "SUP-1042", false, null));

    /// <summary>Cancels everything, as a user pressing Escape would.</summary>
    public static ScriptedActionDialog Cancelling() => new(_ => null);

    public List<ActionRequestPrompt> Prompts { get; } = new();

    public ActionRequestPrompt LastPrompt => Prompts[^1];

    public Task<ActionRequestSubmission?> ShowAsync(ActionRequestPrompt prompt, CancellationToken ct)
    {
        Prompts.Add(prompt);
        return Task.FromResult(_answer(prompt));
    }
}

/// <summary>Stands in for the WPF approve/deny dialog.</summary>
public sealed class ScriptedApprovalDialog : IApprovalDecisionDialog
{
    private readonly Func<ApprovalDecisionPrompt, ApprovalDecisionSubmission?> _answer;

    public ScriptedApprovalDialog(Func<ApprovalDecisionPrompt, ApprovalDecisionSubmission?> answer) =>
        _answer = answer;

    public static ScriptedApprovalDialog Accepting(string note = "Checked with the clinic.") =>
        new(_ => new ApprovalDecisionSubmission(note, "SUP-1042"));

    public static ScriptedApprovalDialog Cancelling() => new(_ => null);

    public List<ApprovalDecisionPrompt> Prompts { get; } = new();

    public Task<ApprovalDecisionSubmission?> ShowAsync(
        ApprovalDecisionPrompt prompt, CancellationToken ct)
    {
        Prompts.Add(prompt);
        return Task.FromResult(_answer(prompt));
    }
}
