using CabinetPlatform.Contracts.Enums;
using CabinetPlatform.Contracts.Users;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

[Route("api/auth")]
public sealed class AuthController : SupportControllerBase
{
    private readonly IUserAuthenticationService _auth;
    private readonly IAuditService _audit;
    private readonly SupportDbContext _db;

    public AuthController(
        IUserAuthenticationService auth,
        IAuditService audit,
        SupportDbContext db)
    {
        _auth = auth;
        _audit = audit;
        _db = db;
    }

    /// <summary>
    /// Rate-limited per IP, with per-account lockout behind it. The two are
    /// complementary: the limiter slows a single source, the lockout stops a
    /// distributed one from grinding away at one account.
    /// </summary>
    [HttpPost("login")]
    [AllowAnonymous]
    [EnableRateLimiting(RateLimitPolicies.Login)]
    [ProducesResponseType(typeof(LoginResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<LoginResponse>> Login(
        [FromBody] LoginRequest request, CancellationToken ct)
    {
        OperationResult<LoginResponse> result = await _auth.LoginAsync(request, ct);

        return result.Succeeded ? Ok(result.Value) : Problem(result);
    }

    /// <summary>
    /// Reachable while holding a must-change-password token, because it is one
    /// of the two things such a session is permitted to do.
    /// </summary>
    [HttpPost("change-password")]
    [Authorize(Policy = AuthorizationPolicies.RequireAuthenticatedUser)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult> ChangePassword(
        [FromBody] ChangePasswordRequest request, CancellationToken ct)
    {
        // The user id comes from the token. There is no endpoint that changes
        // someone else's password on their behalf.
        OperationResult result = await _auth.ChangePasswordAsync(CurrentUser.UserId, request, ct);

        return result.Succeeded ? NoContent() : Problem(result);
    }

    /// <summary>The caller's own identity, as the server resolves it.</summary>
    [HttpGet("me")]
    [Authorize(Policy = AuthorizationPolicies.RequireAuthenticatedUser)]
    [ProducesResponseType(typeof(UserDto), StatusCodes.Status200OK)]
    public async Task<ActionResult<UserDto>> Me(CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;

        UserDto? dto = await _db.Users
            .AsNoTracking()
            .Where(u => u.Id == actor.UserId)
            .Select(u => new UserDto
            {
                Id = u.Id,
                Username = u.Username,
                DisplayName = u.DisplayName,
                Role = u.Role,
                HasElevatedSql = u.HasElevatedSql,
                IsActive = u.IsActive,
                MustChangePassword = u.MustChangePassword,
                CreatedUtc = u.CreatedUtc,
                CreatedByUserId = u.CreatedByUserId,
                LastLoginUtc = u.LastLoginUtc,
                LockedUntilUtc = u.LockedUntilUtc
            })
            .FirstOrDefaultAsync(ct);

        if (dto is null)
        {
            await _audit.WriteDenialAsync(AuditActions.ViewSelf, "User no longer exists.", null, null, ct);
            return Problem("Not found.", statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        await _audit.WriteAsync(new AuditRecord
        {
            Action = AuditActions.ViewSelf,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username
        }, ct);

        return Ok(dto);
    }
}
