using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text;

namespace Cabinet.Agent.Windows;

/// <summary>
/// The only way the agent starts another program (docs/spec/04-agent-spec.md "Running external
/// programs"): one of a short list of named Windows programs, by full path from System32, with an argument
/// array, never through a shell. Output is captured and size-capped, and every call has a time limit.
/// </summary>
[SupportedOSPlatform("windows")]
public static class ExternalProgram
{
    /// <summary>The programs the broker may start, and nothing else.</summary>
    public static readonly IReadOnlySet<string> Allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "pnputil.exe", "msiexec.exe", "netsh.exe", "tzutil.exe", "w32tm.exe", "wusa.exe", "ipconfig.exe", "sc.exe", "powercfg.exe", "shutdown.exe", "dism.exe" };
    private const int MaxOutputChars = 64 * 1024;

    public sealed record Outcome(int ExitCode, string Output);

    public static Outcome Run(string program, IReadOnlyList<string> arguments, TimeSpan timeout)
    {
        if (!Allowed.Contains(program)) throw new InvalidOperationException($"{program} is not a program the agent may start.");
        string path = Path.Combine(Environment.SystemDirectory, program);
        var info = new ProcessStartInfo(path)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = Environment.SystemDirectory, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (string a in arguments) info.ArgumentList.Add(a);
        using var process = new Process { StartInfo = info };
        var output = new StringBuilder();
        void Capture(object _, DataReceivedEventArgs e)
        {
            if (e.Data is null) return;
            lock (output) if (output.Length < MaxOutputChars) output.AppendLine(e.Data.Length > 2048 ? e.Data[..2048] : e.Data);
        }
        process.OutputDataReceived += Capture;
        process.ErrorDataReceived += Capture;
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        if (!process.WaitForExit(timeout))
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            throw new Core.OperationFailedException("timeout", $"{program} did not finish within its time limit.");
        }
        process.WaitForExit();
        lock (output) return new Outcome(process.ExitCode, output.ToString());
    }
}
