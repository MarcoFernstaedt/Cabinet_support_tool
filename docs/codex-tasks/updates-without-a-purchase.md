# Make the agent update channel work without buying a certificate

**Branch:** `feat/release-signing-and-root-install` (off `main`; do not work on `main`).
**Owner's decision:** do not purchase a public-CA code-signing certificate. The internal publisher CA is the production
publisher. The spec already allows this: the certificate may be "from a public CA, **or an internal CA whose root is
installed on cabinets**" (`docs/spec/09-open-decisions.md:17`).

## What the owner is asking for

One push reaches every agent: cut a real release here, and have a cabinet accept and install it. Today a release cannot be
cut at all, and an agent refuses every release at the Authenticode check.

## Read these before writing anything

- `docs/spec/07-upgrade-channel.md` — "Signing flow" (steps 1–7), "Package format", "A build that ships to cabinets",
  "What the repository pins". This is the design of record.
- `agent/install/New-AgentRelease.ps1` — the release packer as designed: it **requires** every program to be
  Authenticode-signed (`Get-AuthenticodeSignature` must be `Valid`, else it throws: *"Authenticode signatures cannot be
  checked on this host … Package releases on Windows"*), then writes `agent-<version>.zip`, `manifest.json` and
  `signature.json`. Mirror its output byte-for-byte; do not invent a new format.
- `agent/install/New-PublisherRoot.ps1` — made the publisher root and one issuing certificate, and pinned both.
- `server/src/services/releases.ts` — server side: `checkManifest` verifies the detached signature against the release
  keys it holds, then the zip's hash against the manifest; `ReleaseStore`, `packagePath`.
- `agent/src/Cabinet.Agent.Core/Upgrades/{UpgradeTrust,UpgradeBroker,ReleaseVerifier,SelfCheck,Authenticode}.cs` — what the
  agent checks, in order: manifest signature against the public key compiled into the agent, the zip's hash, the version,
  then the Authenticode signature on the binaries.
- `contracts/trust/upgrade/upgrade-keys.json` — pins publisher `CN=Mashura Code Signing, O=Mashura LLC`, root SHA-256
  `3049e830ab210ae07a12f5fc287b0e503532e2245de6daf5546fb53916bffc3b`, and the release key `keyId`
  `631c0270c5a8e67441f9019c8c9a9284d5b665d3ffdc5571103401ad3d070f70`.

## The signing material, already on hand — staged for this run

It is **outside the workspace** in its durable home, so a copy is staged inside the repo for this run, under a path
`.gitignore` covers (`.staging/`). Read it there; never add anything under `.staging/` to a commit.

- `.staging/signing/publisher-root.cert.pem` — SHA-256 is **exactly** the pinned root above (verified by hand).
- `.staging/signing/publisher-root.key.pem`, `publisher-issuing.cert.pem`, `publisher-issuing.key.pem` — the issuing cert
  is `CN=Mashura Code Signing, O=Mashura LLC`, issued by the pinned root, valid to 2029-11-07.
- `.staging/signing/release-key.pem` and `release-key.pub.pem` — the operator release key; the public half's SPKI SHA-256
  is **exactly** the pinned `keyId` (verified by hand).
- `.staging/tools/usr/bin/osslsigncode` — `osslsigncode` 2.9, extracted from its `.deb`, proven to run from inside the
  repo. Its durable home is outside the repo; the shipped script must take the tool's path as a parameter (or find it on
  `PATH`) and must not hard-code `.staging/`.

The durable home of the keys is the owner's trust folder outside the repository, and the shipped script's parameter
defaults must point there — not at `.staging/`. A private key must never enter a commit, a log line, a test fixture, an
env file, or a message. Every script takes a **path**; nothing reads a key from a tracked path.

## The job

1. **Sign the binaries.** Every PE the updater puts in place (`.exe`, and every `.dll` Windows could load as code) in the
   publish output of both architectures must carry a valid Authenticode signature from the issuing certificate, chaining to
   the pinned root. On this Linux host use `osslsigncode` — the analogue of Windows' `signtool`; it is installable without
   root (`apt-get download osslsigncode` then extract the `.deb` under `~/.local`, and record that in the script so a fresh
   box reproduces it). Sign, then **verify each file and fail loudly on any unsigned or invalid one**. Use no timestamp
   authority: cabinets may be offline and the root is installed locally.
2. **Cut the release here.** Add a Linux-runnable packer that reproduces `New-AgentRelease.ps1`'s output exactly: the zip's
   contents and forward-slash names, `manifest.json` as compact JSON with the same fields in the same order
   (`product`, `version`, `minimumVersion`, `sha256`, `sizeBytes`, `releaseTime`, and `notes` only when given), and
   `signature.json` as `{ "keyId", "algorithm": "ecdsa-p256-sha256", "signature" }` where the signature is the DER-encoded
   ECDSA P-256 signature over the **exact manifest bytes** (`openssl dgst -sha256 -sign` produces that encoding). Compute
   `keyId` as SHA-256 of the public key's SPKI, lower-case hex. Resolve the architecture the way `releases.ts` does: the
   architecture is declared beside the manifest, never inside it.
3. **Install the root on the cabinet.** Add an idempotent step to `agent/install/Install-CabinetAgent.ps1` and to the
   generated fleet script `server/src/console-api/fleet-install-script.ts` that (a) computes the certificate's SHA-256,
   (b) refuses anything that is not the pinned `3049e830…`, and (c) only then imports it into
   `Cert:\LocalMachine\Root` and `Cert:\LocalMachine\TrustedPublisher`. No `certutil` fetch, no internet, and a rerun must
   change nothing. This is the step that makes an internal CA legitimate.
4. **Prove it, in this order:**
   - a cabinet release build of the current tree passes the trust check: build the agent with
     `-p:CabinetReleaseChannel=production` so `CheckCabinetReleaseTrust` (`Cabinet.Agent.Core.csproj`) runs;
   - the produced release is accepted by the server: `checkManifest` in `server/src/services/releases.ts` verifies the
     detached signature and the zip hash against the real pinned keys;
   - Authenticode is really being checked, both ways: a signed binary passes and a byte-tampered copy is refused, through
     the agent's own verification path (`agent/tests/Cabinet.Agent.Core.Tests/UpgradeTests.cs`, extended; do not weaken an
     existing assertion);
   - one observed upgrade end to end: the release in a local server's store, a rollout started, and the agent taking the
     update and reporting the new version.

## Rules that are not negotiable

- Do not weaken, skip or delete any existing check (`SelfCheck`, `ReleaseVerifier`, `UpgradeBroker`, `Authenticode`,
  `checkManifest`, `UpgradeTrust.Load`). Do not add an "allow unsigned" escape hatch to any production path.
- Do not change the pinned publisher, its root file or the release key. They are correct. If you believe a pin must change,
  stop and report instead.
- The agent stays `net10.0-windows` and keeps publishing both `win-x64` and `win-x86` (32-bit retention).
- Copy the suite's own command from the repository; the server suite is `node --test --test-concurrency=2` and needs
  `TEST_DATABASE_ADMIN_URL` exported. Never hand-roll a test invocation.
- Red/green only: a run is evidence only if it fails loudly when the signature is absent. Never report a test you did not
  run, and never hide a non-zero exit.
- What this sandbox cannot do — reaching SQL Server (`EPERM` on `127.0.0.1:11433`), Windows-only agent paths, installing a
  real cabinet — do not fake. Implement up to the limit and list the exact commands the reviewer must run, with what each
  should print.
- Commit nothing until the change is complete on the branch; then commit as `Marco Fernstaedt
  <fernstaedtmarco@gmail.com>`, with no generator trailer, no session URL, no "generated by" footer, no emoji.

## Not in this task

Buying a certificate. The cross-module write paydown. Remote access (its own branch and brief).
