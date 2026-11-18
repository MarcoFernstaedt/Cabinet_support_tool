# Remove the superseded documentation and every reference to it

The repository is about to go public. The archive of superseded plans and the investigative research
notes are internal history, and they are going. The reference to them must go with them - a comment or a
document that cites a file that no longer exists is worse than no citation.

## Delete

- `docs/platform/archive/` - the whole directory (7 files: control-half-plan, improvement-plan,
  diagnostic-engine-execution, readiness, leadership-report, second-architecture, diagnostic-engine-audit).
- `docs/platform/research/` - the whole directory (5 files under `2026-10/`: audit-agent, usb-design-research,
  windows-dynamics, audit-network, audit-server).
- `docs/build-program-2026-11-14.md`.

Delete nothing else. In particular keep `docs/spec/`, `docs/platform/remaining-phases.md`,
`docs/platform/README.md` and `docs/codex-tasks/`.

## Fix every reference

Before deleting, build the list of every tracked file that names one of the deleted paths. A starting
list, which you must verify and extend rather than trust:

- **About 49 source files** under `server/`, `console/` and `agent/` cite them in comments, usually as a
  parenthetical, for example:
  - `server/src/services/pathhealth-contracts.ts:1` - `// The sync-path contracts (docs/platform/archive/improvement-plan.md §4 "Workstream B", docs/platform/research/2026-10/audit-network.md ...)`
  - `server/src/services/usb-rules.ts:3` - `// The three rules, and where each bound comes from (docs/platform/research/2026-10/usb-design-research.md §4):`
  - `server/src/contracts.ts:205` - `/** Diagnostic modules (docs/platform/archive/diagnostic-engine-execution.md): ... */`
- **Documents**: `docs/README.md`, `docs/platform/README.md`, `docs/platform/remaining-phases.md`,
  `docs/spec/09-open-decisions.md`, `docs/codex-tasks/public-repo-polish.md`.
- Sweep the whole repository, including `README.md`, `CLAUDE.md`, `SECURITY.md`, `CONTRIBUTING.md`,
  `deploy/`, `contracts/` and `scripts/`, so the result is proven rather than assumed.

For each one:

- **Keep the comment worth reading.** The citation is not the comment. If the parenthesis was carrying the
  only explanation of why the code is the way it is, rewrite the sentence so it still explains that, and
  state the reason directly instead of pointing at a document. If the citation was pure provenance
  ("this came from the plan"), drop it and leave the sentence clean.
- **Never leave a dangling pointer** - no "(see )", no "(docs/...)" left half-removed, no sentence that
  promises detail that no longer exists anywhere.
- **In `docs/README.md`**, delete the archive and research rows from the index table entirely, and delete
  the `build-program-2026-11-14.md` row. Do not leave a row saying "removed".
- **In `docs/platform/README.md` and `remaining-phases.md`**, where the text says the detail or the
  evidence is in the archive, either state the fact inline in one sentence or cut the pointer. Do not
  weaken a claim about the product; only remove what can no longer be read.
- **In `docs/spec/09-open-decisions.md`**, keep the decisions exactly as they are. A decision that cited
  the archive as its origin keeps its text and loses only the citation.

## Prove it

- `git grep -nE 'platform/archive|platform/research|build-program'` over the working tree returns
  **nothing**. Report the exact command and its result.
- `git grep -n '(see )\|(docs/)' ` returns nothing new.
- The suites are unaffected - no test reads a `docs/` file, which has been checked - but run
  `cd console && npm test` to confirm nothing regressed.
- Every link in `docs/README.md` still resolves to a file that exists.

## Constraints

- Documentation and comments only. No behaviour change, no test change, no schema change.
- Do not commit; leave the changes in the working tree. Dev branch only.
