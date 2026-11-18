# "The command line is too long": do not nest -EncodedCommand

The acceptance now gets past the reachability preflight and its cleanup passes, then dies on its first
PowerShell call after the preflight, at `session-shell-cabinet.mjs:354`:

```
Acceptance failed: Error: ssh failed (1): Command failed: ssh ... deviceb powershell.exe
-NoProfile -NonInteractive -EncodedCommand JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4AUAByAGUAZgBlAHIAZQBuAGMAZQA9ACcAUwB0AG8AcAAnADsAJABhAGMAdABpAG8AbgA9AE4AZQB3AC0AUwBjAGgAZQBkAHUAbAB...
The command line is too long.
The command line is too long.
```

## The cause

Decoding the base64 shows the shape: the outer command is `powershell.exe ... -EncodedCommand
<base64>` whose decoded body **itself contains another `-EncodedCommand <base64>`**, and that inner one
carries a third layer. Each nesting level base64-encodes the entire previous layer, so the length grows
by roughly a third per level, and Windows refuses the process creation once the command line exceeds
its limit. The `ssh` layer adds its own quoting on top. This is a harness defect and it has nothing to
do with the SSH transport, which was never reached.

## What to do

1. **Stop nesting encoded commands.** For the fallback scheduled task, write the script to a file on
   the cabinet and have the task action run `powershell.exe -NoProfile -NonInteractive -File <path>`.
   The harness already ships files to the cabinet, so use that same path: one file, one reference, no
   encoding layers at all.
2. **If a generated script is unavoidable, generate the file, never the command line.** A script that
   must embed another script writes that other script out and passes its path.
3. **Print the stage name before each remote step.** The log currently shows a failing command with no
   label, so a reader cannot tell whether the transport, the down-cycle or the fallback registration
   failed. One line per stage: `stage: <name>`. A run that aborts early must not look like a run that
   fails late.
4. Then re-run the acceptance so it can actually reach the transport. The evidence to produce is a
   completed SSH transport with its `remote_sessions` row and its open and close audit events.

## Context that is already working - do not regress it

- The reachability preflight passes (`Platform reachability preflight passed from cabinet deviceb to
  <public-ip>:8443`).
- The cleanup passes and is idempotent (`Acceptance cleanup passed.`), and it reports after the primary
  outcome rather than replacing it.

## Not in this task

- Do not change the transport itself, the platform networking, or the release agent.
- Re-run the static free-identifier check and the no-machine pass on any script you touch.
- Sandbox cannot execute tests (`SocketException (13)`); compile and validate, do not claim live
  verification. Do not commit; leave changes in the working tree. Dev branch only.
