using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using CabinetPlatform.Server.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CabinetPlatform.Server.Controllers;

/// <summary>
/// User administration. Supervisor only.
///
/// No response from this controller ever carries a password, a hash or a salt,
/// and no audit record written from it does either.
/// </summary>
[Route("api/users")]
public sealed class UsersController : SupportControllerBase
{
    private readonly SupportDbContext _db;
    private readonly IPasswordHasher _hasher;
    private readonly IAuditService _audit;
    private readonly TimeProvider _timeProvider;
    private readonly IRefreshTokenService _refreshTokens;

    /// <summary>Creates the controller.</summary>
    /// <param name="db">The database.</param>
    /// <param name="hasher">Hashes and validates passwords.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="timeProvider">Clock.</param>
    /// <param name="refreshTokens">Revokes sessions.</param>
    public UsersController(
        SupportDbContext db,
        IPasswordHasher hasher,
        IAuditService audit,
        TimeProvider timeProvider,
        IRefreshTokenService refreshTokens)
    {
        _db = db;
        _hasher = hasher;
        _audit = audit;
        _timeProvider = timeProvider;
        _refreshTokens = refreshTokens;
    }

    /// <summary>
    /// Ends every session a user holds, immediately.
    /// </summary>
    /// <remarks>
    /// This is the lockout path for an offboarded rep. The refresh chain dies
    /// at once, so effective access ends when their outstanding access token
    /// expires — within one access-token lifetime, not whenever a long-lived
    /// token happens to run out.
    /// </remarks>
    /// <param name="id">The user whose sessions end.</param>
    /// <param name="request">Why, and against which ticket.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("{id:guid}/revoke-sessions")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> RevokeSessions(
        Guid id, [FromBody] RevokeUserSessionsRequest request, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;

        User? user = await _db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);

        if (user is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.RevokeUserSessions, "User not found.", null,
                new { TargetUserId = id }, cancellationToken: ct);
            return Problem("User not found.", statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        int revoked = await _refreshTokens.RevokeAllAsync(user.Id, request.Reason.Trim(), ct);

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.RevokeUserSessions,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Reason = request.Reason.Trim(),
            TicketReference = string.IsNullOrWhiteSpace(request.TicketReference)
                ? null
                : request.TicketReference.Trim(),
            Details = new { TargetUserId = user.Id, user.Username, TokensRevoked = revoked },
        });

        await _db.SaveChangesAsync(ct);

        return NoContent();
    }

    [HttpGet]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(PagedResult<UserDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<PagedResult<UserDto>>> List(
        [FromQuery] PagedQuery query, CancellationToken ct)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        IQueryable<User> users = _db.Users.AsNoTracking();

        int total = await users.CountAsync(ct);

        List<UserDto> items = await users
            .OrderBy(u => u.Username)
            .Skip(query.Skip)
            .Take(query.PageSize)
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
                IsLockedOut = u.LockedUntilUtc != null && u.LockedUntilUtc > nowUtc
            })
            .ToListAsync(ct);

        await WriteObservedAsync(AuditEvent.ListUsers, new { ResultCount = items.Count }, ct);

        return Ok(PagedResult<UserDto>.Create(items, query.Page, query.PageSize, total));
    }

    [HttpPost]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(UserDto), StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<UserDto>> Create(
        [FromBody] CreateUserRequest request, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        string username = request.Username.Trim();

        if (!Enum.IsDefined(request.Role))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.CreateUser, "Role is not a defined value.", null, null, cancellationToken: ct);
            return Problem("Role is not valid.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        string? complaint = _hasher.ValidateComplexity(request.InitialPassword);

        if (complaint is not null)
        {
            // The complaint describes the policy. It never echoes the password.
            await _audit.WriteDenialAsync(
                AuditEvent.CreateUser, "Initial password did not meet policy.", null,
                new { Username = username }, cancellationToken: ct);
            return Problem(complaint,
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        if (await _db.Users.AnyAsync(u => u.Username == username, ct))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.CreateUser, "Username already exists.", null,
                new { Username = username }, cancellationToken: ct);
            return Problem("That username is already taken.",
                statusCode: StatusCodes.Status409Conflict, title: "Conflict");
        }

        PasswordHashResult hashed = _hasher.Hash(request.InitialPassword);

        var user = new User
        {
            Username = username,
            DisplayName = request.DisplayName.Trim(),
            Role = request.Role,
            PasswordHash = hashed.Hash,
            PasswordSalt = hashed.Salt,
            PasswordIterations = hashed.Iterations,
            IsActive = true,
            // A password someone else chose is a password the account owner has
            // not chosen. It buys one login and then must be replaced.
            MustChangePassword = true,
            HasElevatedSql = false,

            // Neither standalone grant is ever given at creation. Both are
            // separate, audited decisions a Supervisor makes afterwards, which
            // is the point of their being separate from role at all.
            HasHardwareActuation = false,
            CreatedUtc = nowUtc,
            CreatedByUserId = actor.UserId
        };

        _db.Users.Add(user);

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.CreateUser,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Details = new
            {
                CreatedUserId = user.Id,
                user.Username,
                Role = user.Role.ToString()
            }
        });

        await _db.SaveChangesAsync(ct);

        return CreatedAtAction(nameof(List), new { }, ToDto(user, nowUtc));
    }

    [HttpPatch("{id:guid}")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(UserDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<UserDto>> Update(
        Guid id, [FromBody] UpdateUserRequest request, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        await using var supportTransaction = await _db.Database.BeginTransactionAsync(ct);
        // Serialize all account edits against a successful login on the user row.
        // The support-only predicate below additionally rejects a stale staff selection.
        if (!request.SupportAccountsOnly)
            await _db.Users.Where(u => u.Id == id)
                .ExecuteUpdateAsync(set => set.SetProperty(u => u.IsActive, u => u.IsActive), ct);
        if (request.SupportAccountsOnly)
        {
            // Reserve the current support row until its update and audit commit.
            // A preflight GET would leave a promotion race before SaveChanges.
            int reserved = await _db.Users.Where(u => u.Id == id && u.IsActive &&
                (u.Role == CabinetPlatform.Contracts.Auth.Role.Tier1 || u.Role == CabinetPlatform.Contracts.Auth.Role.Tier2))
                .ExecuteUpdateAsync(set => set.SetProperty(u => u.IsActive, u => u.IsActive), ct);
            if (reserved != 1)
            {
                await _audit.WriteDenialAsync(AuditEvent.UpdateUser,
                    "The account is no longer an active support account.", null,
                    new { UserId = id }, cancellationToken: ct);
                await supportTransaction!.CommitAsync(ct);
                return Problem("The account is no longer an active support account. Refresh staff before deciding again.",
                    statusCode: StatusCodes.Status409Conflict, title: "Staff target changed");
            }
        }

        User? user = await _db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);

        if (user is null)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.UpdateUser, "User not found.", null, new { UserId = id }, cancellationToken: ct);
            await supportTransaction.CommitAsync(ct);
            return Problem("User not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (request.Role is { } role && !Enum.IsDefined(role))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.UpdateUser, "Role is not a defined value.", null,
                new { UserId = id }, cancellationToken: ct);
            await supportTransaction.CommitAsync(ct);
            return Problem("Role is not valid.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        // A Supervisor removing their own last privilege would lock the fleet
        // out of its own administration, so both self-demotion paths are shut.
        if (user.Id == actor.UserId && request.Role is { } newRole && newRole != user.Role)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.UpdateUser, "Supervisor attempted to change their own role.", null,
                new { UserId = id }, cancellationToken: ct);
            await supportTransaction.CommitAsync(ct);
            return Problem("You cannot change your own role.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        if (user.Id == actor.UserId && request.IsActive is false)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.UpdateUser, "Supervisor attempted to deactivate themselves.", null,
                new { UserId = id }, cancellationToken: ct);
            await supportTransaction.CommitAsync(ct);
            return Problem("You cannot deactivate your own account.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        var changes = new List<string>();

        if (request.Role is { } changedRole && changedRole != user.Role)
        {
            changes.Add($"Sessions revoked: {await _refreshTokens.RevokeAllAsync(user.Id, "Role changed.", ct)}");
        }

        if (request.Role is { } assignedRole && assignedRole != user.Role)
        {
            changes.Add($"Role {user.Role} -> {assignedRole}");
            user.Role = assignedRole;
        }

        if (request.IsActive is { } isActive && isActive != user.IsActive)
        {
            changes.Add($"IsActive {user.IsActive} -> {isActive}");
            user.IsActive = isActive;

            if (!isActive)
            {
                // Disabling an account ends its sessions now. The refresh path
                // would refuse them anyway on its next exchange, but "within
                // one access-token lifetime" is the promise, and waiting for a
                // client to come asking is not that.
                changes.Add($"Sessions revoked: {await _refreshTokens.RevokeAllAsync(user.Id, "Account deactivated.", ct)}");
            }
        }

        if (!string.IsNullOrWhiteSpace(request.DisplayName) &&
            request.DisplayName.Trim() != user.DisplayName)
        {
            changes.Add("DisplayName changed");
            user.DisplayName = request.DisplayName.Trim();
        }

        if (request.ClearLockout is true)
        {
            changes.Add("Lockout cleared");
            user.LockedUntilUtc = null;
            user.FailedLoginCount = 0;
        }

        if (changes.Count > 0)
        {
            _audit.Enqueue(new AuditRecord
            {
                Event = AuditEvent.UpdateUser,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Success,
                ActorType = ActorType.User,
                ActorId = actor.UserId.ToString(),
                ActorDisplayName = actor.Username,
                Details = new { TargetUserId = user.Id, user.Username, Changes = changes }
            });

            await _db.SaveChangesAsync(ct);
        }

        await supportTransaction.CommitAsync(ct);
        return Ok(ToDto(user, nowUtc));
    }

    /// <summary>
    /// Grants or revokes the elevated-SQL flag.
    ///
    /// The flag gates read access to the elevated diagnostic surface. It does
    /// not, and cannot, enable running a query someone typed: no endpoint in
    /// this server accepts SQL text at any role, this one included.
    /// </summary>
    [HttpPost("{id:guid}/elevated-sql")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(UserDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<UserDto>> SetElevatedSql(
        Guid id, [FromBody] ElevatedSqlRequest request, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        User? user = await _db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);

        if (user is null)
        {
            await _audit.WriteDenialAsync(
                request.Grant ? AuditEvent.GrantElevatedSql : AuditEvent.RevokeElevatedSql,
                "User not found.", null, new { UserId = id }, cancellationToken: ct);
            return Problem("User not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (request.Grant && !user.IsActive)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.GrantElevatedSql, "Cannot grant to an inactive account.", null,
                new { UserId = id }, cancellationToken: ct);
            return Problem("Cannot grant elevated access to an inactive account.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        user.HasElevatedSql = request.Grant;

        if (!request.Grant)
        {
            // Withdrawing the elevated grant is exactly the case the short
            // access-token lifetime exists for: it takes effect now, not when
            // the holder's token happens to expire.
            await _refreshTokens.RevokeAllAsync(user.Id, "Elevated database grant withdrawn.", ct);
        }

        _audit.Enqueue(new AuditRecord
        {
            Event = request.Grant ? AuditEvent.GrantElevatedSql : AuditEvent.RevokeElevatedSql,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            // Required by the contract, and the part a compliance reviewer
            // will actually read when they ask why this grant exists.
            Reason = request.Reason.Trim(),
            TicketReference = string.IsNullOrWhiteSpace(request.TicketReference)
                ? null : request.TicketReference.Trim(),
            Details = new { TargetUserId = user.Id, user.Username, Granted = request.Grant }
        });

        await _db.SaveChangesAsync(ct);

        return Ok(ToDto(user, nowUtc));
    }

    /// <summary>
    /// Grants or withdraws the reserved hardware-actuation permission.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Nothing in this build consumes the grant. The three reserved actuation
    /// actions are refused whether or not a caller holds it, no endpoint
    /// carries the policy, and no executor exists on any agent.
    /// </para>
    /// <para>
    /// It is implemented anyway, in full and with its own audit events, because
    /// the alternative is a permission invented in a hurry beside the first
    /// feature that needs it. Actuating a lock on a cabinet holding controlled
    /// substances is the single most consequential thing this product could
    /// ever do; the permission that would govern it should already exist, be
    /// grantable, be withdrawable, and have a history, before anybody designs
    /// the feature.
    /// </para>
    /// </remarks>
    /// <param name="id">The user.</param>
    /// <param name="request">Grant or withdraw, and why.</param>
    /// <param name="ct">Cancels the request.</param>
    [HttpPost("{id:guid}/hardware-actuation")]
    [Authorize(Policy = AuthorizationPolicies.RequireSupervisor)]
    [ProducesResponseType(typeof(UserDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<UserDto>> SetHardwareActuation(
        Guid id, [FromBody] HardwareActuationRequest request, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;

        AuditEvent auditEvent = request.Grant
            ? AuditEvent.GrantHardwareActuation
            : AuditEvent.RevokeHardwareActuation;

        if (string.IsNullOrWhiteSpace(request.Reason))
        {
            await _audit.WriteDenialAsync(
                auditEvent, "No reason was given.", null, new { UserId = id }, cancellationToken: ct);

            return Problem("A reason is required for this decision.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        User? user = await _db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);

        if (user is null)
        {
            await _audit.WriteDenialAsync(
                auditEvent, "User not found.", null, new { UserId = id }, cancellationToken: ct);

            return Problem("User not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (request.Grant && !user.IsActive)
        {
            await _audit.WriteDenialAsync(
                auditEvent, "Cannot grant to an inactive account.", null,
                new { UserId = id }, cancellationToken: ct);

            return Problem("Cannot grant hardware actuation to an inactive account.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        user.HasHardwareActuation = request.Grant;

        if (!request.Grant)
        {
            // The grant rides in the access token, so withdrawing it has to
            // reach sessions already open rather than waiting for one to
            // expire — the same reasoning as the elevated database grant.
            await _refreshTokens.RevokeAllAsync(user.Id, "Hardware actuation grant withdrawn.", ct);
        }

        _audit.Enqueue(new AuditRecord
        {
            Event = auditEvent,
            EventKind = AuditEventKind.Caused,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Reason = request.Reason.Trim(),
            TicketReference = string.IsNullOrWhiteSpace(request.TicketReference)
                ? null : request.TicketReference.Trim(),
            Details = new
            {
                TargetUserId = user.Id,
                user.Username,
                Granted = request.Grant,
                ConsumedByNothingInThisBuild = true,
            },
        });

        await _db.SaveChangesAsync(ct);

        return Ok(ToDto(user, nowUtc));
    }

    private Task WriteObservedAsync(AuditEvent auditEvent, object? details, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;

        return _audit.WriteAsync(new AuditRecord
        {
            Event = auditEvent,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = actor.UserId.ToString(),
            ActorDisplayName = actor.Username,
            Details = details
        }, ct);
    }

    private static UserDto ToDto(User u, DateTime nowUtc) => new()
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
        IsLockedOut = u.IsLockedOut(nowUtc)
    };
}
