# Remote Upgrade Channel

## Why it needs special care

Upgrading the agent means running new code on every cabinet. If the server alone could push an upgrade, a compromised server could push malware to 8,000 machines. So the agent only installs packages signed by a key the server never holds. The server delivers upgrades; it cannot create one the agent will accept.

## Signing key

- Decided (D143): an offline key the operator holds on a machine that never touches production, used only where releases are cut, with signing done per release (`agent/install/new-agent-release.py`, docs/platform/agent-release-signing.md). No cloud KMS and nothing bought.
- `New-AgentRelease.ps1` can also sign through AWS KMS or Azure Key Vault, if that is ever chosen instead.
- Never: on the server, in the repository, or in a production environment variable.
- The release key and the offline roots are backed up and kept off any networked machine.

## Package format

- A zip of the new agent binaries, which are themselves Authenticode-signed
- A manifest: version, SHA-256 hash of the zip, minimum version it can upgrade from, release time
- A detached signature over the manifest

## Signing flow

1. The build pipeline builds the new version and produces the package and manifest.
2. The manifest's hash is signed with the release key on the offline machine. The key never leaves it.
3. The package, manifest and signature are uploaded to the server's update store.
4. An admin starts a staged rollout in the console, with step-up. This is audited separately.
5. The server tells the agents in the current batch that the version is available.
6. Each agent downloads the files and verifies, in order: the manifest signature against the public key compiled into the agent, the zip's hash against the manifest, that the version is newer than its own, and the Authenticode signature on the binaries.
7. Only if every check passes does it install. It reports success or the exact failed check.

## A build that ships to cabinets

An agent built for cabinets has to be able to check every release it is offered. So a build for the cabinet release channel
(`-p:CabinetReleaseChannel=production`) fails, with an error rather than a warning, in either of two cases:
- **No code-signing publisher the agent can load is pinned** in `contracts/trust/upgrade/upgrade-keys.json` (error CAB0002). That
  is any of the following:
  - the list is empty, and such an agent would refuse every upgrade at the publisher check (the repository's list is not
    empty; see "What the repository pins" below);
  - a publisher has no common name or no organization;
  - a publisher names no root file, or its root file is not beside the list;
  - the root file is not a PEM certificate;
  - its SHA-256 (of the certificate, in lower-case hex) is not the entry's `root`.

  These are the checks the agent makes when it loads the compiled trust at start: `UpgradeTrust.Load` validates the list
  against its whole contract, reads each publisher root file, and the constructor pins the certificate hash. An entry that
  fails one stops the broker on every cabinet, so the build refuses it rather than ship it.

  **What this check does not prove:** that the list is valid against its whole contract
  (`contracts/schemas/agent/upgrade-keys.schema.json`). The common name and organization above are the one rule from that
  contract the build enforces; rules such as no extra properties and at most two publishers it does not.
  `UpgradeTrust.Load` checks the whole contract first, and a list that fails it stops the broker too. The contracts suite
  validates the repository file against that schema, and the release packer (`agent/install/new-agent-release.py`) runs the same
  validation before it signs or packages anything.
- **Development upgrades are allowed** (`AllowUnsignedDevelopmentUpgrades=true`, error CAB0001). Such an agent would accept programs
  that are not code-signed.

The check is the `CheckCabinetReleaseTrust` target (and its inline `CheckUpgradeTrust` task) in `agent/src/Cabinet.Agent.Core/Cabinet.Agent.Core.csproj`, run before compilation. It needs no package restore.
Development, test and CI builds leave the property unset and are not stopped by it. The signing pipeline (step 1 of the signing flow)
sets it. `Publish-CabinetAgent.ps1 -CabinetReleaseChannel production` passes it through to every published program.
The repository's own list now pins a publisher, so a
cabinet release build of the current tree passes this check, which `contracts/test/release-channel.test.mjs` asserts
alongside the cases that still fail: an empty list, a broken publisher entry, or a root that is not the pinned one.

## What the repository pins

`contracts/trust/upgrade/upgrade-keys.json` names one code-signing publisher — common name `Mashura Code Signing`,
organization `Mashura LLC` — and the root certificate beside it, `agent-code-signing-root.pem`, whose SHA-256 is
`3049e830ab210ae07a12f5fc287b0e503532e2245de6daf5546fb53916bffc3b`. Both are made and pinned by
`agent/install/New-PublisherRoot.ps1`, which generates an offline root and one issuing certificate from it, proves a
signature and the chain before it writes anything, and refuses to write a private key inside the repository; its cases are
in `agent/install/tests/run-tests.ps1`. The decision behind it (7 November 2026) is our own publisher root and no bought
certificate, so we can sign and update our own programs.

`agent/install/new-agent-release.py` signs every published program on Linux with `osslsigncode`, verifies every signature
against this root, and creates the same release files as `New-AgentRelease.ps1`. Architecture is supplied separately when
uploading; the signed manifest uses `releasedAt` and has no architecture field. The local installer and generated fleet
script carry the public root offline, check its certificate SHA-256 before opening either machine store, and add it to
`LocalMachine\Root` and `LocalMachine\TrustedPublisher` only when absent. Fleet reruns repair publisher trust even when
the agent is already installed.

The two conditions remain independent: Windows must accept the signature, which is what the installed root is for, and
the signer must match this pinned publisher, which is what this list is for. Linux verification does not prove Windows'
`WinVerifyTrust` result. The Windows signature test and an observed cabinet rollout are release gates; see
[the signing runbook](../platform/agent-release-signing.md) for commands and the evidence still needed.

## Installing on the cabinet

- A small updater program, also signed, stops the service, keeps the current version as a backup, puts the new version in place and starts the service.
- The new version must check in with the server within 5 minutes. If it does not, the updater restores the backup and restarts the old version.

## Downgrades

Agents refuse older versions by default. A rollback is published as a new signed release that contains the older code with a higher version number, so the no-downgrade rule never needs an exception.

## Staged rollout

- Batch 1: one cabinet
- Batch 2: the in-office cabinets
- Batch 3: a small slice of the field, around 5 percent
- Batch 4: everyone else
- **To change** (the owner, 2026-11-26, decision-log D160, plan items 2.11 to 2.14):
  - a rollout gets a target (one cabinet, chosen cabinets, a site or a client), a canary first batch, and later batches the person
    sets, and library packages roll out the same way;
  - starting one becomes a permission an Admin can grant. The rules below stay.
- Each batch must reach a set success rate before the next starts. Any failure above the limit pauses the rollout automatically.
- A rollout completes once its last batch reaches the rate and no offer in any batch is still open. Cabinets still waiting then are closed as skipped, so none is left pending ([open decisions](09-open-decisions.md), "Thresholds").

## Changing the signing key

The agent can hold a second, future public key. Ship it in a normal release, then start signing with it, then remove the old one in a later release.
