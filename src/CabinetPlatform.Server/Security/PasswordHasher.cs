using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace CabinetPlatform.Server.Security;

public sealed class PasswordOptions
{
    public const string SectionName = "Password";

    /// <summary>PBKDF2-HMAC-SHA256 iterations. Raise over time; never lower.</summary>
    public int Iterations { get; set; } = 210_000;

    public int SaltBytes { get; set; } = 16;
    public int HashBytes { get; set; } = 32;

    public int MinimumLength { get; set; } = 12;
    public int MaximumLength { get; set; } = 256;

    /// <summary>Require a mix of character classes as well as length.</summary>
    public bool RequireMixedCharacterClasses { get; set; } = true;
}

public sealed record PasswordHashResult(byte[] Hash, byte[] Salt, int Iterations);

public interface IPasswordHasher
{
    PasswordHashResult Hash(string password);

    /// <summary>
    /// Verifies in constant time with respect to the hash contents. Returns
    /// false rather than throwing on a malformed stored credential.
    /// </summary>
    bool Verify(string password, byte[] expectedHash, byte[] salt, int iterations);

    /// <summary>True when a stored credential was made with a weaker cost than current policy.</summary>
    bool NeedsRehash(int iterations);

    /// <summary>Null when acceptable, otherwise the reason it was refused.</summary>
    string? ValidateComplexity(string password);
}

/// <summary>
/// PBKDF2-HMAC-SHA256 with a per-user salt.
///
/// Nothing in this class logs, and nothing returns a password or a hash in an
/// exception message — a stack trace that carries the credential it was
/// checking is exactly the leak this whole file exists to avoid.
/// </summary>
public sealed class Pbkdf2PasswordHasher : IPasswordHasher
{
    private const int AbsoluteMinimumIterations = 100_000;

    private readonly PasswordOptions _options;

    public Pbkdf2PasswordHasher(IOptions<PasswordOptions> options)
    {
        _options = options.Value;

        if (_options.Iterations < AbsoluteMinimumIterations)
        {
            // Fail at startup rather than quietly weakening every credential
            // the deployment is about to create.
            throw new InvalidOperationException(
                $"Password:Iterations must be at least {AbsoluteMinimumIterations}.");
        }
    }

    public PasswordHashResult Hash(string password)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);

        byte[] salt = RandomNumberGenerator.GetBytes(_options.SaltBytes);
        byte[] hash = Derive(password, salt, _options.Iterations, _options.HashBytes);
        return new PasswordHashResult(hash, salt, _options.Iterations);
    }

    public bool Verify(string password, byte[] expectedHash, byte[] salt, int iterations)
    {
        if (string.IsNullOrEmpty(password) ||
            expectedHash is not { Length: > 0 } ||
            salt is not { Length: > 0 } ||
            iterations <= 0)
        {
            return false;
        }

        byte[] actual = Derive(password, salt, iterations, expectedHash.Length);

        // FixedTimeEquals, not SequenceEqual: an early-exit comparison leaks
        // how much of the hash matched, one byte at a time.
        return CryptographicOperations.FixedTimeEquals(actual, expectedHash);
    }

    public bool NeedsRehash(int iterations) => iterations < _options.Iterations;

    public string? ValidateComplexity(string password)
    {
        if (string.IsNullOrEmpty(password))
        {
            return "Password is required.";
        }

        if (password.Length < _options.MinimumLength)
        {
            return $"Password must be at least {_options.MinimumLength} characters.";
        }

        if (password.Length > _options.MaximumLength)
        {
            return $"Password must be at most {_options.MaximumLength} characters.";
        }

        if (!_options.RequireMixedCharacterClasses)
        {
            return null;
        }

        int classes = 0;
        if (password.Any(char.IsUpper)) classes++;
        if (password.Any(char.IsLower)) classes++;
        if (password.Any(char.IsDigit)) classes++;
        if (password.Any(c => !char.IsLetterOrDigit(c))) classes++;

        return classes < 3
            ? "Password must contain at least three of: uppercase, lowercase, digit, symbol."
            : null;
    }

    private static byte[] Derive(string password, byte[] salt, int iterations, int length) =>
        Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            salt,
            iterations,
            HashAlgorithmName.SHA256,
            length);
}
