using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
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
    private readonly IRefreshTokenService _refreshTokens;
    private readonly TimeProvider _timeProvider;

    /// <summary>Creates the controller.</summary>
    /// <param name="auth">Sign-in and password change.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="db">The database.</param>
    /// <param name="refreshTokens">Issues and rotates refresh tokens.</param>
    /// <param name="timeProvider">Clock.</param>
    public AuthController(
        IUserAuthenticationService auth,
        IAuditService audit,
        SupportDbContext db,
        IRefreshTokenService refreshTokens,
        TimeProvider timeProvider)
    {
        _auth = auth;
        _audit = audit;
        _db = db;
        _refreshTokens = refreshTokens;
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// Exchanges a refresh token for a fresh access token.
    /// </summary>
    /// <remarks>
    /// Anonymous because the access token it replaces has, by definition,
    /// probably expired. The refresh token itself is the credential, it is
    /// checked against the database on every use, and the user's current role,
    /// elevated grant and active flag are re-read rather than carried forward
    /// from the claims minted at sign-in.
    /// </remarks>
    /// <param name="request">The refresh token.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("refresh")]
    [AllowAnonymous]
    [EnableRateLimiting(RateLimitPolicies.Login)]
    [ProducesResponseType(typeof(RefreshResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<RefreshResponse>> Refresh(
        [FromBody] RefreshRequest request, CancellationToken ct)
    {
        OperationResult<RefreshResponse> result = await _refreshTokens.RefreshAsync(request.RefreshToken, ct);

        return result.Succeeded ? Ok(result.Value) : Problem(result);
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
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

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
                HasHardwareActuation = u.HasHardwareActuation,
                IsActive = u.IsActive,
                MustChangePassword = u.MustChangePassword,
                CreatedUtc = u.CreatedUtc,
                CreatedByUserId = u.CreatedByUserId,
                LastLoginUtc = u.LastLoginUtc,
                LockedUntilUtc = u.LockedUntilUtc,
                IsLockedOut = u.LockedUntilUtc != null && u.LockedUntilUtc > nowUtc,
            })
            .FirstOrDefaultAsync(ct);

        if (dto is null)
        {
            await _audit.WriteDenialAsync(AuditEvent.ViewSelf, "User no longer exists.", null, null, cancellationToken: ct);
            return Problem("Not found.", statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        await _audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.ViewSelf,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username
        }, ct);

        return Ok(dto);
    }
}
