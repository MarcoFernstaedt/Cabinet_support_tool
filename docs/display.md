# Display recovery requirement

Support sometimes needs to rotate a damaged screen so application controls remain visible. The requested operation is a Windows display setting change. It is separate from physical cabinet control and from remote desktop input.

Implementation status: required, not implemented or lab verified by this document.

## Proposed operator flow

1. Collect the active display paths and supported modes. Show a stable display identity, current orientation and resolution. Do not infer the target from screen order alone.
2. Select a supported orientation and confirm the cabinet and display. Include a reason and ticket reference under the configured approval policy.
3. Persist the complete prior mode before changing it. Validate the proposed mode before applying it.
4. Apply the mode in the correct interactive Windows session through a narrowly scoped, authenticated mechanism. A service in session zero must not assume it can change the user's desktop correctly.
5. Read back the effective mode. Require operator confirmation within a bounded interval. Restore the prior mode if confirmation is missing, the helper fails or the service restarts.
6. Record the request, approval, observed result and any restoration. A disconnected console must not be interpreted as confirmation.

The initial case calls for a 180 degree rotation. Additional orientations can be offered only when the display reports support. Avoid unrelated changes to refresh rate, color depth or display placement.

## Lab cases

Test one display and multiple displays, unsupported orientation, a display disconnected during confirmation, console loss, service restart, session lock, user switch and mismatched DPI. Verify restoration by querying Windows and checking the visible desktop.

Touch input mapping is not assumed to follow display orientation. If the cabinets use touchscreens, confirm the device requirements before offering this as a complete workaround. Do not add arbitrary command execution to handle driver differences.
