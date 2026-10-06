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
