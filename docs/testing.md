# Windows demo checks

Run this checklist on an authorized disposable Windows 10 machine and a Windows 11 machine. Record the exact edition, OS build, architecture and application commit for each run. Passing on one does not establish support for the other.

Use synthetic users, cabinets, processes and event records. Keep production customer credentials and data out of the lab. The first acceptance milestone is process and event diagnostics. It does not approve process termination, service changes, updates, network changes or display changes on customer machines.

## Before testing

- Keep a VM snapshot and a recovery console independent of the support connection.
- Use the same reviewed build for the server, console and agent.
- Verify the configured API address and certificate on each machine. Never disable certificate validation to make the demonstration work.
- Keep the server reachable only from the intended lab machines. Do not expose the development server to the internet.
- Confirm diagnostic mode is active on the server and agent when that feature is included in the build. Do not assume a hidden button prevents an API request.
- Verify the agent's state and log directories are writable only by its intended service identity and administrators.

## Sign in and cabinet selection

- Sign in with a new test user who must change their password. Complete the password change and sign in again. The console must not claim an authenticated session while holding revoked credentials.
- Enter an incorrect password and verify that no cabinet data appears.
- Find a cabinet through search and open it with the mouse. Repeat with the keyboard.
- Confirm that client, location, cabinet name and identifier refer to the same machine throughout the view.
- Open another cabinet, then test a failed load. The previous cabinet must not remain an actionable target.
- Sign out. Cabinet details and diagnostic results must not remain visible behind the sign in window.

## Process diagnostics

- Start an inert application such as a lab copy of Notepad. Do not use a dispensing application as a test target.
- Request the process list from the selected cabinet and supply the required reason and ticket reference.
- Refresh action status until a terminal result arrives. Pending means pending, not success.
- Confirm the visible process identifier and name against local Task Manager. Compare memory and CPU with allowance for sampling time and measurement definitions.
- Confirm the result shows its request identity and collection or completion time. Unknown counters must not appear as zero measurements.
- Select a process and refresh status without collecting a new snapshot. Selection should remain when the underlying snapshot is unchanged.
- Collect another snapshot after opening or closing the inert application. Verify that the new list represents the selected cabinet and not a cached list from another cabinet.
- Cause a later collection failure. If the previous successful snapshot remains visible, it must be labeled as an older result rather than current data.

## Event diagnostics

- Prepare known synthetic event records and an approved named event view that includes them.
- Select the view and request collection. Check the log, source, event identifier, severity, message and timestamp against local Event Viewer.
- Verify the requested time window and record limit. A truncated result must say it is truncated.
- Test an empty window. An empty successful result is different from unreadable data or denied access.
- Test an inaccessible log using a limited test identity. The failure must be visible and must not be presented as an empty healthy log.
- Request results from two cabinets in succession and verify that the selected cabinet determines the displayed result.

## Failure and recovery

- Interrupt the console connection after submitting a diagnostic request. Reconnect and inspect its recorded status.
- Interrupt the agent connection around result reporting. Record whether the result recovers or remains unavailable. A cached result is not proof of acknowledged delivery.
- Verify that an unreadable result produces a controlled message identifying the request, not an application crash.
- Attempt a prohibited mutating API request in diagnostic mode with a synthetic test target. Both server and agent must refuse it without an effect.
- Restart the agent while a synthetic request is in progress. Inspect the recorded outcome. Unknown must not be silently converted to success or automatically rerun.

## UI checks

- Complete the main workflow using only the keyboard, including dialog cancellation and focus return.
- Check Narrator or the team's chosen screen reader for cabinet identity, changing values, action status and error announcements.
- Repeat in Windows high contrast mode and at the display scaling used by support staff.
- Check that long event messages and action output remain readable without hiding the selected cabinet identity.

## Record the result

For each check record PASS, FAIL or BLOCKED, the build commit, Windows edition and build, the observed behavior and a sanitized screenshot or log when useful. Do not label a result PASS because a similar test passed on Linux.

Any wrong cabinet identity, unexpected native mutation, credential exposure, missed rollback or misleading success report stops the walkthrough. Preserve the evidence and return to the snapshot before continuing.
