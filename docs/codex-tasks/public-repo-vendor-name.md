# Remove the vendor name from everything a reader sees

The repository is about to be made public and the vendor company name must not appear in documentation,
prose or comments. Keep it in the console UI only, and keep runtime identity untouched (see the
do-not-touch list - those are behaviour and trust, not prose).

Across the whole repository the name appears 577 times in 375 files. Split it: the 98 occurrences that
are install paths, service names, pipe names, release identity or signing identity are out of scope
(they are listed below and must not be changed in this task). This task does the rest.

## In scope

1. **Documentation.** Every `*.md` under `docs/`, plus root `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`,
   and every per-tree `README.md` (`agent/`, `server/`, `console/`, `contracts/`, `deploy/`, `scripts/`).
   Rewrite the prose so the sentence still reads naturally - do not leave a hole or a doubled space.
   Where the text says the product belongs to the company, say what it is instead: a cabinet
   diagnostics platform, or the vendor-neutral "the operator". Use a neutral placeholder such as
   `diagnostics.example.com` for example hosts.
2. **Comments in source.** `server/src`, `console/src`, `agent/src`, `contracts/`, `deploy/`, `scripts/`.
   Change comments and doc-comments only. Do not change executable code on those lines.
3. **Example and placeholder schema identifiers.** Schema `$id` values currently use the vendor name in
   the host part, for example `https://schemas.<vendor>.example/cabinet-diagnostics/v1/...`. Change the
   host part to `https://schemas.example.com/cabinet-diagnostics/v1/...`.
   **Before doing this, check whether any `$ref` in those schemas, or any code, resolves schemas by
   those URLs.** If a `$ref` uses the host, update it in the same change. If the host is baked into a
   runtime lookup or a signed artifact, leave the whole file alone and report it instead.
4. **Test fixtures and test prose** that use the name only as a label or example value - the same
   placeholder treatment. Do not change a fixture value that a schema `const` or a protocol check
   compares against.

## Out of scope - do not touch in this task

These are runtime identity, update identity or signing identity. Renaming them would desync the
repository from the agent already deployed on a real cabinet and from the pinned publisher trust, so
they are a separate migration decision:

- The install and data paths under Program Files and Program Data that carry the vendor name. They
  appear in the installer scripts, the CI workflow and many tests.
- The Windows service display names and the installer's service registration.
- The named pipe used by the broker.
- The release manifest `product` value and the publish script that writes it.
- The code-signing common name and the AWS KMS alias.
- The approved-list protocol constant `"const": "mashura-approved-list"` in
  `contracts/schemas/agent/approved-list.schema.json` - this is a wire value, not a label.
- Anything under `console/src` that is rendered to the user. The console UI keeps the vendor name.

Leave a short note at the end of your answer listing every occurrence you deliberately left, with the
file and the reason, so the remaining migration can be planned from it.

## Constraints

- Comments and docs only where the name is prose; no behaviour change anywhere.
- Run the server suite and the console suite, plus the free-identifier check on any script you touch.
- Do not commit; leave the changes in the working tree. Dev branch only.
