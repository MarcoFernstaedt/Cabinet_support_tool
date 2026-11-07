# Remote Upgrade Channel

## Why it needs special care

Upgrading the agent means running new code on every cabinet. If the server alone could push an upgrade, a compromised server could push malware to 8,000 machines. So the agent only installs packages signed by a key the server never holds. The server delivers upgrades; it cannot create one the agent will accept.

## Signing key

- Recommended: an asymmetric signing key in a cloud KMS with hardware backing, such as AWS KMS or Azure Key Vault Managed HSM. The private key never leaves the KMS.
- Acceptable alternative: an offline key on a machine that never touches production, with signing done by hand per release.
- Never: on the server, in the repository, or in a production environment variable.
- Only the build pipeline's identity may request signatures, and every signature request is logged by the KMS.

## Package format

- A zip of the new agent binaries, which are themselves Authenticode-signed
- A manifest: version, SHA-256 hash of the zip, minimum version it can upgrade from, release time
- A detached signature over the manifest

## Signing flow

1. The build pipeline builds the new version and produces the package and manifest.
2. The pipeline sends the manifest's hash to the KMS and receives a signature. The key never leaves the KMS.
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
  - the list is empty, and such an agent would refuse every upgrade at the publisher check;
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
  validates the repository file against that schema, and a release built from any other trust folder (the signing pipeline,
  F1.R2) must run the same validation before it builds.
- **Development upgrades are allowed** (`AllowUnsignedDevelopmentUpgrades=true`, error CAB0001). Such an agent would accept programs
  that are not code-signed.

The check is the `CheckCabinetReleaseTrust` target (and its inline `CheckUpgradeTrust` task) in `agent/src/Cabinet.Agent.Core/Cabinet.Agent.Core.csproj`, run before compilation. It needs no package restore.
Development, test and CI builds leave the property unset and are not stopped by it. The signing pipeline (step 1 of the signing flow)
sets it; until that pipeline exists (finding F1.R2) no build sets it, and today's repository, with no publisher pinned, cannot produce a
cabinet release build at all.

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
- Each batch must reach a set success rate before the next starts. Any failure above the limit pauses the rollout automatically.

## Changing the signing key

The agent can hold a second, future public key. Ship it in a normal release, then start signing with it, then remove the old one in a later release.
