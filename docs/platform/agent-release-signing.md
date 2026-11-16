# Internal publisher release signing

No purchased certificate is used. Keep the existing publisher root and release key pins. The Linux packer takes paths;
its defaults point outside the checkout — the signing folder from `CABINET_SIGNING_DIR`, else `~/.cabinet-signing`, and the
release key from `CABINET_RELEASE_KEY`, else `~/.cabinet-release/release-key.pem`. Never copy private material into source control.
The staged signing material for this run is ignored under `.staging/signing`; generated releases also stay under `.staging`.

## Build and package

From the repository root, with .NET 10, PowerShell 7, Python 3, OpenSSL and osslsigncode 2.9 installed:

```powershell
foreach ($arch in 'win-x64', 'win-x86') {
    ./agent/install/Publish-CabinetAgent.ps1 -Output ".staging/publish/$arch" -Architecture $arch -Version 0.1.1 -CabinetReleaseChannel production
}
```

Every publish must succeed, including `CheckCabinetReleaseTrust`. The agent Windows programs remain `net10.0-windows`.
On this sandbox the default parallel MSBuild invocation exited 1 without diagnostics. The successful build used these
commands for each architecture and each of Broker, Network, Harness and Updater:

```bash
export DOTNET_CLI_HOME="$PWD/.staging/dotnet-home"
export NUGET_PACKAGES=/home/marco/.nuget/packages
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export TMPDIR="$PWD/.staging/tmp"
# This run only: the vulnerability feed is unreachable. Locked restore is still required.
export NuGetAudit=false
for arch in win-x64 win-x86; do
  for project in Cabinet.Agent.Broker Cabinet.Agent.Network Cabinet.Agent.Harness Cabinet.Agent.Updater; do
    dotnet restore "agent/src/$project/$project.csproj" --locked-mode -m:1 -nr:false || exit
    dotnet publish "agent/src/$project/$project.csproj" --no-restore -c Release -r "$arch" \
      --self-contained true -p:PublishSingleFile=true -p:Version=0.1.1 -p:CabinetReleaseChannel=production \
      -m:1 -nr:false -p:UseSharedCompilation=false -o ".staging/publish/$arch/$project" || exit
  done
done
```

For a fresh Debian signing host, install osslsigncode without root:

```bash
apt-get download osslsigncode
dpkg-deb -x osslsigncode_*.deb ~/.local
```

Then sign and package each architecture, with no timestamp server:

```bash
for arch in win-x64 win-x86; do
  python3 agent/install/new-agent-release.py \
    --publish-dir ".staging/publish/$arch" --architecture "$arch" \
    --version 0.1.1 --minimum-version 0.1.0 --out-dir ".staging/releases/$arch" \
    --osslsigncode "$HOME/.local/usr/bin/osslsigncode" || exit
done
```

For this run only, supply `--signing-dir .staging/signing --release-key .staging/signing/release-key.pem` and
`--osslsigncode .staging/tools/usr/bin/osslsigncode`. No root private key is needed. Each command must print four signed
and verified binaries for the current single-file publish layout. A publish with additional DLLs must sign those too.
A failed signature check exits nonzero before publishing any release files.

`agent-0.1.1.zip`, `manifest.json` and `signature.json` are the existing wire format. The brief's `releaseTime` spelling
conflicts with both existing packer and contract; the compatible field is `releasedAt`. JSON is compact UTF-8 without BOM
or trailing newline. The manifest's exact bytes are signed with ECDSA P-256/SHA-256, DER signature encoding. Architecture
is declared on upload as `windows-x64` or `windows-x86`, never added to the manifest.

## Verify on Linux

```bash
(cd server && npm run build)
node server/scripts/check-agent-release.mjs .staging/releases/win-x64 windows-x64
node server/scripts/check-agent-release.mjs .staging/releases/win-x86 windows-x86
export SIGNED_AGENT_BINARY="$PWD/.staging/publish/win-x64/Cabinet.Agent.Broker/Cabinet.Agent.Broker.exe"
export OSSLSIGNCODE="$PWD/.staging/tools/usr/bin/osslsigncode"
dotnet test agent/tests/Cabinet.Agent.Core.Tests
# Supply TEST_DATABASE_ADMIN_URL through the operator's environment before running this suite.
(cd server && npm test)
```

The read-only server commands must print `Accepted 0.1.1 windows-x64` / `windows-x86`, with pinned signature, package
hash/size and architecture verified, and changed/absent manifest signatures refused. They do not insert database rows.
The extended core test uses real osslsigncode digest verification and the agent's `AgentSignatures.Problem`,
`SignedData.Verify` and compiled `UpgradeTrust`; a changed DOS-stub byte and an unsigned file must be refused.
Set both environment variables or that opt-in test is explicitly skipped. The suite command remains the repository's
own `dotnet test`; do not substitute a synthetic test runner.

The server suite uses its package command, `node --test --test-concurrency=2 dist/test/*.test.js`. New cases execute both
shipped root-install blocks against in-memory certificate stores: an incorrect hash must fail before opening a store;
two valid runs must add exactly one certificate to each machine store. These are store-boundary tests, not evidence of
Windows importing a certificate.

## Windows and observed rollout: reviewer must finish these gates

Use an isolated Windows cabinet already enrolled at version 0.1.0, with the production pins compiled in, and a local
server with its normal database, TLS and admin authentication configured. Do not use development trust overrides or
unsigned-upgrade settings. Copy the signed publish folders and release folders to the corresponding `.staging` paths. Keep the signed 0.1.0
baseline publish under `.staging/publish-baseline/win-x64`; produce it with the same build/sign commands above, using
version `0.1.0`, minimum version `0.0.0`, and separate baseline output folders.
On the cabinet, in elevated PowerShell, run:

```powershell
./agent/install/Install-CabinetAgent.ps1 -SourceDir .staging/publish-baseline/win-x64
$env:SIGNED_AGENT_BINARY = (Resolve-Path .staging/publish/win-x64/Cabinet.Agent.Broker/Cabinet.Agent.Broker.exe).Path
dotnet test agent/tests/Cabinet.Agent.Windows.Tests
```

The installer imports only the embedded root whose DER SHA-256 equals the pin, before checking program signatures.
The production signature test must pass with Windows' real `WinVerifyTrust`, and refuse a byte-tampered copy and an
unsigned file. Do not infer this result from Linux's verification. On 32-bit Windows use the x86 publish instead.
The ordinary installer reinstalls the supplied version; use a signed **0.1.0** publish for the starting cabinet if you
need to establish it before the rollout. Do not install 0.1.1 there before observing its upgrade from 0.1.0.

On the server, with `DATABASE_URL` and its normal TLS configuration supplied by the operator, run in separate terminals:

```bash
node server/dist/src/main.js
```

```bash
node server/dist/src/cli.js release add \
  --manifest .staging/releases/win-x64/manifest.json \
  --signature .staging/releases/win-x64/signature.json \
  --package .staging/releases/win-x64/agent-0.1.1.zip --architecture windows-x64 \
  --as "$ADMIN" --code "$TOTP_CODE"
node server/dist/src/cli.js rollout start 0.1.1 --architecture windows-x64 \
  --pilot "$CABINET_ID" --as "$ADMIN" --code "$TOTP_CODE"
node server/dist/src/cli.js rollout show "$ROLLOUT_ID"
node server/dist/src/cli.js cabinets
```

Supply a fresh authenticator code for each privileged command. Release upload must print `0.1.1  windows-x64  ready`.
Record the rollout ID printed by `rollout start`. After the cabinet's next check-in, `rollout show` must report target
`succeeded` and rollout `completed`, and `cabinets` must show that cabinet online with agent `0.1.1`. Keep the broker,
network and updater logs as evidence. Repeat with `windows-x86` and an x86 cabinet. A store copy alone is not an upgrade.

## Evidence from this sandbox run

Both production architectures built successfully (the pre-existing inline trust task emits CS0162). Both releases were
signed and packaged at `.staging/releases/win-x64` and `.staging/releases/win-x86`, and the real server verifier accepted
the manifest signature, ZIP hash/size and architecture for each. Direct osslsigncode verification returned 0 for the
signed Broker executable and 1 for the byte-tampered copy (`MISMATCH`) and the same PE with its signature removed.

VSTest compiled the extended core tests but aborted before executing any: `SocketException (13): Permission denied`
while creating its communication listener. Even creating a TCP socket for SQL Server at `127.0.0.1:11433` is refused
with `EPERM`. Windows certificate stores, Windows `WinVerifyTrust`, a database-backed upload/rollout and a real cabinet
upgrade have not been observed here. The commands above are required evidence, not claimed successes.

The new root-import regression was checked through the repository's exact server suite command: disabling only the new
SHA-256 guard made `publisher-root-install.test.js` fail; restoring the installer byte-for-byte (`cmp`) made that file
pass again. Its cases cover both installer blocks, rejection before store access, and idempotent imports. This does not
claim that Windows certificate stores were exercised. The full suite is not green in this sandbox.

The final restored server run reported 185 file entries: 80 passed, 105 failed, 0 skipped (exit 1). The guard-disabled run
reported 79 passed and 106 failed, with the root-install file failing; the restored run reports that file passing. The
runner reports file-level results here, not individual assertion counts. Logs are `.staging/server-tests-red.log` and
`.staging/server-tests-green.log`. The final Windows test project build succeeded with 0 warnings and 0 errors; it was
not executed on Windows. The core suite's final invocation again aborted at VSTest's denied socket before running tests.
