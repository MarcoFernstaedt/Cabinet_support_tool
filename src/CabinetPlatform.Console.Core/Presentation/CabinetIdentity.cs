using CabinetPlatform.Contracts.Cabinets;

namespace CabinetPlatform.Console.Core.Presentation;

/// <summary>
/// How a cabinet is named everywhere in this console.
/// </summary>
/// <remarks>
/// <para>
/// One place, used by every list, every dialog and every confirmation, because
/// the thing this product must not do is let a rep act on the wrong cabinet.
/// There are three and a half thousand client organisations and seven thousand
/// cabinets; <c>CUBEX01</c> is a hostname hundreds of clients have chosen
/// independently, and a screen that shows one on its own has not identified
/// anything.
/// </para>
/// <para>
/// The rule this type exists to enforce: a hostname never appears without its
/// client and site. Not in a grid column, not in a dialog heading, not in an
/// announcement. If a screen has room for only one string, that string is
/// <see cref="CabinetPath.Display"/>.
/// </para>
/// </remarks>
public static class CabinetIdentity
{
    /// <summary>
    /// The marker put beside a cabinet whose name is shared by another in the
    /// same result set.
    /// </summary>
    /// <remarks>
    /// Textual as well as visual. A colour or an icon alone fails for a rep
    /// using a screen reader and for one glancing at a grid, and those are the
    /// two people most likely to pick the wrong row.
    /// </remarks>
    public const string AmbiguityMarker = "⚠ duplicate name";

    /// <summary>
    /// The one-line identification. Client, site, department where there is
    /// one, then the cabinet's name and its topology role.
    /// </summary>
    /// <param name="path">The cabinet's path.</param>
    public static string Line(CabinetPath? path) =>
        path is null ? "No cabinet selected" : path.Display;

    /// <summary>
    /// The same, with the duplicate-name warning appended when one applies.
    /// </summary>
    /// <param name="path">The cabinet's path.</param>
    public static string LineWithWarning(CabinetPath? path) =>
        path is null
            ? "No cabinet selected"
            : path.HostnameIsAmbiguous
                ? $"{path.Display}  {AmbiguityMarker}"
                : path.Display;

    /// <summary>
    /// The identification as a sentence, for a screen reader and for a
    /// confirmation a person has to read rather than glance at.
    /// </summary>
    /// <param name="path">The cabinet's path.</param>
    public static string Spoken(CabinetPath? path) =>
        path is null ? "No cabinet is selected." : path.Spoken;

    /// <summary>
    /// The sentence a confirmation dialog puts in front of somebody before they
    /// can submit.
    /// </summary>
    /// <remarks>
    /// Phrased as a question the operator answers rather than a label they
    /// skim. The dialog will not submit until they have said yes to it, which
    /// is the last point at which a wrong cabinet can be caught.
    /// </remarks>
    /// <param name="path">The cabinet's path.</param>
    /// <param name="actionDisplayName">What is about to be done.</param>
    public static string ConfirmationQuestion(CabinetPath? path, string actionDisplayName) =>
        path is null
            ? $"No cabinet is selected, so {actionDisplayName} cannot be requested."
            : $"Confirm that {actionDisplayName} should run on this cabinet: {path.Display}." +
              (path.HostnameIsAmbiguous
                  ? " Another cabinet in the list you chose from has the same name."
                  : string.Empty);

    /// <summary>
    /// A short label for a header that also shows the parts separately.
    /// </summary>
    /// <param name="path">The cabinet's path.</param>
    public static string ClientAndSite(CabinetPath? path) =>
        path is null
            ? string.Empty
            : string.IsNullOrWhiteSpace(path.DepartmentName)
                ? $"{path.ClientName} › {path.SiteName}"
                : $"{path.ClientName} › {path.SiteName} › {path.DepartmentName}";

    /// <summary>
    /// How a cabinet's part in its site reads to a person.
    /// </summary>
    /// <param name="role">The role.</param>
    public static string RoleLabel(CabinetRole role) => role switch
    {
        CabinetRole.Sync => "Sync cabinet",
        CabinetRole.Satellite => "Satellite",
        CabinetRole.Standalone => "Standalone",
        _ => "Role not set",
    };
}
