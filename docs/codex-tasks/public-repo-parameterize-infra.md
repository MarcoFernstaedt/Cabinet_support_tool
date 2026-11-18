# Parameterize the real infrastructure values before this repo goes public

The repository is about to be made public. Four places carry the operator's real network identity in
committed files. They are not credentials, but they are permanent once published.

| value | file | line |
|---|---|---|
| `<public-ip>` (the VPS public IP) | `scripts/acceptance/run-off-network-vps.sh` | 27 — `export SHELL_PLATFORM_HOST=${SHELL_PLATFORM_HOST:-<public-ip>}` |
| `<public-ip>` | `server/test/config-agent-setup.test.ts` | 20-21 — a unit test asserting on a real public IP |
| `<tailnet-host>.ts.net` (the tailnet host) | `scripts/acceptance/platform-tls-preflight.ps1` | 2 — `$name = '<tailnet-host>.ts.net'` |

`deploy/examples/tailnet/env.example` already does it right: it uses `<public-ip>` and
`<tailnet-host>` placeholders.

## What to do

1. **`run-off-network-vps.sh`**: remove the hardcoded default and fail fast with a clear message when
   `SHELL_PLATFORM_HOST` is unset, exactly as the script already does for `SHELL_SSH_USER` and
   `SHELL_SSH_IDENTITY` in its preflight block. Keep the parameter; drop the leak. Do not print any
   host value it was not given.
2. **`server/test/config-agent-setup.test.ts`**: use a documented non-routable test address
   (`203.0.113.x`, the TEST-NET-3 range reserved for documentation) instead of a real public IP. The
   test's point is that the value is passed through, not which address it is.
3. **`platform-tls-preflight.ps1`**: take the host as a required parameter with no default, or use a
   placeholder. Check how the file is invoked from `run-off-network-vps.sh` and keep the call working.
4. **Sweep the rest**: `git grep` for the real public IP, tailnet suffix, and VPS hostname across
   every tracked file and replace any remaining real value with a placeholder or a required parameter.
   Documentation may keep a clearly-labelled example placeholder. Two doc files also carry the IP -
   handle them the same way, keeping the surrounding meaning intact.
5. **Do not touch** `deploy/examples/tailnet/env.example` - it is already correct and is the pattern to
   copy.

## Constraints

- No behaviour change: the acceptance still runs when the environment supplies the values.
- Do not weaken any check, and do not add a new default in place of the old one.
- Keep the free-identifier check and the no-machine pass green on any script you touch.
- Sandbox cannot run Docker or SSH; compile and validate, do not claim a live run.
- Do not commit; leave changes in the working tree. Dev branch only.
