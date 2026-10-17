# Security policy

## Reporting a problem

Report a suspected vulnerability privately to the repository owner (GitHub: Security → Report a vulnerability, or the owner's email on the profile).
Please do not open a public issue. Include what you saw, what it lets someone do, and how to reproduce it. A first reply should come within three working days.

## What the platform promises

The promises are in `docs/spec/02-security-model.md` and the rules in `CLAUDE.md`. In short: the agent runs only a fixed catalog of operations; there is no shell,
script runner or general file transfer; files reach a cabinet only as approved, signed packages checked on the cabinet; the agent's network process never has
administrator rights; every input is checked against its JSON Schema; permissions are checked on the server and the agent; no secrets are kept in the repository.
A report that shows one of these does not hold is treated as the highest priority.

## Supply chain

How dependencies, build images, releases and the agent's own upgrades are kept trustworthy is in `docs/platform/supply-chain.md`.
