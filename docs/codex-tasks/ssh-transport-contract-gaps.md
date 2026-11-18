# The SSH transport shipped without its contract types, its explanations, or its table ownership

The full gate on `feat/remote-access-tunnel` after pulling `main` up to date returns red: **7 contracts
failures, 1 console failure and 1 server failure.** Every one traces to the SSH transport work, not to
`main`. The acceptance harness proves the transport works end to end; it does not run the contracts,
console or server suites, and repository Actions have been dead since the billing stopped, so nothing
else was watching. Fix the gaps, do not loosen the tests.

## Defect 1 - four contracts failures: no C# type for the new envelopes

```
System.InvalidOperationException : No C# type for envelopes/ssh-transport-data
  at ExampleData.TypeFor(String target) ... ExampleData.cs:line 76
```

and the same for `envelopes/ssh-transport-claim`.

The examples exist: `contracts/examples/envelopes/ssh-transport-data/{valid,invalid}` and
`contracts/examples/envelopes/ssh-transport-claim/{valid,invalid}`. `ExampleData.TypeFor` in
`agent/tests/Cabinet.Agent.Contracts.Tests/ExampleData.cs` has no entry for either target, and there is
no C# type for them under `agent/src/Cabinet.Agent.Contracts`.

Read how an existing envelope pair is done - pick a recent one that has both a schema and examples, for
example the session-frame or broker-request envelopes - and follow the same shape exactly: the type, its
`JsonSerializerContext` registration, and the `TypeFor` mapping. These are real messages on the wire, so
map them to real types rather than to a placeholder.

## Defect 2 - three contracts failures: the agent config does not round-trip

```
agent/agent-config/fresh-install.json changed in the round trip
agent/agent-config/not-enrolled.json changed in the round trip
agent/agent-config/configured.json changed in the round trip
```

The schema and the examples for `agent/agent-config` were extended with the development-only key, but
the C# type for the agent config was never extended to match, so serialising the type back out drops the
property and the two no longer agree. Extend the C# type so the valid examples round-trip unchanged.
The key is development-branch-only and must keep its existing validation and its documented meaning -
do not make it required and do not change its default. If a second development-only key has the same
problem, fix it in the same change.

## Defect 3 - one console failure: three refusal codes have no explanation

```
console/test/error-explanations.test.ts:50
every refusal code in the server's source has an explanation, so a new one cannot reach the console unexplained
  + actual: [ 'empty_frame', 'ssh_transport_busy', 'ssh_transport_unavailable' ]
  - expected: []
```

That test reads the server's source and requires an explanation for every refusal code it finds. Add
explanations for the three codes it names, following the existing entries exactly - same shape, same
tone, and the same "who can actually do something about this" guidance the file already uses. Do not
weaken the test and do not add an exclusion list.

## Defect 4 - one server failure: a cross-module table write

```
server/dist/test/table-ownership.test.js:37
no file writes a table it does not own unless the debt list names it
  + actual: [ 'services/ssh-transport.ts writes remote_sessions (owned by services/session-records.ts)' ]
  - expected: []
```

The transport writes the `remote_sessions` table itself, but `services/session-records.ts` owns it. The
guard offers two exits and only one of them is right here: **go through the owning module.** Add the
function the transport needs to `services/session-records.ts` and call it, so the table keeps a single
writer. Do not add the file to the debt list and do not add it to the accepted-writer list - the debt
list is for legacy sprawl, and this is a new write that can simply be done properly. Check that the
session-records tests still describe the module's behaviour after the addition.

## Verify

- `dotnet test agent/tests/Cabinet.Agent.Contracts.Tests` - 0 failures (the gate's baseline for this
  suite is 0, so it must be clean, not merely improved).
- `cd console && npm test` - 129 pass, 0 fail.
- `cd server && npm test` - 1249 tests, 0 fail.
- The remaining declared baselines are `Core:1` and `Windows:37`; do not try to fix those here and do not
  change the baselines.
- Anything you cannot make pass, say so plainly with the failing test name rather than reporting the
  suite as green.

## Constraints

- No behaviour change to the transport itself; this is the contract and ownership surface around it.
- Do not commit; leave the changes in the working tree. Dev branch only.
