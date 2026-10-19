// Measures what an event costs in SQL Server (bytes per row including the table's indexes) and what clearing the bulky JSON of old
// unalerted events saves, with synthetic rows shaped like real ones (docs/platform/performance.md "Database size").
//   node dist/test/load/event-size.js [rows]          (default 600000; needs the test SQL Server, creates and drops its own database)
import { clearOldEventDetail } from "../../src/services/maintenance.js";
import { createTestDatabase } from "../database.js";
import { createPool, type Pool } from "../../src/db/db.js";

const rows = Number(process.argv[2] ?? 600_000);
const db = await createTestDatabase();

const size = async (k: Pool) => (await k.query<{ index_name: string; pages: number; n: number }>(
  `SELECT i.name AS index_name, SUM(ps.used_page_count) AS pages, SUM(CASE WHEN i.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS n
     FROM sys.dm_db_partition_stats ps JOIN sys.indexes i ON i.object_id = ps.object_id AND i.index_id = ps.index_id
    WHERE ps.object_id = OBJECT_ID('events') GROUP BY i.name`)).rows;
const report = async (k: Pool, label: string): Promise<number> => {
  const r = await size(k);
  const pages = r.reduce((a, x) => a + Number(x.pages), 0), n = r.reduce((a, x) => a + Number(x.n), 0);
  console.log(`${label.padEnd(34)} ${(pages * 8192 / 1e6).toFixed(0).padStart(6)} MB  ${(pages * 8192 / n).toFixed(0).padStart(5)} B/row  [${r.map(x => `${x.index_name} ${(Number(x.pages) * 8 / 1024).toFixed(0)} MB`).join(", ")}]`);
  return pages * 8192 / n;
};

try {
  const k = await createPool(db.ownerUrl, { max: 2, requestTimeoutMs: 1_800_000 });
  try {
    await k.query("ALTER TABLE events NOCHECK CONSTRAINT ALL");
    const insert = async (count: number): Promise<void> => {
    const chunk = 100_000;
    for (let done = 0; done < count; done += chunk) {
      const n = Math.min(chunk, count - done);
      // Messages are built from a handful of templates with random numbers and names in them, as real System-log messages are (so
      // page compression does what it does on real data, not what it would do on identical rows).
      await k.query(
        `WITH nums AS (SELECT TOP ($1) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b),
              r AS (SELECT i, ABS(CHECKSUM(NEWID())) AS x, ABS(CHECKSUM(NEWID())) AS y, DATEADD(second, -(i % 86400) - 1, SYSUTCDATETIME()) AS t FROM nums)
         INSERT INTO events (event_id, cabinet_id, kind, occurred_at, received_at, source, detail, device, severity_hint, alert_id)
         SELECT NEWID(), CAST(CONCAT('00000000-0000-4000-8000-', RIGHT(CONCAT('000000000000', x % 10000), 12)) AS uniqueidentifier), CASE WHEN y % 10 = 0 THEN 'change' ELSE 'error' END,
                t, t,
                CONCAT('{"log":"', CHOOSE(x % 4 + 1, 'System', 'Application', 'System', 'Microsoft-Windows-Kernel-PnP/Configuration'), '","source":"', CHOOSE(y % 6 + 1, 'Disk', 'Service Control Manager', 'Microsoft-Windows-Kernel-Power', 'Ntfs', 'volmgr', 'Application Error'),
                       '","eventId":', CHOOSE(x % 5 + 1, 7, 7034, 41, 55, 1000), ',"level":"', CHOOSE(y % 3 + 1, 'Error', 'Warning', 'Error'), '","recordId":', CAST(x AS bigint) * 7 + y % 1000, '}'),
                CONCAT('{"message":"', CHOOSE(x % 5 + 1,
                         CONCAT('The device, \\\\Device\\\\Harddisk', y % 4, '\\\\DR', y % 9, ', has a bad block. The driver reported error 0x', CONVERT(varchar(8), CONVERT(varbinary(4), x), 2), ' while reading sector ', CAST(x AS bigint) * 13, ' of volume ', CONVERT(varchar(36), NEWID())),
                         CONCAT('The ', CHOOSE(y % 4 + 1, 'Print Spooler', 'Windows Update', 'Cabinet Sync Agent', 'Background Intelligent Transfer'), ' service terminated unexpectedly. It has done this ', x % 9, ' time(s). The following corrective action will be taken in ', 60000 + y % 5000, ' milliseconds: Restart the service.'),
                         CONCAT('The system has rebooted without cleanly shutting down first. This error could be caused if the system stopped responding, crashed, or lost power unexpectedly. Reboot id ', x, '.'),
                         CONCAT('A corruption was discovered in the file system structure on volume C:. The file reference number is 0x', CONVERT(varchar(8), CONVERT(varbinary(4), y), 2), ' and the name of the file is ', CHOOSE(x % 3 + 1, '\\\\Windows\\\\System32\\\\config\\\\SOFTWARE', '\\\\ProgramData\\\\Cabinet\\\\store.db', '\\\\Users\\\\clinic\\\\AppData\\\\Local\\\\Temp\\\\scan'), '.'),
                         CONCAT('Application popup: Windows - Delayed Write Failed : Windows was unable to save all the data for the file ', CHOOSE(y % 3 + 1, '$Mft', '$MftMirr', '$LogFile'), '. The data has been lost (', x % 1000, ').')),
                       '","fields":{"param1":"', CONVERT(varchar(12), x % 100000), '","param2":"', CHOOSE(y % 4 + 1, 'C:', 'D:', 'E:', 'F:'), '","process":"', CHOOSE(x % 3 + 1, 'svchost.exe', 'System', 'CabinetShell.exe'), '","pid":', y % 9000, '}}'),
                CASE WHEN x % 7 = 0 THEN CONCAT('{"hardwareIds":["USB\\\\VID_', RIGHT(CONCAT('0000', x % 65535), 4), '&PID_', RIGHT(CONCAT('0000', y % 65535), 4), '"],"state":"device_error"}') END,
                CASE WHEN y % 3 = 0 THEN 'major' ELSE 'minor' END,
                CASE WHEN x % 20 = 0 THEN CAST(CONCAT('00000000-0000-4000-9000-', RIGHT(CONCAT('000000000000', x % 500), 12)) AS uniqueidentifier) END
           FROM r`, [n]);
    }
    };
    console.log(`Inserting ${rows} synthetic events…`);
    await insert(rows);
    await k.query("ALTER INDEX ALL ON events REBUILD");
    const full = await report(k, "all events whole");
    const total = Number((await k.query<{ n: number }>("SELECT COUNT(*) AS n FROM events")).rows[0]!.n);
    const alerted = Number((await k.query<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE alert_id IS NOT NULL")).rows[0]!.n);
    console.log(`${total} rows, ${alerted} with an alert (${(alerted / total * 100).toFixed(1)}%)`);

    const t0 = Date.now();
    const cleared = await clearOldEventDetail(k, Date.now() + 40 * 86_400_000, { batch: 4_000, pauseMs: 0, timeoutMs: 120_000 });
    console.log(`cleared ${cleared} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const afterClear = await report(k, "after clearing, before reorganize");
    const t1 = Date.now();
    await k.query("ALTER INDEX ALL ON events REORGANIZE", [], { timeoutMs: 600_000 });
    console.log(`reorganize took ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    const afterReorg = await report(k, "after clearing and reorganize");
    const t2 = Date.now();
    await k.query("ALTER INDEX ALL ON events REBUILD", [], { timeoutMs: 600_000 });
    console.log(`rebuild took ${((Date.now() - t2) / 1000).toFixed(1)} s`);
    const afterRebuild = await report(k, "after clearing and rebuild");
    // The nightly marginal cost: the index is compact; one more "day" (a tenth of the rows) arrives whole, ages and is cleared.
    const timeReorganize = async (label: string) => { const t = Date.now(); await k.query("ALTER INDEX events_seq ON events REORGANIZE", [], { timeoutMs: 600_000 }); console.log(`${label}: ${((Date.now() - t) / 1000).toFixed(1)} s`); };
    await timeReorganize("reorganize of an already compact index");
    await insert(Math.round(rows / 10));
    const c2 = await clearOldEventDetail(k, Date.now() + 80 * 86_400_000, { batch: 4_000, pauseMs: 0, timeoutMs: 120_000 });
    await timeReorganize(`reorganize after clearing one more day (${c2} events)`);
    await report(k, "after the extra day");
    console.log(JSON.stringify({ rows: total, alertedShare: alerted / total, wholeBytesPerRow: Math.round(full), clearedNoReorgBytesPerRow: Math.round(afterClear),
      clearedReorganizedBytesPerRow: Math.round(afterReorg), clearedRebuiltBytesPerRow: Math.round(afterRebuild) }));
  } finally { await k.end(); }
} finally { await db.drop(); }
