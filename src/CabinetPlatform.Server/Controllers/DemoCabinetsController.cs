using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>Isolated, exact-grant read surface for the authenticated demo.</summary>
[Route("api/demo/cabinets")]
public sealed class DemoCabinetsController(SupportDbContext db) : SupportControllerBase
{
    [HttpGet("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupportUser)]
    public async Task<IActionResult> Detail(Guid id, CancellationToken ct)
    {
        Guid userId = CurrentUser.UserId;
        // Keep grant, user and cabinet eligibility in the same live query. Neither
        // a role nor a site's sync designation supplies an implicit grant.
        var detail = await db.CabinetReadGrants.AsNoTracking()
            .Where(g => g.UserId == userId && g.CabinetId == id &&
                g.User!.IsActive && !g.User.MustChangePassword && g.Cabinet!.IsActive)
            .Select(g => new
            {
                CabinetId = g.CabinetId,
                g.Cabinet!.Hostname,
                g.Cabinet.FriendlyName,
                SiteName = g.Cabinet.Site!.Name,
                ClientName = g.Cabinet.Site.Client!.Name
            })
            .SingleOrDefaultAsync(ct);
        return detail is null ? NotFound() : Ok(detail);
    }
}
