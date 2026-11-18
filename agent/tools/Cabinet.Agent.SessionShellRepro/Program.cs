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
    private readonly record struct Command(string Line, string Done, string? Failed, string? Started,
        int Child, bool ExpectFailure, string? TracePath = null);

    public static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("Requires Windows ConPTY."); return 2; }
        bool repeat = args.Length > 0 && args[0] == "--repeat";
        int count = 0;
        int timeout = 45;
        int timeoutIndex = repeat ? 2 : 0;
        if (args.Length > timeoutIndex + 1 ||
            (repeat && (args.Length < 2 || !int.TryParse(args[1], out count) || count < 1)) ||
            (args.Length > timeoutIndex && (!int.TryParse(args[timeoutIndex], out timeout) || timeout < 1)))
        {
            Console.Error.WriteLine("Usage: Cabinet.Agent.SessionShellRepro.exe [timeout-seconds-per-command (default 45)]");
            Console.Error.WriteLine("       Cabinet.Agent.SessionShellRepro.exe --repeat N [timeout-seconds-per-command (default 45)]");
            return 2;
        }
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

        Command PowerShell(string source, int child, bool expectFailure = false)
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
            return new("powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
                Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) + "\r",
                "DONE_" + nonce, "FAIL_" + nonce, "START_" + nonce, child, expectFailure);
        }

        Command RepeatChild(int child)
        {
            string nonce = Guid.NewGuid().ToString("N");
            string marker = "DONE_" + nonce;
            string tracePath = Path.Combine(Path.GetTempPath(), $"Cabinet.SessionShellRepro.{nonce}.trace");
            string escapedTracePath = tracePath.Replace("'", "''", StringComparison.Ordinal);
            // The trace bypasses the console. Its first entry proves the script reached the
            // write, and its second records whether the managed write and flush returned.
            string script = $$"""
                $ErrorActionPreference = 'Stop'
                $trace = '{{escapedTracePath}}'
                [IO.File]::WriteAllText($trace, "before-write pid=$PID utc=$([DateTime]::UtcNow.ToString('O'))" + [Environment]::NewLine)
                try {
                    [Console]::Out.WriteLine('{{marker}}')
                    [Console]::Out.Flush()
                } catch {
                    [IO.File]::AppendAllText($trace, "write-or-flush-error: $($_.Exception)" + [Environment]::NewLine)
                    exit 1
                }
                [IO.File]::AppendAllText($trace, "after-flush utc=$([DateTime]::UtcNow.ToString('O'))" + [Environment]::NewLine)
                """;
            return new("powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
                Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) + "\r",
                marker, null, null, child, false, tracePath);
        }

        Command[] commands = repeat ? Enumerable.Range(1, count).Select(RepeatChild).ToArray() : [
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
            new("set /a 483+217\r", "700", null, null, 0, false),
            new("set /a 631+109\r", "740", null, null, 0, false),
            new("set /a 205+744\r", "949", null, null, 0, false),
            PowerShell("""$identity=whoami; [Console]::Out.WriteLine([string]$identity); $machine=($identity -match '^NT AUTHORITY\\') -or ($identity -match ('^' + [regex]::Escape($env:COMPUTERNAME) + '\\')); if ($LASTEXITCODE -ne 0 -or -not $machine) { throw 'whoami did not name the cabinet machine context' }""", 3)
        ];
        var outcomes = new (string Status, bool Started, bool Passed)[commands.Length];
        Array.Fill(outcomes, ("NOT_SENT", false, false));
        try
        {
            Event($"START identity={Environment.UserDomainName}\\{Environment.UserName} timeout={timeout}s; no network state is changed");
            foreach (var command in commands)
            {
                // Keep the acceptance settling period in sequence mode only.
                if (!repeat) await Task.Delay(1500);
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
                    outcomes[lineIndex - 1] = ("INPUT_TIMEOUT", File.Exists(command.TracePath), false);
                    terminal.Terminate();
                    break;
                }
                catch (IOException error)
                {
                    Event($"INPUT_CLOSED: {error.Message}");
                    outcomes[lineIndex - 1] = ("INPUT_CLOSED", File.Exists(command.TracePath), false);
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
                        bool streamsPresent = repeat || lineIndex != 1 ||
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
                outcomes[lineIndex - 1] = (status, started || File.Exists(command.TracePath), passed);
                Event(status);
                if (repeat) Event($"VERDICT {Verdict(outcomes[lineIndex - 1])}");
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
            if (command.TracePath is { } tracePath)
            {
                Console.WriteLine($"SUMMARY line={i + 1} child={command.Child} status={outcome.Status} verdict={Verdict(outcome)}");
                PrintTrace(command.Child, tracePath);
            }
            else
            {
                string started = command.Started is null ? "-" : outcome.Started.ToString();
                Console.WriteLine($"SUMMARY line={i + 1} child={command.Child} status={outcome.Status} startSeen={started}");
            }
        }
        if (repeat)
            Console.WriteLine($"TALLY requested={count} delivered={outcomes.Count(o => o.Passed)} " +
                $"startedWithoutOutcome={outcomes.Count(o => Verdict(o) == "started without outcome")} " +
                $"unconfirmed={outcomes.Count(o => Verdict(o) == "unconfirmed")} " +
                $"notSent={outcomes.Count(o => o.Status == "NOT_SENT")}");
        int result = outcomes.All(outcome => outcome.Passed) ? 0 : 1;
        Event($"RESULT code={result}; child index attributes bytes to the last submitted command, not a proven output producer");
        return result;
    }

    private static string Verdict((string Status, bool Started, bool Passed) outcome) =>
        outcome.Status == "NOT_SENT" ? "not sent" : outcome.Passed ? "delivered" :
        outcome.Started ? "started without outcome" : "unconfirmed";

    private static void PrintTrace(int child, string path)
    {
        try
        {
            foreach (string line in File.ReadLines(path))
                Console.WriteLine($"TRACE child={child} {line}");
            File.Delete(path);
        }
        catch (FileNotFoundException)
        {
            Console.WriteLine($"TRACE child={child} absent");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Console.WriteLine($"TRACE child={child} unavailable: {error.Message}");
        }
    }
}
