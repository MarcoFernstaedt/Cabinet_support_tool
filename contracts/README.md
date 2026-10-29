# Contracts

The JSON Schemas in `schemas/` are the single source of truth for every message between the agent and the server, and for every operation's parameters and output (docs/spec/03-protocol.md, docs/spec/04-agent-spec.md). The server, the console and the agent are all built and tested against these files.

```text
schemas/
  common.schema.json            shared definitions: ids, times, IPs, allowed logs, firewall shapes, codes
  envelopes/*.schema.json       command, result, event, event-batch, heartbeat, enrollment, renewal, responses
  operations/catalog.json       the fixed operation catalog: kind, minimum role, step-up, expiry, rate class
  operations/<name>.schema.json one file per operation, with $defs/params and $defs/output
  diagnostics/module.schema.json a diagnostic module: catalog reads, ordered checks, causes, catalog repairs and how
                                each is verified. Server data only: the agent has no C# type for it, and the server
                                checks what a schema cannot (server/src/diagnose/module.ts)
examples/<target>/{valid,invalid}/*.json
                                every envelope and operation has valid examples; every operation's params
                                have hostile ones (traversal, injection, oversized, unknown fields, Security log…)
generated/ts/contracts.d.ts     TypeScript types generated from the schemas (types only; do not edit)
trust/trusted-publishers.json   the driver and MSI signers the agent accepts, with their pinned roots (*.pem)
trust/upgrade/upgrade-keys.json the release signing keys and the agent's code-signing publisher; empty until the
                                production KMS key and certificate exist (docs/spec/09-open-decisions.md)
load.mjs                        loads every schema into one Ajv instance (used by tests and the server)
```

Schema `$id`s use `https://schemas.mashura.example/...`. `.example` is a reserved domain, so nothing ever fetches them over the network; tools load them from these files.

## Commands

```text
npm ci
npm test               # every schema compiles strictly; examples pass/fail as labelled; catalog consistency
npm run generate       # regenerate generated/ts/contracts.d.ts after changing a schema
npm run check-generated
```

The C# side is checked by `agent/tests/Cabinet.Agent.Contracts.Tests` (`dotnet test agent/Cabinet.Agent.sln`). It validates the same examples with an independent validator and round-trips each valid one through the agent's C# types.

## Changing a contract

1. Edit the schema. Add valid and hostile examples next to it.
2. `npm run generate` and `npm test`.
3. Update the C# record in `agent/src/Cabinet.Agent.Contracts` and run `dotnet test agent/Cabinet.Agent.sln`.
4. Changes to the protocol contracts need review by two people (docs/spec/02-security-model.md, control 15).

Adding an operation also means adding it to `operations/catalog.json`, the `operationName` list in `common.schema.json` and the C# `Catalog`. The tests fail until all of them agree. Agents only gain new operations through a signed agent upgrade.
