using System.ComponentModel.DataAnnotations;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace CabinetPlatform.Server.Controllers;

[ApiController]
[Route("api/office/enroll")]
public sealed class OfficeEnrollmentController(OfficeEnrollmentStore store, SupportDbContext db) : ControllerBase
{
    [HttpPost]
    [AllowAnonymous]
    [EnableRateLimiting(RateLimitPolicies.OfficeEnrollment)]
    [RequestSizeLimit(2048)]
    public async Task<IActionResult> Enroll([FromBody] OfficeEnrollmentRequest request, CancellationToken ct)
    {
        if (!store.Enabled) return NotFound();
        // A fresh token cannot inherit a legacy cabinet's approval or history.
        // An exact retry of an already-bound grant remains valid inside Redeem.
        var existing = await db.Cabinets.AnyAsync(c => c.MachineId == request.MachineId, ct) ||
                       await db.PendingRegistrations.AnyAsync(r => r.MachineId == request.MachineId, ct);
        return store.Redeem(request.Token, request.MachineId, request.DeviceKey, allowNewIdentity: !existing)
            ? NoContent() : Unauthorized();
    }
}

public sealed class OfficeEnrollmentRequest
{
    [Required, StringLength(64, MinimumLength = 64)]
    public string Token { get; set; } = "";
    [Required, StringLength(128, MinimumLength = 1)]
    public string MachineId { get; set; } = "";
    [Required, StringLength(64, MinimumLength = 64)]
    public string DeviceKey { get; set; } = "";
}
