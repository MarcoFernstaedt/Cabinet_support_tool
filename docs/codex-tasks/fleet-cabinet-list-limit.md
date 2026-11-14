# Task: item 3 — the fleet cabinet list keeps its limit on screen

Repository: `/home/marco/cabinet_support_tool`. Read `CONTRIBUTING.md` first; it is the standard this change is held to.
Handle **exactly one item**: the cabinet list the Fleet operations page reads.

**One writer per file.** `server/src/services/fleet-jobs.ts` and `server/test/fleet-jobs.test.ts` are held by item 2 (the
per-target fleet budget) until that PR merges. Do not touch those two files, and do not start this item, until the
coordinator says item 2 has landed. If you are reading this before that, stop and report.

## The defect

`GET /api/fleet-operations/cabinets` (`server/src/console-api/fleet-ops-routes.ts:15`) returns every cabinet that matches
the filter, whole:

```ts
const q = consoleBodies.fleetCabinetsQuery.parse(request.query);
return { cabinets: await fleetCabinets(o.pool, q) };   // :17-18
```

`fleetCabinets` (`server/src/services/fleet-jobs.ts:37`) has no cap. The console asks for the list only after a site is
chosen (`console/src/pages/FleetOperations.tsx:58`), but the filter also allows a client alone or a problem alone — and
then this returns the whole fleet in one response, with nothing in the answer saying it was cut. At the fleet size this
platform is for, that is thousands of rows and a page that cannot tell the operator what it left out. Decision-log D51
and `docs/spec/12-milestones-8-to-12.md:198` (F17, **"The limit on screen"**) already fix the answer for the trends
lists: cap it, and report how many matched against how many are shown.

## What to build

1. **`fleetCabinets` gains a cap and reports the limit**, in exactly the shape the house already uses
   (`server/src/services/error-trends.ts:207-211`):

   ```ts
   limits: { cabinets: { shown: number; matched: number; limit: number } }
   ```

   `limit` is the cap, `matched` is how many cabinets matched the filter, `shown` is how many are in `cabinets`. Name it
   by the list, like `limits.issues` is, so `limits.cabinets` reads as "the cabinets list was cut".

2. **The cap is 200.** The console already refuses to work with more than 200 chosen cabinets
   (`console/src/pages/FleetOperations.tsx:27`, `const LIMIT = 200;`), so the server's cap must be the same number and it
   should say why in a comment — one constant, and the console's copy must not contradict it.

3. **`matched` counts the same filter the list does**, from the same consistent read (a `COUNT(*) OVER ()` in the list
   query, or a second query — your choice, but the two must not be able to disagree).

4. **Order stays deterministic.** If the list's current `ORDER BY` is not a total order, add the tie-break it needs, so
   that the 200 shown do not change identity between two identical requests. Do not change the visible ordering.

5. **The route returns the limits with the list** (`fleet-ops-routes.ts:15`), so the console can render the note without
   a second call.

6. **The console says it in the operator's words.** `console/src/pages/FleetOperations.tsx:58` reads the list; when
   `limits.cabinets.shown < limits.cabinets.matched`, show a note naming both numbers and what to do about it — the shape
   of the note already exists for the trends lists in `console/src/pages/Triage.tsx:28-31` (`TrendLimits`). Something in
   the operator's vocabulary, along the lines of: *"Showing 200 of 3,412 cabinets that match. Narrow by client, site or
   problem to see the rest."* — your words, not mine, but the two numbers and the way out must be there.

7. **Selection must not lie.** Line 115 prints "N of M selected". When the list is cut, that count cannot be read as the
   whole fleet matching the filter, and "select all" must never imply the rows the operator cannot see. Keep it simple and
   true; say what is selected and that the list is cut, in the same place.

## Not in this task

- **No page numbers, no offset, no "next page".** This is a selection list for a bulk change: the operator narrows with
  the filters that already exist, and the preview and plan steps already handle the full match set on the server. Adding
  pages here would let someone build a change out of rows they never saw.
- **No new query input.** `contracts/schemas/console/fleet-cabinets-query.schema.json` stays as it is — the cap is the
  server's. Do not add `limit`, `page` or `offset` to it.
- Do not change `preview`, the job endpoints, the one-site rule, the confirmation, or any invariant in `CONTRIBUTING.md`.
- No schema or migration change. No reformatting, no renames, no new dependencies. Do not weaken or rewrite an existing
  assertion; if one must change, stop and report it.
- Do not commit, and write no files inside the repository — logs go to `/home/marco/.hermes/cache/scratch/`.

## Tests that must ship

`server/test/fleet-jobs.test.ts` (the service and the route — an existing file, so add to it and change nothing in it) and
a new `console/test/fleet-operations.test.ts` (that directory is where the console tests live; `console/test/fleet-alarm.test.ts`
is a nearby example of the shape).

- A filter matching more than the cap returns exactly `limit` cabinets, with `shown === limit` and `matched` equal to the
  true number matching.
- A filter matching fewer than the cap returns them all, with `shown === matched` and nothing cut.
- Two identical requests return the same 200 in the same order.
- The console shows the note only when the list was cut, and the note carries both numbers.
- The existing per-cabinet shape of a row is unchanged.

## Acceptance

From `server/`, with `TEST_DATABASE_ADMIN_URL` exported and the disposable `cab-test-mssql` container up, and from
`console/` for the console suite. Report each file's own numbers — tests, pass, fail, skipped — and the exit code beside
them. A file that prints no summary line did not pass: it crashed or hung, so say so. Your sandbox returns `EPERM` on
127.0.0.1:11433, so the database-backed numbers are the reviewer's to run; state plainly what you could not run.

Baselines at the merged head before this change, reviewer-measured: `server` 1089 tests / 1079 pass / 0 fail / 10 skipped;
`console` 112 tests / 112 pass. Report what you actually got.

Red/green: neuter your cap (one edit — make the limit enormous), watch the "returns exactly `limit`" test go red, restore
the file byte-identical (`cmp`), watch it go green. Say which edit you used. The reviewer re-runs both this and the gate.
