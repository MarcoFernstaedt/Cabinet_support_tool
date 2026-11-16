using Cabinet.Agent.Core.Upgrades;
using Cabinet.Agent.Windows;
using Xunit;

namespace Cabinet.Agent.Windows.Tests;

public sealed class ProductionSignatureFactAttribute : FactAttribute
{
    public ProductionSignatureFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SIGNED_AGENT_BINARY")))
            Skip = "Set SIGNED_AGENT_BINARY to the production-signed executable, after installing the pinned root.";
    }
}

public sealed class UpgradeSignatureTests
{
    [ProductionSignatureFact]
    public void Windows_accepts_the_pinned_publisher_and_refuses_a_changed_binary()
    {
        string signed = Path.GetFullPath(Environment.GetEnvironmentVariable("SIGNED_AGENT_BINARY")!);
        var authenticode = new WindowsAuthenticode();
        Assert.Null(AgentSignatures.Problem(signed, UpgradeTrust.Compiled, authenticode));
        string copy = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".exe");
        try
        {
            byte[] bytes = File.ReadAllBytes(signed);
            bytes[0x40] ^= 1;
            File.WriteAllBytes(copy, bytes);
            Assert.NotEqual(0, authenticode.Verify(copy));
            Assert.NotNull(AgentSignatures.Problem(copy, UpgradeTrust.Compiled, authenticode));
            // Remove the certificate table from the original PE, leaving a runnable but unsigned image.
            bytes = File.ReadAllBytes(signed);
            int optional = BitConverter.ToInt32(bytes, 0x3c) + 24;
            int directory = optional + (BitConverter.ToUInt16(bytes, optional) == 0x20b ? 112 : 96) + 4 * 8;
            int certificateOffset = BitConverter.ToInt32(bytes, directory);
            Assert.True(certificateOffset > directory + 8 && certificateOffset < bytes.Length);
            Array.Clear(bytes, directory, 8);
            File.WriteAllBytes(copy, bytes[..certificateOffset]);
            Assert.NotEqual(0, authenticode.Verify(copy));
            Assert.NotNull(AgentSignatures.Problem(copy, UpgradeTrust.Compiled, authenticode));
        }
        finally { File.Delete(copy); }
    }
}
