using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text;
using System.Text.RegularExpressions;
using Cabinet.Agent.Windows;

[assembly: SupportedOSPlatform("windows")]

namespace Cabinet.Agent.SessionShellRepro;

/// <summary>A local, byte-exact instrument for repeated PowerShell children in the product ConPTY.</summary>
public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("Requires Windows ConPTY."); return 2; }
        if (args.Length > 1 || (args.Length == 1 && (!int.TryParse(args[0], out int seconds) || seconds < 1)))
        {
            Console.Error.WriteLine("Usage: Cabinet.Agent.SessionShellRepro.exe [timeout-seconds-per-command (default 45)]");
            return 2;
        }
        int timeout = args.Length == 0 ? 45 : int.Parse(args[0]);
        var watch = Stopwatch.StartNew();
        object gate = new();
        int lineIndex = 0, childIndex = 0;
        var received = new StringBuilder();
        // Use the real constructor: bootstrap, handles, dimensions and stream types stay in product code.
        using var terminal = new SessionTerminal();
        terminal.Resize(100, 30); // The acceptance uses this size after opening the session.
        void Event(string message)
        {
            lock (gate) Console.WriteLine($"{watch.Elapsed.TotalMilliseconds:F3}ms line={lineIndex} child={childIndex} {message}");
        }
        // Keep draining through disposal: ClosePseudoConsole waits for its output writer.
        Task reader = Task.Run(async () => {
            byte[] buffer = new byte[4096];
            try
            {
                int count;
                while ((count = await terminal.Output.ReadAsync(buffer)) != 0)
                {
                    lock (gate)
                    {
                        // Hex is lossless, including invalid UTF-8, NUL, CR, LF and all VT sequences.
                        Event($"OUT bytes={count} hex={Convert.ToHexString(buffer.AsSpan(0, count))}");
                        // All completion tokens are ASCII; decoding chunks cannot split these characters.
                        received.Append(Encoding.ASCII.GetString(buffer, 0, count));
                    }
                }
                Event("OUTPUT_EOF");
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException)
            { Event($"OUTPUT_CLOSED {error.GetType().Name}: {error.Message}"); }
        });

        (string Line, string Done, string? Failed, string? Started, int Child, bool ExpectFailure)
            PowerShell(string source, int child, bool expectFailure = false)
        {
            string nonce = Guid.NewGuid().ToString("N");
            string script = $$"""
                $ErrorActionPreference = 'Stop'
                $exitCode = 0
                try {
                    [Console]::Out.WriteLine(('START_' + '{{nonce}}'))
                    [Console]::Out.Flush()
                    {{source}}
                    [Console]::Out.WriteLine(('DONE_' + '{{nonce}}'))
                } catch {
                    $exitCode = 1
                    [Console]::Error.WriteLine($_.ToString())
                    [Console]::Out.WriteLine(('FAIL_' + '{{nonce}}'))
                } finally {
                    [Console]::Out.Flush()
                    [Console]::Error.Flush()
                    Start-Sleep -Milliseconds 250
                }
                exit $exitCode
                """;
            return ("powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
                Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) + "\r",
                "DONE_" + nonce, "FAIL_" + nonce, "START_" + nonce, child, expectFailure);
        }

        (string Line, string Done, string? Failed, string? Started, int Child, bool ExpectFailure)[] commands = {
            PowerShell("[Console]::Out.WriteLine(('CHILD_' + 'STDOUT')); [Console]::Error.WriteLine(('CHILD_' + 'STDERR'))", 1),
            PowerShell("""
                try {
                    $ErrorActionPreference = 'Continue'
                    $status = & 'C:\Program Files\Tailscale\tailscale.exe' status --json 2>&1
                    $statusExit = $LASTEXITCODE
                    if ($statusExit -eq 0) {
                        $state = ($status -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
                        [Console]::Out.WriteLine("Tailscale BackendState=$($state.BackendState)")
                    } else {
                        [Console]::Out.WriteLine("Tailscale status exit=$statusExit output=$($status -join ' ')")
                    }
                } catch {
                    [Console]::Out.WriteLine("Tailscale status error: $_")
                } finally {
                    $ErrorActionPreference = 'Stop'
                }
                throw 'Intentional repro failure'
                """, 2, expectFailure: true),
            ("set /a 483+217\r", "700", null, null, 0, false),
            ("set /a 631+109\r", "740", null, null, 0, false),
            ("set /a 205+744\r", "949", null, null, 0, false),
            PowerShell("""$identity=whoami; [Console]::Out.WriteLine([string]$identity); $machine=($identity -match '^NT AUTHORITY\\') -or ($identity -match ('^' + [regex]::Escape($env:COMPUTERNAME) + '\\')); if ($LASTEXITCODE -ne 0 -or -not $machine) { throw 'whoami did not name the cabinet machine context' }""", 3)
        };
        var outcomes = new (string Status, bool Started, bool Passed)[commands.Length];
        Array.Fill(outcomes, ("NOT_SENT", false, false));
        try
        {
            Event($"START identity={Environment.UserDomainName}\\{Environment.UserName} timeout={timeout}s; no network state is changed");
            foreach (var command in commands)
            {
                // Same 1.5s settling period as acceptance; output retains the previous attribution until send.
                await Task.Delay(1500);
                lock (gate)
                {
                    lineIndex++;
                    childIndex = command.Child;
                    received.Clear();
                }
                byte[] input = Encoding.UTF8.GetBytes(command.Line);
                Event($"IN bytes={input.Length} hex={Convert.ToHexString(input)} start={command.Started ?? "-"} done={command.Done} fail={command.Failed ?? "-"} expectFailure={command.ExpectFailure}");
                // The product pipe is synchronous underneath FileStream. Keep a blocked write
                // off this thread so the instrument can still time it out and terminate the tree.
                Task write = Task.Run(async () => {
                    await terminal.Input.WriteAsync(input);
                    await terminal.Input.FlushAsync();
                });
                try { await write.WaitAsync(TimeSpan.FromSeconds(timeout)); }
                catch (TimeoutException)
                {
                    Event("INPUT_TIMEOUT; terminating shell tree");
                    outcomes[lineIndex - 1] = ("INPUT_TIMEOUT", false, false);
                    terminal.Terminate();
                    break;
                }
                catch (IOException error)
                {
                    Event($"INPUT_CLOSED: {error.Message}");
                    outcomes[lineIndex - 1] = ("INPUT_CLOSED", false, false);
                    break;
                }
                Event("INPUT_FLUSHED");
                var deadline = Stopwatch.StartNew();
                bool started = false;
                string status;
                bool passed = false;
                while (true)
                {
                    if (reader.IsFaulted) await reader;
                    string output;
                    lock (gate) output = received.ToString();
                    output = Regex.Replace(output, "\u001b\\[[0-?]*[ -/]*[@-~]", "");
                    started = command.Started is { } start && output.Contains(start, StringComparison.Ordinal);
                    if (command.Failed is { } failed && output.Contains(failed, StringComparison.Ordinal))
                    {
                        status = command.ExpectFailure ? "EXPECTED_FAILURE" : "COMMAND_FAILED";
                        passed = command.ExpectFailure;
                        break;
                    }
                    if (output.Contains(command.Done, StringComparison.Ordinal))
                    {
                        bool streamsPresent = lineIndex != 1 ||
                            (output.Contains("CHILD_STDOUT", StringComparison.Ordinal) &&
                             output.Contains("CHILD_STDERR", StringComparison.Ordinal));
                        status = command.ExpectFailure ? "UNEXPECTED_SUCCESS" :
                            streamsPresent ? "COMPLETED" : "MISSING_CHILD_STDOUT_OR_STDERR";
                        passed = !command.ExpectFailure && streamsPresent;
                        break;
                    }
                    if (terminal.HasExited)
                    {
                        Event($"SHELL_EXIT code={terminal.ExitCode}");
                        status = "SHELL_EXIT";
                        break;
                    }
                    if (deadline.Elapsed >= TimeSpan.FromSeconds(timeout))
                    {
                        status = "OUTPUT_TIMEOUT";
                        break;
                    }
                    await Task.Delay(25);
                }
                outcomes[lineIndex - 1] = (status, started, passed);
                Event(status);
                if (status == "SHELL_EXIT") break;
            }
        }
        finally
        {
            Event("DISPOSING");
            terminal.Dispose();
            await reader;
        }
        for (int i = 0; i < commands.Length; i++)
        {
            var command = commands[i];
            var outcome = outcomes[i];
            string started = command.Started is null ? "-" : outcome.Started.ToString();
            Console.WriteLine($"SUMMARY line={i + 1} child={command.Child} status={outcome.Status} startSeen={started}");
        }
        int result = outcomes.All(outcome => outcome.Passed) ? 0 : 1;
        Event($"RESULT code={result}; child index attributes bytes to the last submitted command, not a proven output producer");
        return result;
    }
}
