using CabinetPlatform.Contracts.Actions;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Contracts.Cabinets;
using CabinetPlatform.Contracts.Telemetry;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Services;

public interface IUserAuthenticationService
{
    Task<OperationResult<LoginResponse>> LoginAsync(LoginRequest request, CancellationToken ct);

    Task<OperationResult> ChangePasswordAsync(
        Guid userId, ChangePasswordRequest request, CancellationToken ct);
}

/// <summary>
/// Login, lockout and password change.
///
/// Nothing in this class logs a password, a hash or a salt, and no failure
/// path tells a caller which half of a credential was wrong.
/// </summary>
public sealed class UserAuthenticationService : IUserAuthenticationService
{
    /// <summary>
    /// Verified against this when the username does not exist, so that a
    /// missing account costs the same time as a wrong password and the two
    /// cannot be told apart by a stopwatch.
    /// </summary>
    private static readonly byte[] DummyHash = new byte[32];
    private static readonly byte[] DummySalt = new byte[16];

    private readonly SupportDbContext _db;
    private readonly IPasswordHasher _hasher;
    private readonly IJwtTokenService _tokens;
    private readonly IRefreshTokenService _refreshTokens;
    private readonly IAuditService _audit;
    private readonly LoginSecurityOptions _options;
    private readonly PasswordOptions _passwordOptions;
    private readonly TimeProvider _timeProvider;

    public UserAuthenticationService(
        SupportDbContext db,
        IPasswordHasher hasher,
        IJwtTokenService tokens,
        IRefreshTokenService refreshTokens,
        IAuditService audit,
        IOptions<LoginSecurityOptions> options,
        IOptions<PasswordOptions> passwordOptions,
        TimeProvider timeProvider)
    {
        _db = db;
        _hasher = hasher;
        _tokens = tokens;
        _refreshTokens = refreshTokens;
        _audit = audit;
        _options = options.Value;
        _passwordOptions = passwordOptions.Value;
        _timeProvider = timeProvider;
    }

    public async Task<OperationResult<LoginResponse>> LoginAsync(
        LoginRequest request, CancellationToken ct)
    {
        DateTime nowUtc = _timeProvider.GetUtcNow().UtcDateTime;
        string username = request.Username.Trim();

        User? user = await _db.Users.FirstOrDefaultAsync(u => u.Username == username, ct);

        if (user is null)
        {
            // Burn the same work an existing account would have cost before
            // answering, then give the same answer.
            _hasher.Verify(request.Password, DummyHash, DummySalt, _passwordOptions.Iterations);

            await WriteLoginDenialAsync(username, "Unknown username.", ct);
            return InvalidCredentials();
        }

        if (user.IsLockedOut(nowUtc))
        {
            await WriteLoginDenialAsync(username, "Account is locked out.", ct, user);
            return OperationResult<LoginResponse>.Forbidden(
                "This account is temporarily locked. Try again later.");
        }

        if (!user.IsActive)
        {
            await WriteLoginDenialAsync(username, "Account is disabled.", ct, user);
            // Same wording as bad credentials: whether an account exists but is
            // disabled is not something an unauthenticated caller should learn.
            return InvalidCredentials();
        }

        bool verified = _hasher.Verify(
            request.Password, user.PasswordHash, user.PasswordSalt, user.PasswordIterations);

        if (!verified)
        {
            user.FailedLoginCount++;

            string reason = "Incorrect password.";

            if (user.FailedLoginCount >= _options.MaxFailedAttempts)
            {
                user.LockedUntilUtc = nowUtc.AddMinutes(_options.LockoutMinutes);
                user.FailedLoginCount = 0;
                reason = $"Incorrect password; account locked for {_options.LockoutMinutes} minutes.";
            }

            _audit.Enqueue(new AuditRecord
            {
                Event = AuditEvent.Login,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Denied,
                ActorType = ActorType.User,
                ActorId = user.Id.ToString(),
                ActorDisplayName = user.Username,
                Reason = reason
            });

            await _db.SaveChangesAsync(ct);
            return InvalidCredentials();
        }

        user.FailedLoginCount = 0;
        user.LockedUntilUtc = null;
        user.LastLoginUtc = nowUtc;

        // Cost creep is free to apply here: the plaintext is in hand exactly
        // once, and the user never notices the upgrade.
        if (_hasher.NeedsRehash(user.PasswordIterations))
        {
            PasswordHashResult rehashed = _hasher.Hash(request.Password);
            user.PasswordHash = rehashed.Hash;
            user.PasswordSalt = rehashed.Salt;
            user.PasswordIterations = rehashed.Iterations;
        }

        IssuedToken token = _tokens.Issue(user);
        IssuedRefreshToken refresh = await _refreshTokens.IssueAsync(user, ct);

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.Login,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = user.Id.ToString(),
            ActorDisplayName = user.Username,
            Details = new { user.Role, user.HasElevatedSql, user.MustChangePassword }
        });

        await _db.SaveChangesAsync(ct);

        return OperationResult<LoginResponse>.Ok(new LoginResponse
        {
            AccessToken = token.AccessToken,
            ExpiresAtUtc = token.ExpiresUtc,
            RefreshToken = refresh.Value,
            RefreshTokenExpiresAtUtc = refresh.ExpiresUtc,
            UserId = user.Id,
            DisplayName = user.DisplayName,
            Role = user.Role,
            HasElevatedSql = user.HasElevatedSql,
            MustChangePassword = user.MustChangePassword
        });
    }

    public async Task<OperationResult> ChangePasswordAsync(
        Guid userId, ChangePasswordRequest request, CancellationToken ct)
    {
        User? user = await _db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);

        if (user is null || !user.IsActive)
        {
            await _audit.WriteDenialAsync(
                AuditEvent.ChangePassword, "Unknown or inactive user.", null, null, cancellationToken: ct);
            return OperationResult.Forbidden("Password change refused.");
        }

        if (!_hasher.Verify(
                request.CurrentPassword, user.PasswordHash, user.PasswordSalt, user.PasswordIterations))
        {
            _audit.Enqueue(new AuditRecord
            {
                Event = AuditEvent.ChangePassword,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Denied,
                ActorType = ActorType.User,
                ActorId = user.Id.ToString(),
                ActorDisplayName = user.Username,
                Reason = "Current password did not verify."
            });

            await _db.SaveChangesAsync(ct);
            return OperationResult.Forbidden("The current password is incorrect.");
        }

        string? complaint = _hasher.ValidateComplexity(request.NewPassword);

        if (complaint is not null)
        {
            // The complaint describes the policy, never the password.
            return OperationResult.Invalid(complaint);
        }

        if (string.Equals(request.CurrentPassword, request.NewPassword, StringComparison.Ordinal))
        {
            return OperationResult.Invalid("The new password must differ from the current one.");
        }

        PasswordHashResult hashed = _hasher.Hash(request.NewPassword);
        user.PasswordHash = hashed.Hash;
        user.PasswordSalt = hashed.Salt;
        user.PasswordIterations = hashed.Iterations;
        user.MustChangePassword = false;
        await _refreshTokens.RevokeAllAsync(user.Id, "Password changed.", ct);

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.ChangePassword,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = user.Id.ToString(),
            ActorDisplayName = user.Username,
            Reason = "User changed their own password."
        });

        await _db.SaveChangesAsync(ct);

        return OperationResult.Ok();
    }

    /// <summary>
    /// One message for every credential failure. Which field was wrong, and
    /// whether the account exists at all, are not the caller's business.
    /// </summary>
    private static OperationResult<LoginResponse> InvalidCredentials() =>
        OperationResult<LoginResponse>.Forbidden("Invalid username or password.");

    private Task WriteLoginDenialAsync(
        string username, string reason, CancellationToken ct, User? user = null) =>
        _audit.WriteAsync(new AuditRecord
        {
            Event = AuditEvent.Login,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Denied,
            ActorType = user is null ? ActorType.Anonymous : ActorType.User,
            ActorId = user?.Id.ToString(),
            // The attempted username is an identifier, not a secret, and
            // without it a brute-force pattern is invisible in the trail.
            ActorDisplayName = username,
            Reason = reason
        }, ct);
}
