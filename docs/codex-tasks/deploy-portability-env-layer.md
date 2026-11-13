# Task: the deployment environment layer, so this platform can move to another server

Owner brief (Aster). Work inside `/home/marco/cabinet_support_tool`. Do not commit; leave the changes in the working tree.

## What exists today (read these first)

- `deploy/compose.yaml` — the platform's services (`mssql`, `migrate`, `server`, `caddy`). Every value it needs arrives
  as an environment variable from `deploy/.env`.
- `deploy/.env` — the live deployment's secrets. Root-owned, mode 600, **not in the repo**, covered by `.gitignore`.
  Never read it, never copy a value out of it, never add it.
- `deploy/compose.override.yaml` — this VPS only: publishes Caddy on loopback because Tailscale holds 443.
- `deploy/README.md` — the operator's document: what each service is, ports, the `cabinet-compose-local` wrapper, and
  how the deployment is brought up.
- `deploy/setup.sh` — the first-run bootstrap (generates secrets, creates the database, migrates, creates the first
  Admin). Read it: it is the list of variables a fresh server needs.
- `deploy/backup.sh` — the nightly backup. It calls `docker exec … sqlcmd … BACKUP DATABASE … WITH COMPRESSION`.
- `deploy/database-setup.mjs` — creates the database, the application login and the grants.
- `.gitignore` — already covers `deploy/.env` and `*.key`, `*.pem`.

## Why (the defect this task exists for)

**Verified on this host, 2026-11-13.** The deployed database is SQL Server **Express** Edition
(`BACKUP DATABASE WITH COMPRESSION is not supported on Express Edition (64-bit)` — Msg 1844). So `deploy/backup.sh`
**cannot produce a backup on the exact deployment it was written for**: it fails at the first statement and writes
nothing. The same server also has no backup cron installed (`/etc/cron.d/` holds no cabinet entry), so the platform has
no working backup path at all. Both were found by running the script here, not by reading it.

## The job

1. **Make `deploy/backup.sh` work on Express.** Detect the edition once (`SELECT SERVERPROPERTY('Edition')` via the
   same `docker exec … sqlcmd` path already in the file) and add `WITH COMPRESSION` only when the edition supports it.
   Keep the existing behaviour on editions that do (Developer, Standard, Enterprise). Do not weaken the rest of the
   script: the checksum, `INIT`, `RESTORE VERIFYONLY` verification, the encryption step and its key handling stay.
   On failure it must still exit non-zero and print one line saying what failed and where the log is.
2. **Ship the schedule as code, not as a manual step.** Add `deploy/install-backup-cron.sh` that installs the nightly
   backup entry idempotently (same schedule the README documents — read it, do not invent a different one), checks the
   command it is about to install exports what it needs, and prints the resulting crontab line. It must be safe to run
   twice.
3. **Per-environment environment files, without a secret ever entering a template.**
   - Add `deploy/env/lab.env.example` and `deploy/env/production.env.example`: one line per variable that
     `compose.yaml` and `setup.sh` consume, `KEY=` with a comment saying what it is, which parts are paths, and which
     two settings must agree with each other (the agent API hostname list is exactly what the TLS certificate covers;
     the public agent address must be a name the certificate covers **and** an address a cabinet can dial).
   - Separate the two kinds of value explicitly in the templates: **generated on the server at first run** (secrets)
     versus **chosen by the operator** (site name, hostname, ports, bind addresses).
   - Add `deploy/env/README.md`: how an operator turns a template into a real env file, where the real file must live
     so it is ignored by git, and how to bring the stack up from it.
   - Extend `.gitignore` so `deploy/env/*.env` (the real files) are ignored while `*.env.example` stays tracked. Add
     the same rule for an env file kept anywhere under `deploy/`.
4. **A test that fails if a secret is ever committed or a template loses a variable.** In `server/test/`
   (follow the existing harness — `node:test`, plain TypeScript, no new dependency; look at
   `server/test/installer-scripts.test.ts` for the file-reading style) add `deploy-env-templates.test.ts` that asserts:
   - every `deploy/env/*.env.example` is tracked and contains no value that looks like a live secret (no
     base64/hex blob of real length after `=` for a key whose name says password/secret/key/token);
   - every variable name that `deploy/compose.yaml` interpolates (`${NAME}`) appears in at least one template;
   - `deploy/env/*.env` (non-example) is matched by `.gitignore` — check with the repo's own rule text, not by
     creating a file.
   Each check must be able to fail: prove it by temporarily breaking the thing it checks and pasting the red run in the
   acceptance block.
5. **The runbook for moving to a different server.** Add `deploy/PORTABILITY.md`: what has to travel (the database, the
   PKI directory, the package and release directories, the env file), what may be regenerated, what must be pinned to
   the same version on the new host, the order of operations (database first, then PKI, then the app, then the
   certificate names, then the agents), how to prove the new host is the same platform (the commands and the output to
   expect), and the one-way doors (a new PKI means every cabinet must be re-enrolled — say so plainly). It must name
   the exact variable that decides the agent API binding and the exact command that proves the binding, in the form the
   services actually use them here.
6. **Truthful docs.** Where `deploy/README.md` or `docs/platform/*.md` states something about backups, environments or
   ports that the code no longer does (or never did — the compression line is one), correct the text in the same
   change. Do not add a phase or roadmap document.

## Project rules this task must not break

- No secret, token, key or password in any tracked file. Placeholders only, named as placeholders.
- `agent/install/*.ps1` must stay pure ASCII (Windows PowerShell 5.1 reads a BOM-less `.ps1` as Windows-1252).
- No new runtime dependency, in the server or in the scripts. Bash, Node built-ins and the existing images only.
- Do not edit `deploy/.env`, do not restart or reconfigure any running container, and do not touch
  `server/src/**` — this task is deployment, not application code.
- Do not edit `deploy/compose.yaml`'s service definitions or ports; the port story is deliberate (Caddy on loopback
  here because Tailscale holds 443).
- Docs are for an engineering leader: state what is true, no marketing sentences.

## Not in this task

- Any change to the C# agent, the console, or the contracts.
- Dependency upgrades (a separate task).
- Anything about the funnel, the maintenance page, or the public entry: that is a separate, open decision.
- Creating the first Admin, filling the fresh database, or enrolling a cabinet.

## Acceptance — paste the exact output of each command

`deploy/.env` is root-read-only, so compose runs through the wrapper that reads it for you: `cabinet-compose-local`
(see `deploy/README.md`). These are the commands, already proven to run on this host.

```bash
cd /home/marco/cabinet_support_tool

# 0. what the live database is (this is why the fix is needed)
cd deploy && cabinet-compose-local exec -T mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -h-1 -W -Q "SELECT CAST(SERVERPROPERTY('"'"'Edition'"'"') AS nvarchar(60))"'
# expect: Express Edition (64-bit)

# 1. the same BACKUP the script issues, without compression: must succeed and verify
cabinet-compose-local exec -T mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -Q "BACKUP DATABASE cabinet TO DISK = N'"'"'/var/opt/mssql/data/probe-nocomp.bak'"'"' WITH CHECKSUM, INIT, FORMAT; RESTORE VERIFYONLY FROM DISK = N'"'"'/var/opt/mssql/data/probe-nocomp.bak'"'"' WITH CHECKSUM"; rm -f /var/opt/mssql/data/probe-nocomp.bak'
# and the same with compression, which is the defect
cabinet-compose-local exec -T mssql sh -c '/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -Q "BACKUP DATABASE cabinet TO DISK = N'"'"'/var/opt/mssql/data/probe-comp.bak'"'"' WITH COMPRESSION"; rm -f /var/opt/mssql/data/probe-comp.bak'

# 2. the script itself: syntax, and the decision it makes on this host
bash -n backup.sh && echo "syntax ok"
bash backup.sh --print-plan        # add this flag: it prints the resolved edition and whether it will compress, then exits 0
cd ..

# 3. the cron installer is idempotent (as a non-root user it must print the exact line it would install, twice, and change nothing)
bash deploy/install-backup-cron.sh | tail -4
bash deploy/install-backup-cron.sh | tail -4

# 4. the new test goes red without the fix and green with it (paste both runs)
cd server && npx tsc -p tsconfig.json && node --test --test-timeout=600000 dist/test/deploy-env-templates.test.js | tail -12; cd ..

# 5. the templates and the ignore rules
git check-ignore -v deploy/env/lab.env || echo "MISSING RULE"
git check-ignore -v deploy/env/lab.env.example || echo "example tracked (right)"
grep -c '=' deploy/env/lab.env.example deploy/env/production.env.example

# 6. nothing that looks like a live secret is tracked
git grep -nE '(BEGIN [A-Z ]*PRIVATE KEY|password[[:space:]]*=[[:space:]]*[A-Za-z0-9+/=]{24,})' -- deploy '*.example' || echo "clean"
git status --short
```

## Deliverable

The working tree carries: the corrected `deploy/backup.sh`, `deploy/install-backup-cron.sh`,
`deploy/env/{lab,production}.env.example`, `deploy/env/README.md`, `deploy/PORTABILITY.md`,
`server/test/deploy-env-templates.test.ts`, the `.gitignore` rule and the corrected doc text. Report, in your summary,
every file you touched, the two test runs (red without the fix, green with it), and the exact output of the acceptance
block. Do not commit.
