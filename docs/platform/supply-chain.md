# Software supply chain

What stops a bad dependency, a tampered build or a poisoned update from reaching a cabinet, and what is still left to do.
The agent runs on clinic computers with administrator rights in one small part (the broker), so what is shipped to it matters more than anything else here.

## 1. What reaches a cabinet: signed, and checked on the cabinet

- **Agent upgrades** are signed by a key held in a key-management service that the server never has ([upgrade channel](../spec/07-upgrade-channel.md)). The server delivers an upgrade; it cannot make one the agent will accept. The agent checks the signature, the hash and the manifest, keeps its previous version, and rolls back by itself if the new one cannot reach the platform.
- **Drivers and installers** reach a cabinet only from the approved software library, and the cabinet checks their hash, their signature and the publisher against its own trusted-publisher list before installing. A compromised server cannot add a publisher.
- **There is no other way to send a file to a cabinet.** No shell, no script runner, no general file transfer ([CLAUDE.md](../../CLAUDE.md)).
- **The agent's own dependencies** are two Microsoft packages for WMI and the event log, plus the service-controller package; their versions and content hashes are in the committed `packages.lock.json` files, and CI restores in locked mode (a changed hash fails the build).

## 2. What goes into a build

| Control | Where | State |
|---|---|---|
| Lock files for every ecosystem (npm, NuGet) and installs only from them (`npm ci`, locked NuGet restore in CI) | `*/package-lock.json`, `agent/**/packages.lock.json` | In place |
| No dependency runs code at install time (`npm ci --ignore-scripts`) | CI, `deploy/Dockerfile` | In place |
| Known-vulnerability gates that fail the build (`npm audit`, `dotnet list package --vulnerable --include-transitive`) | CI | In place |
| Registry signatures and provenance of every installed npm package verified (`npm audit signatures`) | CI | In place |
| Software bill of materials per build (CycloneDX for each Node project; the NuGet lock files for the agent) | CI artifact | In place |
| Base images pinned by digest as well as tag (Node, .NET SDK, SQL Server, Caddy) | `deploy/Dockerfile`, `deploy/compose.yaml`, CI | In place |
| Container runs as an unprivileged user, no shell in the runtime stage's entry point | `deploy/Dockerfile` | In place |
| Workflow token is read-only; checkouts do not keep credentials | `.github/workflows` | In place |
| Automated update proposals, reviewed one by one | `.github/dependabot.yml` | In place |
| Review required for the paths that matter (contracts, agent core, broker, auth, migrations, deploy, workflows) | `.github/CODEOWNERS` | In place; turn on "Require review from Code Owners" and "Require status checks" in the branch protection rule for `main` |
| Third-party GitHub Actions pinned to a commit | `deploy/pin-actions.sh` | **To do once:** run it where github.com is reachable and commit the result. A repository test lists any action that is not pinned, so the list can only get shorter. |
| Repository-level secret scanning and push protection | GitHub settings | **To do:** turn them on (Settings → Code security) |
| Build provenance attestation for the platform image and the agent package | release workflow | **To do** with the first real release: publish through a workflow with `id-token: write` and attach an attestation so anyone can verify which commit built an artifact |

A repository test (`server/test/supply-chain.test.ts`) fails if a base image loses its digest, an install stops using the lock file or `--ignore-scripts`, a workflow gains write permissions, or a new unpinned action appears.

## 3. What the platform does not trust

- The server is treated as something that may be compromised: it cannot sign upgrades, add trusted publishers, or make an agent run anything outside its fixed catalog, and every command and every result is checked against its JSON Schema on the cabinet.
- Cabinets are treated the same way by the server: every message from an agent is checked against its schema, rate-limited, and tied to the certificate of the cabinet that sent it.

## 4. Doing a release

1. Merge only from a reviewed pull request whose checks are green (tests, audits, signatures, SBOM).
2. Build the platform image from the pinned Dockerfile; keep its SBOM and attestation with the release.
3. Build the agent, Authenticode-sign the binaries with our own publisher, build the manifest, and sign it with the offline release key (D143). The key never leaves the offline machine.
4. Roll the upgrade out in stages (a few cabinets, then more); the agent keeps its previous version until the new one has reached the platform.

## 5. Still to do (outside the code)

The signing key ceremony is the owner's decision, and it is made without a purchase: the publisher root is our own internal CA, pinned in `contracts/trust/upgrade/upgrade-keys.json` and installed on a cabinet by the installer, and the release key is the operator's, kept outside the checkout. The pipeline is `agent/install/new-agent-release.py` (`docs/platform/agent-release-signing.md`). Upgrades are still not offered to real cabinets until one is observed taking an upgrade on real hardware.
