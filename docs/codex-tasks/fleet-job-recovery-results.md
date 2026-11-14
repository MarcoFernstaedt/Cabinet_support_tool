# Fleet job recovery results

Changes: continuous discovery of unfinished running and cancelled jobs; resume issued targets and successes awaiting verification before checking cancellation; retain per-job lease fencing and lease durations. Added two recovery cases for jobs created after startup whose runner encounters an injected database failure, including cancellation and command-count checks. Existing assertions are unchanged. No schema changes.

Validation is incomplete: the sandbox refuses connections to the disposable test SQL Server (127.0.0.1:11433, EPERM), and Docker socket access is denied. Database test cases are unrun; file-level failures below are not passing acceptance results. The red/green proof is also unverified because neither run reaches the test cases. No unrelated findings.

Commands ran in server/ with the already exported TEST_DATABASE_ADMIN_URL; its value was not printed or replaced. `export PATH="$HOME/.dotnet:$PATH"` preceded acceptance tests. Docker inspection could not be used to reconstruct the URL.

```text
$ docker inspect cab-test-mssql --format '{{.State.Status}}'
permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/containers/cab-test-mssql/json": dial unix /var/run/docker.sock: connect: operation not permitted
$ node [TCP connection probe using TEST_DATABASE_ADMIN_URL host and port]
127.0.0.1 11433
EPERM
```

```text
$ npm run build

> @mashura/cabinet-server@0.1.0 build
> tsc -p tsconfig.json

```

```text
$ node --test --test-timeout=600000 dist/test/fleet-jobs.test.js
TAP version 13
# Subtest: dist/test/fleet-jobs.test.js
not ok 1 - dist/test/fleet-jobs.test.js
  ---
  duration_ms: 2600.535748
  type: 'test'
  location: '/home/marco/cabinet_support_tool/server/dist/test/fleet-jobs.test.js:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2614.751645
```

```text
$ node --test --test-timeout=600000 dist/test/fleet-jobs-preview.test.js
TAP version 13
# Subtest: dist/test/fleet-jobs-preview.test.js
not ok 1 - dist/test/fleet-jobs-preview.test.js
  ---
  duration_ms: 1286.878153
  type: 'test'
  location: '/home/marco/cabinet_support_tool/server/dist/test/fleet-jobs-preview.test.js:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1296.378946
```

```text
$ node --test --test-timeout=600000 dist/test/fleet-jobs-retention.test.js
TAP version 13
# Subtest: dist/test/fleet-jobs-retention.test.js
not ok 1 - dist/test/fleet-jobs-retention.test.js
  ---
  duration_ms: 1382.154232
  type: 'test'
  location: '/home/marco/cabinet_support_tool/server/dist/test/fleet-jobs-retention.test.js:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1391.47704
```

```text
$ node --test --test-timeout=600000 dist/test/fleet-jobs-sync-last.test.js
TAP version 13
# Subtest: dist/test/fleet-jobs-sync-last.test.js
not ok 1 - dist/test/fleet-jobs-sync-last.test.js
  ---
  duration_ms: 1300.236298
  type: 'test'
  location: '/home/marco/cabinet_support_tool/server/dist/test/fleet-jobs-sync-last.test.js:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1308.440089
```

```text
$ npm run build # resume loop temporarily disabled with if (false)

> @mashura/cabinet-server@0.1.0 build
> tsc -p tsconfig.json

```

```text
$ node --test --test-timeout=600000 --test-name-pattern='periodic recovery resumes' dist/test/fleet-jobs.test.js
TAP version 13
# Subtest: dist/test/fleet-jobs.test.js
not ok 1 - dist/test/fleet-jobs.test.js
  ---
  duration_ms: 1355.819692
  type: 'test'
  location: '/home/marco/cabinet_support_tool/server/dist/test/fleet-jobs.test.js:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1364.123485
```

```text
$ node --test --test-timeout=600000 --test-name-pattern='periodic recovery resumes' dist/test/fleet-jobs.test.js
TAP version 13
# Subtest: dist/test/fleet-jobs.test.js
not ok 1 - dist/test/fleet-jobs.test.js
  ---
  duration_ms: 1381.833349
  type: 'test'
  location: '/home/marco/cabinet_support_tool/server/dist/test/fleet-jobs.test.js:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1390.355316
```

Restoration used `cp ../fleet-recovery-original.tmp src/services/fleet-jobs.ts`, followed by:

```text
$ cmp src/services/fleet-jobs.ts ../fleet-recovery-original.tmp
$ printf 'cmp exit status: %s\n' "$?"
cmp exit status: 0
```

`git diff --check` succeeded with no output. An initial build invocation from the repository root failed because package.json lives in server/; subsequent builds ran in server/ and succeeded.

Final repository checks from `/home/marco/cabinet_support_tool`:

```text
$ git status --short
 M server/src/services/fleet-jobs.ts
 M server/test/fleet-jobs.test.ts
?? docs/codex-tasks/fleet-job-recovery-results.md
$ git diff --stat
 server/src/services/fleet-jobs.ts | 28 +++++++++++++-----------
 server/test/fleet-jobs.test.ts    | 46 +++++++++++++++++++++++++++++++++++++++
 2 files changed, 61 insertions(+), 13 deletions(-)
```
