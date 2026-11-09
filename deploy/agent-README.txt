Mashura Cabinet Agent for Windows 10 and 11 (32-bit and 64-bit)

Install (the normal way):
  1. In the console, open Setup and download the agent (both files if your cabinets are mixed: the installer picks
     the right one for each computer).
  2. Press "Create installer". You get Install-CabinetAgent.cmd for one cabinet: it works once, for 7 days.
  3. On the cabinet, put the installer in the same folder as the agent files (Downloads or a USB stick) and
     double-click it. Approve the Windows prompt. If SmartScreen appears, choose More info, then Run anyway.
  4. Approve the cabinet in the console under Pending cabinets.

The installer uses the Windows PowerShell 5.1 every Windows 10 and 11 machine has. It checks the agent files against
the console before anything is installed, works in a private folder only administrators can change, and deletes
itself after a successful install.

If the install stops:
  The window says what happened and what to do. Send those lines to support, with the newest file in
  C:\ProgramData\Mashura\CabinetAgent\logs. The installer keeps its token, so you can run it again. A cabinet that
  was already enrolled keeps its identity, so repairing it is another install.

The cabinet must be able to reach the server's agent address on port 8443 (it only connects out).

Install on many cabinets at once:
  For a site, tick "Make a fleet install script (PowerShell)" when creating the installer, and run the script as SYSTEM
  from your remote management tool. See docs/platform/fleet-install.md.

Check an installed cabinet (read only; as SYSTEM from a remote management tool, or an administrator PowerShell):
  & "C:\Program Files\Mashura\Test-CabinetAgent.ps1"
  It prints PASS, WARN or FAIL for each check (services, permissions, signatures, configuration, the path to the
  server, the agent's log), writes the results to C:\ProgramData\Mashura\CabinetAgent-Acceptance\, and exits with 0
  when nothing failed. Then, in the console, open the cabinet and run "Test <cabinet>" on its Overview.

Remove (from an administrator Windows PowerShell):
  & "C:\Program Files\Mashura\Uninstall-CabinetAgent.ps1" -RemoveData

This build may be an unsigned development build. Production builds are code-signed.
