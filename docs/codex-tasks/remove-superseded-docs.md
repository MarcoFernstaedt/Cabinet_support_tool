# Remove the superseded documentation and every reference to it

The repository is about to go public. The archive of superseded plans and the investigative research
notes are internal history, and they are going. The reference to them must go with them - a comment or a
document that cites a file that no longer exists is worse than no citation.

## Delete

- Under `docs/platform/`, `archive/` - the whole directory (7 files: control-half-plan, improvement-plan,
  diagnostic-engine-execution, readiness, leadership-report, second-architecture, diagnostic-engine-audit).
- Under `docs/platform/`, `research/` - the whole directory (5 files under `2026-10/`: audit-agent, usb-design-research,
  windows-dynamics, audit-network, audit-server).
- The 2026-11-14 build program under `docs/`.

Delete nothing else. In particular keep `docs/spec/`, `docs/platform/remaining-phases.md`,
`docs/platform/README.md` and `docs/codex-tasks/`.

## Fix every reference

Before deleting, build the list of every tracked file that names one of the deleted paths. A starting
list, which you must verify and extend rather than trust:

- **About 49 source files** under `server/`, `console/` and `agent/` cite them in comments, usually as a
  parenthetical.
- **Documents**: `docs/README.md`, `docs/platform/README.md`, `docs/platform/remaining-phases.md`,
  `docs/spec/09-open-decisions.md`, `docs/codex-tasks/public-repo-polish.md`.
- Sweep the whole repository, including `README.md`, `CLAUDE.md`, `SECURITY.md`, `CONTRIBUTING.md`,
  `deploy/`, `contracts/` and `scripts/`, so the result is proven rather than assumed.

For each one:

- **Delete the citation, and change nothing else.** Do not rewrite the rest of the comment, do not expand
  it, and above all do not add explanation or context. If a comment exists only to cite a deleted file,
  delete the whole comment rather than replacing it with prose. Every touched comment must end up the same
  length or shorter - never longer. Over-commenting is a defect here, not thoroughness.
- **Never leave a dangling pointer** - no "(see )", no "(docs/...)" left half-removed, no sentence that
  promises detail that no longer exists anywhere.
- **In `docs/README.md`**, delete the archive and research rows from the index table entirely, and delete
  the 2026-11-14 build program row. Do not leave a row saying "removed".
- **In `docs/platform/README.md` and `remaining-phases.md`**, cut the pointer. Do not replace it with a
  sentence explaining what the archive used to say. Do not weaken a claim about the product; only remove
  the reference that can no longer be read.
- **In `docs/spec/09-open-decisions.md`**, keep the decisions exactly as they are. A decision that cited
  the archive as its origin keeps its text and loses only the citation.

## Prove it

- Report `git diff --shortstat` for the whole change. The line delta must be **negative** - this change
  deletes far more than it writes, and a positive delta means you wrote more than you removed.
- `git grep -nE 'platform/(archive|research)|build[-]program'` over the working tree returns
  **nothing**. Report the exact command and its result.
- `git grep -n '(see )\|(docs/)' ` returns nothing new.
- The suites are unaffected - no test reads a `docs/` file, which has been checked - but run
  `cd console && npm test` to confirm nothing regressed.
- Every link in `docs/README.md` still resolves to a file that exists.

## Constraints

- Documentation and comments only. No behaviour change, no test change, no schema change.
- Do not commit; leave the changes in the working tree. Dev branch only.
