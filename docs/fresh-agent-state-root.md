# Fresh Agent state root (preparation only)

`tools/Prepare-FreshAgentStateRoot.ps1 -Id <new lowercase canonical GUID>` is an elevated Windows-only, single-use preparation helper. It creates `C:\Program Files\CabinetAgent-Fresh-<GUID>` with one `CreateDirectoryW` call and an explicit protected DACL granting SYSTEM and BUILTIN\Administrators full control; owner/group are SYSTEM. It refuses all existing objects (including junctions/files), never adopts or repairs prior state, and returns only an empty directory path. Generate a fresh GUID for each invocation. The caller must separately establish trusted identity provenance before placing **any** state or secret there. This helper is not an enrollment or issuance authority and must not be pointed at predecessor backups.

Preflight checks the fixed `C:\` and `C:\Program Files` ancestors are real directories, non-reparse, TrustedInstaller-owned with protected DACLs, no nonprivileged delete-child/ACL-owner write on `C:\`, and no nonprivileged add-child/delete-child/ACL-owner write on Program Files. Inherit-only ACEs are not effective on the inspected ancestor; the new protected DACL does not inherit them. After atomic exclusive creation the helper checks ancestors again and reads back root ACL, reparse status and emptiness. A failed post-create readback intentionally leaves the directory for operator inspection, rather than risking recursive cleanup. Run only on a machine where administrators/SYSTEM and the service-account boundary are trusted; this does not defend against a competing privileged administrator, malicious kernel, or a compromised installer. Directory path checks are not handle-pinned against a privileged concurrent rename. Do not proceed with later key staging or service installation on an ambiguous result.

Synthetic native fixture: `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools\Test-FreshAgentStateRoot.Native.ps1` on an approved Windows host with the helper beside it. It performs create/readback, repeated collisions, file collision, repeated junction refusal, and exact-empty-root nonrecursive cleanup. It does not contact Server, create a key, touch the Agent service, or prepare a real named successor. Never recursively delete a fixture root on failure. A new identity, credential issuance/activation, install, Server compatibility, staff authorization and browser readback each require separate approval and verification. Original cabinet identity, history and backups remain untouched.

## Native HP synthetic receipt (2026-10-03 UTC)

**Scope/identity.** The SSH target `hp-edge` reported Windows host `DEVICEB`, execution identity `deviceb\ferns` (SID `S-1-5-21-3655720454-3862764433-16618809-1001`), with `WindowsPrincipal.IsInRole(Administrator)=True` in the SSH PowerShell preflight. The fixture was launched through the same SSH account using `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`; this is an elevated administrator token readback, not proof of SYSTEM/service-account execution. No production successor path, original Agent root, credentials, service, Server, or backup was selected by the commands.

**Artifact provenance.** From branch `feature/successor-fresh-root-native` at `7f6b6495fa2e37dff71061b2de58772dcb205e23`, the two exact repository files were copied by `scp` side by side into a GUID-named temporary *user-profile* staging directory. Local `sha256sum` and host `Get-FileHash -Algorithm SHA256` agreed:

| Script | SHA-256 (local and HP) |
| --- | --- |
| `tools/Prepare-FreshAgentStateRoot.ps1` | `8a71d2129d9594d304429bec0be3902d8b76d530c170dd3754a5c3b211040ede` |
| `tools/Test-FreshAgentStateRoot.Native.ps1` | `bdc4852d142eb2adff0b7cab9450cee0243a8e8c2228b47bdcbedc552d209fcd` |

**Reproduction/readback.** On an approved, separately verified elevated Windows session, stage those two files together in a fresh temporary user directory; verify both hashes with `Get-FileHash`; inventory only direct children of `C:\Program Files` whose names start *ordinally* with `CabinetAgent-Fresh-` (`Get-ChildItem -LiteralPath 'C:\Program Files' -Force | Where-Object { $_.Name.StartsWith('CabinetAgent-Fresh-', [StringComparison]::Ordinal) } | ForEach-Object { "$($_.Name) $($_.Attributes)" }`). Require no existing matching objects; do not remove any unexpected object. Run `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <staging>\Test-FreshAgentStateRoot.Native.ps1` and capture `$LASTEXITCODE` separately from stdout. Repeat the *same* prefix inventory afterward. Do not run this on a host without explicit approval, or replace the helper with another revision. The recorded pre-inventory and post-inventory were each empty (zero matching direct children, including files and reparse points); the staging directory and its exact files were subsequently deleted nonrecursively, with `staging_removed=True` readback. No recursive removal was used.

Full fixture stdout (line endings normalized from CRLF to LF; no truncation), process exit **0**:

```text
case=f03b28c1-c72b-4c64-855c-ade596163304 expectedSuccess=True exit=0
case=f03b28c1-c72b-4c64-855c-ade596163304 expectedSuccess=False exit=1
case=f03b28c1-c72b-4c64-855c-ade596163304 expectedSuccess=False exit=1
readback=O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA) empty=True
case=c0830da1-02fc-4884-925b-0ea765cdee50 expectedSuccess=False exit=1
case=03ead045-073e-4ae9-a7b6-0f0b7d50e83b expectedSuccess=False exit=1
case=03ead045-073e-4ae9-a7b6-0f0b7d50e83b expectedSuccess=False exit=1
native-fixture=PASS
```

The first GUID is an exclusive new directory followed by two refusals and protected owner/group/DACL plus empty-root readback; the second is a file collision; the third is a junction to `C:\Windows` followed by two refusals. The fixture's `finally` blocks removed only the exact empty directory, exact file, and junction link (not its target). **False-positive refusal check:** the unchanged fixture was copied to a separate temporary directory beside a substitute helper that returned an apparent success path on its first call but emitted an unrelated `synthetic unrelated failure` with exit 1 on the second. Fixture output began `case=... expectedSuccess=True exit=0`, then `wrong collision refusal: ... synthetic unrelated failure`; process exit **1**, not `native-fixture=PASS`. This checks the refusal oracle rejects a generic failure rather than accepting any nonzero exit. The substitute did not create a root and was not used for the passing native run.

**Limits.** This is synthetic native evidence for exclusive creation/collision handling and observed ACL/empty readback on one administrator session. It does not prove service identity, real successor identity provenance, enrollment, issuance, deployment, Server/browser behavior, cross-host ACL policy, or resistance to a privileged concurrent actor. Parent/root path checks are not handle-pinned; a privileged rename/substitution between check and use (TOCTOU), ACL changes, hardlink-like provenance questions, and a compromised administrator/installer remain outside this fixture. No claim of a live Agent-state inspection is made; safety rests on the GUID-only prefix and script scope, and no command targeted the real Agent path. Review those boundaries independently before any live migration.
