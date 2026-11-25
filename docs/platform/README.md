# Platform documents

The build specification is in [`../spec/`](../spec/00-README.md). These files are about the platform as it actually is:
how it is run, what was decided, and what is left.

## Read these first

- [plan-to-completion.md](plan-to-completion.md): **what is left**, item by item, with what proves each and its size. The one
  place the remaining work is counted. The spec's [roadmap](../spec/13-roadmap.md) is the plan, not the status.
- [decision-log.md](decision-log.md): every choice made while building, with why, the alternatives and the cost. Newest first, for
  the end-of-project review.
- [fleet-install.md](fleet-install.md): installing the agent on a site's cabinets from a remote management tool.
- [operations.md](operations.md): how to run, deploy and support the live platform.
- [first-sign-in.md](first-sign-in.md): what a new account sees on the way in.
- [demo.md](demo.md): the demo fleet and how to drive it.

## Security

- [threat-model.md](threat-model.md): what the platform can and cannot do to a cabinet, and the worst cases.
- [security-review.md](security-review.md): the red-team review and the state of every finding.
- [encryption.md](encryption.md), [supply-chain.md](supply-chain.md), [data-classification.md](data-classification.md).
- [agent-release-signing.md](agent-release-signing.md): cutting a signed agent release with our own publisher root and the offline release key (D143).

## How it is built and run

- [sqlserver-port.md](sqlserver-port.md): the platform database on SQL Server 2022.
- [performance.md](performance.md): sizing and the load test.
- [windows-coverage-review.md](windows-coverage-review.md): what the platform reads on Windows, and what is missing.
- [cost.md](cost.md): what running this costs.
- [live-test.md](live-test.md): the test to run on a real cabinet, and what the real-machine runs found: read-only on 2026-10-25,
  the write sweep and the 32-bit package on a 64-bit machine on 2026-11-13.

## Removed

Finished plans, reports and research were removed on 2026-11-25 (decision-log D150); git history keeps them. Their designs
that code still cites are in [`../spec/18-built-designs.md`](../spec/18-built-designs.md). Three applied migrations
(`0007_architecture.sql`, `0008_release_architecture.sql`, `0017_incidents.sql`) still name them in a comment. A migration's
text is checksummed when it is applied, so it is never edited: read those names as spec 18 §1 and §2.

Retired earlier: `hardening-and-roadmap.md` (now [security-review.md](security-review.md) and the plan), `remaining-phases.md`
(folded into the plan, D150) and `14-network-troubleshooting.md` (now
[`../spec/16-network-troubleshooting.md`](../spec/16-network-troubleshooting.md)).
