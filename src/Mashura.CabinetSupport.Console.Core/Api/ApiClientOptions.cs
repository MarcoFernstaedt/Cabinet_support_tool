namespace Mashura.CabinetSupport.Console.Core.Api;

/// <summary>Where the server is and how long to wait for it.</summary>
public sealed class ApiClientOptions
{
    public const string SectionName = "Api";

    /// <summary>
    /// Base address of the support server, for example
    /// <c>https://support.mashura.internal/</c>. Deployment configuration; the
    /// console has no UI for editing it, because a support tool that can be
    /// pointed at an arbitrary host by its operator is a phishing target.
    /// </summary>
    public string BaseAddress { get; set; } = "https://localhost:7030/";

    /// <summary>
    /// Per-request timeout. Clinic links are slow and occasionally awful, so
    /// this is generous — but finite, because a spinner that never resolves is
    /// indistinguishable from a hung application to a screen reader user.
    /// </summary>
    public int TimeoutSeconds { get; set; } = 30;
}
