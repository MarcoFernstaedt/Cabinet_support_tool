# Platform documents

The build specification is in [`../spec/`](../spec/00-README.md). These files are about the platform as it actually is:
what has been proven, how it is run, and what is left.

## Read these first

- [remaining-phases.md](remaining-phases.md): **the exact number of phases left (5) and everything in each one.** The one
  place the count lives.
- [operations.md](operations.md): how to run, deploy and support the live platform.
- [readiness.md](readiness.md): what is proven and what is not, with the evidence.
- [first-sign-in.md](first-sign-in.md): what a new account sees on the way in.
- [demo.md](demo.md): the demo fleet and how to drive it.

## Security

- [threat-model.md](threat-model.md): what the platform can and cannot do to a cabinet, and the worst cases.
- [security-review.md](security-review.md): the red-team review and the state of every finding.
- [encryption.md](encryption.md), [supply-chain.md](supply-chain.md), [data-classification.md](data-classification.md).

## How it is built and run

- [control-half-plan.md](control-half-plan.md): the near-term work to production, with the sessions and their status.
- [diagnostic-engine-audit.md](diagnostic-engine-audit.md): the audit behind the diagnostic engine, with the decisions.
- [diagnostic-engine-execution.md](diagnostic-engine-execution.md): the order it is built in, and the first session.
- [improvement-plan.md](improvement-plan.md): the backlog of workstreams (USB, network and sync, version data, Windows
  Update, rollback, reach, scale) with sizes and gates.
- [sqlserver-port.md](sqlserver-port.md): the platform database on SQL Server 2022.
- [performance.md](performance.md): sizing and the load test.
- [second-architecture.md](second-architecture.md): the Windows machine as a second architecture, and why.
- [windows-coverage-review.md](windows-coverage-review.md): every Windows version and PowerShell the agent must run on.
- [cost.md](cost.md): what running this costs.
- [live-test.md](live-test.md): the test to run on a real cabinet, and what the 2026-10-25 real-machine test found.

## Research

- [research/2026-10/](research/2026-10/): the audits and designs of October 2026 (agent, network, server, USB, Windows
  dynamics). Kept as the reasoning behind the plans, not as instructions to follow.

## Retired

- `hardening-and-roadmap.md` was replaced by [security-review.md](security-review.md) (the findings),
  [remaining-phases.md](remaining-phases.md) (the phases) and [improvement-plan.md](improvement-plan.md) (the backlog
  sizes). Everything it said is in those three.
- `14-network-troubleshooting.md` is now [`../spec/16-network-troubleshooting.md`](../spec/16-network-troubleshooting.md):
  two files were numbered 14, and 14 is the emergency-access milestone.
