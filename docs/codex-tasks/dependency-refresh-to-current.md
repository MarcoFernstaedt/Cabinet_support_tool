# Task: bring every dependency to its current version, with the suite still green

Owner brief (Aster). Work inside `/home/marco/cabinet_support_tool`. Do not commit; leave the changes in the working tree.

## Why

The platform is going to production and will be moved to another server. Running a version behind on the server runtime,
the console toolchain or the .NET packages is a liability that grows with every release. This task brings the tree to
current versions **and proves it with the suite**, and it produces the one list an operator needs: what changed.

## What exists today (read these first)

- Root `package.json` is an npm workspace: `server/`, `console/`, `contracts/`. `package-lock.json` at the root is the
  single lockfile. `contracts/` has its own build (`contracts/load.d.mts` imports `ajv`).
- `server/` runs on Node with TypeScript, `node:test` as the test runner, and SQL Server as the database.
- `console/` is a Vite + React app; its build output `console/dist` is what the browser tests need.
- `agent/` is .NET 10 (`Cabinet.Agent.Windows`, `Cabinet.Agent.Core`, `Cabinet.Agent.Contracts`). The host has
  `$HOME/.dotnet/dotnet` and **`dotnet restore` and `dotnet publish -r win-x86` both work here** (proved 2026-11-13).
- `deploy/compose.yaml` pins the container images; `deploy/README.md` says what each service is.
- The suite's baseline at `07af201`: **1058 tests, 1011 passed, 0 failed, 47 skipped**. The 47 skips are environment:
  32 browser tests need `console/dist` built first, 10 need a built Windows agent, 5 need PowerShell. Re-running the
  32 browser tests after building the console gives 32 passed / 0 failed.

## The job

1. **Measure before you change anything.** Record, in a file you keep in the working tree for the report:
   `npm outdated --workspaces --long` at the root, `npx --yes npm-check-updates --deep --format group` (informational
   only — do not let it write), `~/.dotnet/dotnet list package --outdated` for the agent solution, and the current
   image digests from `docker image inspect` for the images `deploy/compose.yaml` names.
2. **Upgrade the Node tree to current versions**, lockfile included: runtime deps and dev deps, all workspaces at once
   (`npm install` at the root, never per workspace). Do not jump a major version of `react`/`vite`/`typescript`
   without saying what the migration cost is; if the cost is real, leave that one package on its current major and
   write down why. Every package you leave behind needs a one-line reason in the report.
3. **Upgrade the .NET packages** to current versions for the target framework in use, and refresh the lock files that
   exist (`packages.lock.json` if the solution has them — check before you assume).
4. **Keep the container images pinned and current.** If a newer patch tag exists for the SQL Server, Caddy and Node
   images named in `deploy/compose.yaml`, update the tag to the current patch **and pin the digest**; if you cannot
   verify a digest from this host, leave the tag alone and say so. Do not change the SQL Server edition or major
   version.
5. **Prove it.** Rebuild everything the tests need, then run the suite. In order:
   ```bash
   npm ci
   npm run build            # contracts, server, console — whatever the root script does
   cd console && ./node_modules/.bin/vite build && cd ..     # console/dist is needed by the browser tests
   cd server && node --test --test-concurrency=2 dist/test/*.test.js     # the suite lives under server/
   cd server && node --test dist/test/console-*-e2e.test.js              # ~10 minutes, needs console/dist
   ```
   The browser tests need a Chromium **at `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`**
   (note `chrome-linux64`, not `chrome-linux`); confirm it is there before blaming a test.
   Also build the agent: `cd agent && ~/.dotnet/dotnet build Cabinet.Agent.sln -c Release`.
6. **A dependency bump is not an excuse for a red test.** If an upgrade breaks a test, fix the cause in the smallest
   way that keeps the test's intent, and say in the report which test and why. If an upgrade cannot be made green
   without changing behaviour a reviewer should decide on, revert that package to its previous version, leave it out
   of the change, and put it in a short "deferred, with reason" list.
7. **Write the truth down.** Update `docs/platform/` where a version is stated and would now be wrong. Do not add a
   phase or roadmap document.

## Rules

- No new runtime dependency (an upgrade is not a licence to add one). No test may be deleted, skipped or weakened to
  make an upgrade pass.
- No secret in any tracked file.
- Do not touch `deploy/.env`, do not restart any running container, and do not run `docker compose up`.
- Do not change application behaviour: this task is versions, lockfiles and whatever the upgrade forces.
- Do not change the SQL Server edition, the database schema or the migrations.

## Acceptance — paste the exact output

```bash
cd /home/marco/cabinet_support_tool
npm outdated --workspaces || true                 # empty when done, or the deferred list
git diff --stat                                   # the shape of the change
cd server && node --test --test-concurrency=2 dist/test/*.test.js 2>&1 | tail -8   # the suite line
cd server && node --test dist/test/console-*-e2e.test.js 2>&1 | tail -6            # 32 pass, 0 fail
cd agent && ~/.dotnet/dotnet build Cabinet.Agent.sln -c Release 2>&1 | tail -4
```

The report must name every package that moved (from → to), every package deliberately left (with the reason), the
suite line before and after, and anything the upgrade revealed.

## Deliverable

The working tree carries the upgraded manifests, the lockfiles, the agent package versions, any image tag/digest
change, and the corrected doc text. Report: files touched, packages moved, package deferred with reasons, the two
suite lines, the agent build result, and the exact acceptance output. Do not commit.
