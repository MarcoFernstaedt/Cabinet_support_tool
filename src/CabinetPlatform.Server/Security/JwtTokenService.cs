using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using CabinetPlatform.Server.Domain;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace CabinetPlatform.Server.Security;

public sealed class JwtOptions
{
    public const string SectionName = "Jwt";

    public string Issuer { get; set; } = "mashura-cabinet-support";
    public string Audience { get; set; } = "mashura-cabinet-support-console";

    /// <summary>
    /// Supplied per deployment through configuration. Never committed, never
    /// defaulted to a usable value — the server refuses to start without it.
    /// </summary>
    public string? SigningKey { get; set; }

    /// <summary>
    /// Access-token lifetime. Deliberately short: the token is stateless, so it
    /// cannot be revoked, and its lifetime is therefore the upper bound on how
    /// long a withdrawn permission can still be used. Fifteen minutes is the
    /// window a Supervisor's revocation has to wait out.
    /// </summary>
    public int TokenLifetimeMinutes { get; set; } = 15;

    /// <summary>
    /// Refresh-token lifetime. Long enough that a rep works a shift without
    /// signing in twice; every use rotates it, and every use re-reads the
    /// user's current permissions from the database.
    /// </summary>
    public int RefreshTokenLifetimeMinutes { get; set; } = 720;
}

/// <summary>An access token and when it dies.</summary>
/// <param name="AccessToken">The bearer token.</param>
/// <param name="ExpiresUtc">When it stops being accepted.</param>
public sealed record IssuedToken(string AccessToken, DateTimeOffset ExpiresUtc);

public interface IJwtTokenService
{
    IssuedToken Issue(User user);
    TokenValidationParameters BuildValidationParameters();
}

/// <summary>
/// Issues short-lived bearer tokens.
///
/// The claims here describe the user as the database saw them at login. They
/// are convenience for the server's own authorization handlers — a client
/// cannot mint or edit them, because the token is signed, and a client-supplied
/// role in a request body is never consulted anywhere in this codebase.
/// </summary>
public sealed class JwtTokenService : IJwtTokenService
{
    private const int MinimumKeyBytes = 32;

    private readonly JwtOptions _options;
    private readonly SymmetricSecurityKey _key;

    public JwtTokenService(IOptions<JwtOptions> options)
    {
        _options = options.Value;

        if (string.IsNullOrWhiteSpace(_options.SigningKey))
        {
            throw new InvalidOperationException(
                $"{JwtOptions.SectionName}:SigningKey is not configured. " +
                "Supply it through environment configuration or a secret store.");
        }

        byte[] keyBytes = Encoding.UTF8.GetBytes(_options.SigningKey);

        if (keyBytes.Length < MinimumKeyBytes)
        {
            throw new InvalidOperationException(
                $"{JwtOptions.SectionName}:SigningKey must be at least {MinimumKeyBytes} bytes.");
        }

        _key = new SymmetricSecurityKey(keyBytes);
    }

    public IssuedToken Issue(User user)
    {
        DateTime nowUtc = DateTime.UtcNow;
        DateTime expiresUtc = nowUtc.AddMinutes(_options.TokenLifetimeMinutes);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new(SupportClaims.UserId, user.Id.ToString()),
            new(SupportClaims.Role, user.Role.ToString()),
            new(SupportClaims.ElevatedSql, user.HasElevatedSql ? "true" : "false"),
            new(SupportClaims.MustChangePassword, user.MustChangePassword ? "true" : "false"),
            new(SupportClaims.SessionId, Guid.NewGuid().ToString()),
            new(ClaimTypes.Name, user.Username),
            new(ClaimTypes.NameIdentifier, user.Id.ToString())
        };

        var token = new JwtSecurityToken(
            issuer: _options.Issuer,
            audience: _options.Audience,
            claims: claims,
            notBefore: nowUtc,
            expires: expiresUtc,
            signingCredentials: new SigningCredentials(_key, SecurityAlgorithms.HmacSha256));

        return new IssuedToken(new JwtSecurityTokenHandler().WriteToken(token), expiresUtc);
    }

    public TokenValidationParameters BuildValidationParameters() => new()
    {
        ValidateIssuer = true,
        ValidIssuer = _options.Issuer,
        ValidateAudience = true,
        ValidAudience = _options.Audience,
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = _key,
        ValidateLifetime = true,
        ClockSkew = TimeSpan.FromSeconds(30),
        NameClaimType = ClaimTypes.Name,
        RoleClaimType = SupportClaims.Role
    };
}
