using CabinetPlatform.Contracts.Common;
using CabinetPlatform.Contracts.Enums;
using CabinetPlatform.Contracts.Users;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
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

    public UsersController(
        SupportDbContext db,
        IPasswordHasher hasher,
        IAuditService audit,
        TimeProvider timeProvider)
    {
        _db = db;
        _hasher = hasher;
        _audit = audit;
        _timeProvider = timeProvider;
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
                IsActive = u.IsActive,
                MustChangePassword = u.MustChangePassword,
                CreatedUtc = u.CreatedUtc,
                CreatedByUserId = u.CreatedByUserId,
                LastLoginUtc = u.LastLoginUtc,
                LockedUntilUtc = u.LockedUntilUtc,
                IsLockedOut = u.LockedUntilUtc != null && u.LockedUntilUtc > nowUtc
            })
            .ToListAsync(ct);

        await WriteObservedAsync(AuditActions.ListUsers, new { ResultCount = items.Count }, ct);

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
                AuditActions.CreateUser, "Role is not a defined value.", null, null, ct);
            return Problem("Role is not valid.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        string? complaint = _hasher.ValidateComplexity(request.InitialPassword);

        if (complaint is not null)
        {
            // The complaint describes the policy. It never echoes the password.
            await _audit.WriteDenialAsync(
                AuditActions.CreateUser, "Initial password did not meet policy.", null,
                new { Username = username }, ct);
            return Problem(complaint,
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        if (await _db.Users.AnyAsync(u => u.Username == username, ct))
        {
            await _audit.WriteDenialAsync(
                AuditActions.CreateUser, "Username already exists.", null,
                new { Username = username }, ct);
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
            CreatedUtc = nowUtc,
            CreatedByUserId = actor.UserId
        };

        _db.Users.Add(user);

        _audit.Enqueue(new AuditRecord
        {
            Action = AuditActions.CreateUser,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
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

        User? user = await _db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);

        if (user is null)
        {
            await _audit.WriteDenialAsync(
                AuditActions.UpdateUser, "User not found.", null, new { UserId = id }, ct);
            return Problem("User not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (request.Role is { } role && !Enum.IsDefined(role))
        {
            await _audit.WriteDenialAsync(
                AuditActions.UpdateUser, "Role is not a defined value.", null,
                new { UserId = id }, ct);
            return Problem("Role is not valid.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        // A Supervisor removing their own last privilege would lock the fleet
        // out of its own administration, so both self-demotion paths are shut.
        if (user.Id == actor.UserId && request.Role is { } newRole && newRole != user.Role)
        {
            await _audit.WriteDenialAsync(
                AuditActions.UpdateUser, "Supervisor attempted to change their own role.", null,
                new { UserId = id }, ct);
            return Problem("You cannot change your own role.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        if (user.Id == actor.UserId && request.IsActive is false)
        {
            await _audit.WriteDenialAsync(
                AuditActions.UpdateUser, "Supervisor attempted to deactivate themselves.", null,
                new { UserId = id }, ct);
            return Problem("You cannot deactivate your own account.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        var changes = new List<string>();

        if (request.Role is { } assignedRole && assignedRole != user.Role)
        {
            changes.Add($"Role {user.Role} -> {assignedRole}");
            user.Role = assignedRole;
        }

        if (request.IsActive is { } isActive && isActive != user.IsActive)
        {
            changes.Add($"IsActive {user.IsActive} -> {isActive}");
            user.IsActive = isActive;
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
                Action = AuditActions.UpdateUser,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Success,
                ActorType = ActorTypes.User,
                ActorId = actor.UserId.ToString(),
                ActorDisplayName = actor.Username,
                Details = new { TargetUserId = user.Id, user.Username, Changes = changes }
            });

            await _db.SaveChangesAsync(ct);
        }

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
                request.Grant ? AuditActions.GrantElevatedSql : AuditActions.RevokeElevatedSql,
                "User not found.", null, new { UserId = id }, ct);
            return Problem("User not found.",
                statusCode: StatusCodes.Status404NotFound, title: "Not found");
        }

        if (request.Grant && !user.IsActive)
        {
            await _audit.WriteDenialAsync(
                AuditActions.GrantElevatedSql, "Cannot grant to an inactive account.", null,
                new { UserId = id }, ct);
            return Problem("Cannot grant elevated access to an inactive account.",
                statusCode: StatusCodes.Status400BadRequest, title: "Invalid request");
        }

        user.HasElevatedSql = request.Grant;

        _audit.Enqueue(new AuditRecord
        {
            Action = request.Grant ? AuditActions.GrantElevatedSql : AuditActions.RevokeElevatedSql,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
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

    private Task WriteObservedAsync(string action, object? details, CancellationToken ct)
    {
        CurrentUser actor = CurrentUser;

        return _audit.WriteAsync(new AuditRecord
        {
            Action = action,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorTypes.User,
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
        IsActive = u.IsActive,
        MustChangePassword = u.MustChangePassword,
        CreatedUtc = u.CreatedUtc,
        CreatedByUserId = u.CreatedByUserId,
        LastLoginUtc = u.LastLoginUtc,
        LockedUntilUtc = u.LockedUntilUtc,
        IsLockedOut = u.IsLockedOut(nowUtc)
    };
}
