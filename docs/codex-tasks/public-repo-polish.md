# Make the repository read like a maintained product before it goes public

Four small, surgical items. No rewrites, no restructuring, no new tooling beyond one config file.
`docs/spec` stays the source of truth and nothing in it should change meaning.

## 1. A documentation index

There is no `docs/README.md`. A visitor browsing `docs/` sees `spec/`, `platform/`, `platform/archive/`,
`platform/research/`, `codex-tasks/` and a loose `build-program-*.md` at the top level with nothing
saying which is authoritative.

Add `docs/README.md` that says, for each folder and loose file directly under `docs/`, what it is and
how much to trust it. Distinguish three levels clearly:

- **`spec/` - the source of truth.** Behaviour is defined here.
- **`platform/` - operations and records**, including the decision log that records why the product is
  shaped the way it is. `platform/archive/` and `platform/research/` hold superseded and investigative
  material that is kept for history and is **not** current.
- **`codex-tasks/` - working briefs.** One file per piece of work, written before the work, kept as a
  record of what was asked. Not documentation of the product.

Include the loose `build-program-*.md` file in the same table. Read each folder's actual contents before
describing it - do not describe a folder from its name alone.

## 2. Close the credential leak in `.gitignore`

`.aws/`, `.agents/` and `.codex/` exist at the repository root. They are empty and untracked today, but
they are **not** ignored, so a single `git add -A` would commit whatever lands in them - and `.aws/` is
exactly where credentials would land.

Add all three to `.gitignore` under the existing "local tool state" grouping if one exists, or in a new
clearly-commented group. Add a comment saying why: these hold local tool state and credentials and must
never be committed. While you are there, check for any other root-level dot-directory that is neither
tracked nor ignored and treat it the same way, so the rule is not a list of three one-offs.

## 3. `.editorconfig`

There is none, and there is no formatter configuration in the repository, so indentation and line endings
are unenforced. Add `.editorconfig` that records the conventions the code **already** follows rather than
the conventions you would prefer: inspect the C# under `agent/`, the TypeScript under `server/` and
`console/`, the JSON schemas under `contracts/` and the shell scripts under `scripts/` first, then write
rules that match what is there. Include a sensible default section, a section for the indentation the
C# uses, one for the TypeScript, one for the JSON and YAML (2 spaces), and line-ending and trailing-newline
rules. Do not add a section that would force a mass reformat of existing files - if the code is already
consistent, the file is a statement of fact, not a change.

## 4. One inaccurate comment

`console/test/error-explanations.test.ts` lines 2-4 claim the code list below is "the exact output of
`grep -rhoE 'new Refused\("[a-z_]+"' server/src | sort -u`". That is no longer true: the grep also returns
`account_locked` and `invalid_credentials`, which are thrown only by `server/src/auth/cli-session.ts` and
`server/src/cli.ts` and are the CLI's exit-code refusals, so they never reach the console and are
deliberately absent from the list.

Correct the comment to say what the list actually is: every refusal code the console can receive, with
the CLI-only codes excluded, and say why they are excluded. Do not add the two codes to the list and do
not add explanations for them - adding console copy for a message the console can never show would be
dead weight.

## Constraints

- Documentation, one ignore file and one config file. No source behaviour changes at all.
- Do not add a CI status badge anywhere: repository Actions are disabled by billing and any badge would
  show red.
- Do not add a LICENSE file. That decision has been made: there will not be one.
- Do not move or rename any existing file - other documents reference them by path.
- Do not commit; leave the changes in the working tree. Dev branch only.
