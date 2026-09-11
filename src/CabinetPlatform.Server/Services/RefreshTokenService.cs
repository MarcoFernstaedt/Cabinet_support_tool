using System.Security.Cryptography;
using CabinetPlatform.Contracts.Audit;
using CabinetPlatform.Contracts.Auth;
using CabinetPlatform.Server.Auditing;
using CabinetPlatform.Server.Configuration;
using CabinetPlatform.Server.Data;
using CabinetPlatform.Server.Domain;
using CabinetPlatform.Server.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Services;

/// <summary>A refresh token's value and when it dies.</summary>
/// <param name="Value">The opaque token handed to the client. Never stored.</param>
/// <param name="ExpiresUtc">When it stops being accepted.</param>
public sealed record IssuedRefreshToken(string Value, DateTimeOffset ExpiresUtc);

/// <summary>Issuing, rotating and revoking refresh tokens.</summary>
public interface IRefreshTokenService
{
    /// <summary>Starts a new chain for a user who has just signed in.</summary>
    /// <param name="user">The user.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<IssuedRefreshToken> IssueAsync(User user, CancellationToken ct);

    /// <summary>
    /// Exchanges a refresh token for a new access token and a replacement
    /// refresh token, against the user's permissions as they stand now.
    /// </summary>
    /// <param name="presented">The token the client presented.</param>
    /// <param name="ct">Cancels the operation.</param>
    Task<OperationResult<RefreshResponse>> RefreshAsync(string presented, CancellationToken ct);

    /// <summary>Ends every session a user holds, immediately.</summary>
    /// <param name="userId">The user.</param>
    /// <param name="reason">Why, for the audit trail.</param>
    /// <param name="ct">Cancels the operation.</param>
    /// <returns>How many live tokens were revoked.</returns>
    Task<int> RevokeAllAsync(Guid userId, string reason, CancellationToken ct);
}

/// <summary>
/// The one piece of server-side session state, and the reason the rest of the
/// request path can stay stateless.
/// </summary>
/// <remarks>
/// <para>
/// Access tokens are short-lived and are never checked against the database, so
/// any instance can serve any request. Refresh is where the user's
/// <em>current</em> role, elevated grant and active flag are re-read. That is
/// what makes a revocation take effect: when a Supervisor withdraws a grant or
/// disables an offboarded rep, effective access ends within one access-token
/// lifetime rather than whenever a long-lived token happens to expire.
/// </para>
/// <para>
/// Tokens rotate on use, and reuse of a consumed token revokes the whole chain.
/// A replayed refresh is either a client bug or a stolen token, and both are
/// worth ending the session over.
/// </para>
/// </remarks>
public sealed class RefreshTokenService : IRefreshTokenService
{
    private const int TokenBytes = 32;

    private readonly SupportDbContext _db;
    private readonly IJwtTokenService _tokens;
    private readonly IAuditService _audit;
    private readonly JwtOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<RefreshTokenService> _logger;

    /// <summary>Creates the service.</summary>
    /// <param name="db">The database.</param>
    /// <param name="tokens">Mints access tokens.</param>
    /// <param name="audit">The audit trail.</param>
    /// <param name="options">Token lifetimes.</param>
    /// <param name="timeProvider">Clock.</param>
    /// <param name="logger">Diagnostic log.</param>
    public RefreshTokenService(
        SupportDbContext db,
        IJwtTokenService tokens,
        IAuditService audit,
        IOptions<JwtOptions> options,
        TimeProvider timeProvider,
        ILogger<RefreshTokenService> logger)
    {
        _db = db;
        _tokens = tokens;
        _audit = audit;
        _options = options.Value;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task<IssuedRefreshToken> IssueAsync(User user, CancellationToken ct) =>
        Task.FromResult(Mint(user.Id, Guid.NewGuid(), null));

    /// <inheritdoc />
    public async Task<OperationResult<RefreshResponse>> RefreshAsync(string presented, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();
        byte[] hash = Hash(presented);

        RefreshToken? stored = await _db.RefreshTokens
            .Include(t => t.User)
            .FirstOrDefaultAsync(t => t.TokenHash == hash, ct);

        if (stored is null)
        {
            // An unrecognised token says nothing about whether it was ever
            // valid. The answer is the same either way.
            await _audit.WriteDenialAsync(
                AuditEvent.RefreshToken, "Refresh token was not recognised.",
                cancellationToken: ct);
            return OperationResult<RefreshResponse>.Forbidden("The session has ended. Sign in again.");
        }

        if (stored.ConsumedUtc is not null)
        {
            // Reuse. The chain is dead, and this is worth a record of its own:
            // it is either a client bug or somebody holding a token they should
            // not have.
            int revoked = await RevokeChainAsync(
                stored.ChainId, "A consumed refresh token was presented again.", nowUtc, ct);

            await _audit.WriteAsync(new AuditRecord
            {
                Event = AuditEvent.RefreshTokenReuse,
                EventKind = AuditEventKind.Observed,
                Result = AuditResult.Denied,
                ActorType = ActorType.User,
                ActorId = stored.UserId.ToString(),
                ActorDisplayName = stored.User?.Username,
                Reason = "A consumed refresh token was presented again; the whole chain was revoked.",
                Details = new { stored.ChainId, TokensRevoked = revoked },
            }, ct);

            _logger.LogWarning(
                "Refresh token reuse detected for user {UserId}; chain {ChainId} revoked.",
                stored.UserId, stored.ChainId);

            return OperationResult<RefreshResponse>.Forbidden("The session has ended. Sign in again.");
        }

        if (!stored.IsUsable(nowUtc))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.RefreshToken,
                stored.RevokedUtc is not null
                    ? "Refresh token had been revoked."
                    : "Refresh token had expired.",
                cancellationToken: ct);
            return OperationResult<RefreshResponse>.Forbidden("The session has ended. Sign in again.");
        }

        User? user = stored.User;

        // Re-read from the row, not from the claims minted at sign-in. This is
        // the whole point of the design: a permission withdrawn five minutes
        // ago must not survive in a token issued an hour ago.
        if (user is null || !user.IsActive)
        {
            await RevokeChainAsync(stored.ChainId, "User is no longer active.", nowUtc, ct);

            await _audit.WriteDenialAsync(
                AuditEvent.RefreshToken, "Refresh refused: the account is inactive or gone.",
                cancellationToken: ct);

            return OperationResult<RefreshResponse>.Forbidden("The session has ended. Sign in again.");
        }

        if (user.IsLockedOut(nowUtc))
        {
            await _audit.WriteDenialAsync(
                AuditEvent.RefreshToken, "Refresh refused: the account is locked out.",
                cancellationToken: ct);

            return OperationResult<RefreshResponse>.Forbidden("The session has ended. Sign in again.");
        }

        IssuedRefreshToken replacement = Mint(user.Id, stored.ChainId, stored);
        IssuedToken access = _tokens.Issue(user);

        _audit.Enqueue(new AuditRecord
        {
            Event = AuditEvent.RefreshToken,
            EventKind = AuditEventKind.Observed,
            Result = AuditResult.Success,
            ActorType = ActorType.User,
            ActorId = user.Id.ToString(),
            ActorDisplayName = user.Username,
            Details = new { stored.ChainId, user.Role, user.HasElevatedSql },
        });

        await _db.SaveChangesAsync(ct);

        return OperationResult<RefreshResponse>.Ok(new RefreshResponse
        {
            AccessToken = access.AccessToken,
            ExpiresAtUtc = access.ExpiresUtc,
            RefreshToken = replacement.Value,
            RefreshTokenExpiresAtUtc = replacement.ExpiresUtc,
            UserId = user.Id,
            DisplayName = user.DisplayName,
            Role = user.Role,
            HasElevatedSql = user.HasElevatedSql,
            MustChangePassword = user.MustChangePassword,
        });
    }

    /// <inheritdoc />
    public async Task<int> RevokeAllAsync(Guid userId, string reason, CancellationToken ct)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();

        List<RefreshToken> live = await _db.RefreshTokens
            .Where(t => t.UserId == userId && t.RevokedUtc == null && t.ConsumedUtc == null)
            .ToListAsync(ct);

        foreach (RefreshToken token in live)
        {
            token.RevokedUtc = nowUtc;
            token.RevokedReason = reason;
        }

        return live.Count;
    }

    private async Task<int> RevokeChainAsync(
        Guid chainId, string reason, DateTimeOffset nowUtc, CancellationToken ct)
    {
        List<RefreshToken> chain = await _db.RefreshTokens
            .Where(t => t.ChainId == chainId && t.RevokedUtc == null)
            .ToListAsync(ct);

        foreach (RefreshToken token in chain)
        {
            token.RevokedUtc = nowUtc;
            token.RevokedReason = reason;
        }

        await _db.SaveChangesAsync(ct);
        return chain.Count;
    }

    /// <summary>
    /// Creates a token row and returns the value, consuming its predecessor.
    /// </summary>
    /// <remarks>
    /// Only the hash is persisted. A database disclosure must not hand anybody
    /// a usable session.
    /// </remarks>
    private IssuedRefreshToken Mint(Guid userId, Guid chainId, RefreshToken? predecessor)
    {
        DateTimeOffset nowUtc = _timeProvider.GetUtcNow();
        string value = Convert.ToBase64String(RandomNumberGenerator.GetBytes(TokenBytes));

        var token = new RefreshToken
        {
            UserId = userId,
            ChainId = chainId,
            TokenHash = Hash(value),
            IssuedUtc = nowUtc,
            ExpiresUtc = nowUtc.AddMinutes(_options.RefreshTokenLifetimeMinutes),
        };

        _db.RefreshTokens.Add(token);

        if (predecessor is not null)
        {
            predecessor.ConsumedUtc = nowUtc;
            predecessor.ReplacedByTokenId = token.Id;
        }

        return new IssuedRefreshToken(value, token.ExpiresUtc);
    }

    private static byte[] Hash(string value) =>
        SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value));
}
