// The fleet's readings search at 10,000 cabinets (F21.R4): a search of every cabinet's newest software list by a program name, the
// heaviest reading the search reads. Not part of the suite: run it by hand on a quiet machine,
//   node dist/test/readings-search-at-scale.bench.js
// and it prints the timings, which docs/platform/performance.md records with the machine they were measured on.
import { randomUUID } from "node:crypto";
import { searchReadings } from "../src/services/readings.js";
import { searchText } from "../src/services/reading-search-text.js";
import { createPool } from "../src/db/db.js";
import { createTestDatabase } from "./database.js";

const CABINETS = 10_000, PROGRAMS = 80, READS_PER_CABINET = 2, MATCHING = 100, RUNS = 5;
const program = (i: number) => ({ name: `Example Program ${i}`, publisher: `Example Publisher ${i % 20}`, version: `1.${i}.0` });
const output = (extra: object[]) => ({ programs: [...Array.from({ length: PROGRAMS }, (_, i) => program(i)), ...extra], hotfixes: [{ id: "KB5034441" }] });
const list = (extra: object[]) => JSON.stringify({ output: output(extra) });
const kiosk = [{ name: "Contoso Kiosk Browser", publisher: "Contoso", version: "4.2.0" }];
// WITH_TEXT=0 seeds the results as they were stored before the search text existed (the old path).
const withText = process.env.WITH_TEXT !== "0";

const db = await createTestDatabase();
try {
  const clientId = randomUUID(), siteId = randomUUID(), userId = randomUUID();
  const owner = await createPool(db.ownerUrl, { max: 2, requestTimeoutMs: 600_000 });
  const t0 = Date.now();
  await owner.query("INSERT INTO clients (id, name) VALUES ($1, 'Scale')", [clientId]);
  await owner.query("INSERT INTO sites (id, client_id, name) VALUES ($1, $2, 'Scale')", [siteId, clientId]);
  await owner.query("INSERT INTO users (id, username, name, role) VALUES ($1, 'bench', 'Bench', 'admin')", [userId]);
  await owner.query(`INSERT INTO cabinets (id, site_id, name, role, status)
    SELECT NEWID(), $1, CONCAT('K', n), 'standalone', 'active' FROM (SELECT TOP (${CABINETS}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b) x`, [siteId]);
  // Each cabinet's software list, read twice a day apart; the newest of the first MATCHING cabinets has the program searched for.
  await owner.query(`INSERT INTO commands (id, cabinet_id, operation, params, issued_by, issued_at, expires_at, status, result, result_at, search_text)
    SELECT NEWID(), k.id, 'software.list', '{}', $1, DATEADD(day, -r.n, SYSUTCDATETIME()), DATEADD(day, 1 - r.n, SYSUTCDATETIME()), 'succeeded',
           CASE WHEN r.n = 0 AND k.rn <= ${MATCHING} THEN $3 ELSE $2 END, DATEADD(day, -r.n, SYSUTCDATETIME()),
           CASE WHEN r.n = 0 AND k.rn <= ${MATCHING} THEN $5 ELSE $4 END
      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM cabinets) k
      CROSS JOIN (SELECT TOP (${READS_PER_CABINET}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) - 1 AS n FROM sys.all_objects) r`,
    [userId, list([]), list(kiosk), withText ? searchText("software.list", output([])) : null, withText ? searchText("software.list", output(kiosk)) : null]);
  await owner.end();
  console.log(`seeded ${CABINETS} cabinets, ${CABINETS * READS_PER_CABINET} software lists of ${PROGRAMS + 1} programs, ${withText ? "with" : "without"} search text, in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const search = () => searchReadings(db.app, "software.list", "kiosk browser", {}, 600_000);
  const ms: number[] = [];
  const first = await search(); // warm
  for (let i = 0; i < RUNS; i++) { const s = process.hrtime.bigint(); await search(); ms.push(Number(process.hrtime.bigint() - s) / 1e6); }
  ms.sort((a, b) => a - b);
  console.log(`search of every newest software list: median ${ms[Math.floor(RUNS / 2)]!.toFixed(0)} ms, best ${ms[0]!.toFixed(0)} ms, worst ${ms[RUNS - 1]!.toFixed(0)} ms over ${RUNS} runs`);
  console.log(`found ${first.matches.length} of ${first.cabinetsRead} cabinets read (${first.cabinetsInScope} in scope)`);
} finally {
  await db.drop();
}
