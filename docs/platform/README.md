# Platform documents

The build specification is in [`../spec/`](../spec/00-README.md). These files are about the platform as it actually is:
how it is run, what was decided, and what is left.

## Read these first

- [remaining-phases.md](remaining-phases.md): **what is left, counted.** The top of the page has the current count: what is done,
  what can still be built here, and what is blocked and on what. This is the one place the count lives. The spec's
  [roadmap](../spec/13-roadmap.md) is the plan, not the status: read the code or this page before taking a "to build" there as unbuilt.
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

## How it is built and run

- [sqlserver-port.md](sqlserver-port.md): the platform database on SQL Server 2022.
- [performance.md](performance.md): sizing and the load test.
- [windows-coverage-review.md](windows-coverage-review.md): what the platform reads on Windows, and what is missing.
- [cost.md](cost.md): what running this costs.
- [windows-acceptance-harness.md](windows-acceptance-harness.md): Windows shell acceptance constraints and reviewer commands.
- [live-test.md](live-test.md): the test to run on a real cabinet, and what the real-machine runs found: read-only on 2026-10-25,
  the write sweep and the 32-bit package on a 64-bit machine on 2026-11-13.

Retired earlier (removed, not archived):
- `hardening-and-roadmap.md` was replaced by [security-review.md](security-review.md) (the findings) and
  [remaining-phases.md](remaining-phases.md) (the phases).
- `14-network-troubleshooting.md` is now [`../spec/16-network-troubleshooting.md`](../spec/16-network-troubleshooting.md).
  Two files were numbered 14, and 14 is the emergency-access milestone.
