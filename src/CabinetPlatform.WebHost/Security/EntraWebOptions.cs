using System.Security.Claims;
using System.Text.RegularExpressions;

namespace CabinetPlatform.WebHost.Security;

public sealed class EntraWebOptions
{
    public const string Section = "WebConsole:Entra";
    public string TenantId { get; set; } = "";
    public string ClientId { get; set; } = "";
    public string ClientSecret { get; set; } = "";
    public string RequiredAuthContext { get; set; } = "";

    public void Validate()
    {
        if (!Guid.TryParse(TenantId, out var tenant) || tenant == Guid.Empty ||
            !Guid.TryParse(ClientId, out var client) || client == Guid.Empty ||
            string.IsNullOrWhiteSpace(ClientSecret) ||
            !Regex.IsMatch(RequiredAuthContext, @"^c[1-9][0-9]?$", RegexOptions.CultureInvariant))
            throw new InvalidOperationException("Web Console Entra tenant, application and authentication context must be configured before startup.");
    }
}

public static class EntraAssurance
{
    public static bool IsSatisfied(ClaimsPrincipal? principal, EntraWebOptions options) =>
        principal?.Identity?.IsAuthenticated == true &&
        Guid.TryParse(principal.FindFirstValue("tid"), out var tenant) &&
        Guid.TryParse(principal.FindFirstValue("oid"), out var objectId) &&
        objectId != Guid.Empty &&
        tenant.ToString("D").Equals(options.TenantId, StringComparison.OrdinalIgnoreCase) &&
        principal.FindAll("acrs").Any(c => c.Value == options.RequiredAuthContext);
}
