// Case notes: who did what to a cabinet, in the person's words, on the cabinet and optionally tied to one of its alerts (docs/spec/13-roadmap.md
// module 16). Append-only: a note is never edited (the database refuses it); an Admin can remove the text of one, with a reason, when a
// password or personal data was pasted into it, and the note, its author and the redaction stay. Resolving an alert writes one too (alerts.ts).
import { randomUUID } from "node:crypto";
import { audit, type Pool, type Queryable, type Tx } from "../db/db.js";
import type { CaseNoteCreate } from "../contracts.js";
import { Refused } from "./errors.js";

/** A cabinet keeps at most this many notes; an alert that needs more is a sign the notes should be a ticket. */
export const MAX_NOTES_PER_CABINET = 500;
/** One person adds at most this many notes an hour (a runaway script, not a busy afternoon). */
export const MAX_NOTES_PER_HOUR = 60;

type Row = { id: string; cabinet_id: string; alert_id: string | null; author_id: string; author: string; kind: string; body: string; created_at: Date;
  redacted_at: Date | null; redacted_by_name: string | null; redacted_reason: string | null; alert_title: string | null };
const SELECT = `SELECT n.id, n.cabinet_id, n.alert_id, n.author_id, u.name AS author, n.kind, n.body, n.created_at, n.redacted_at, rb.name AS redacted_by_name, n.redacted_reason, a.title AS alert_title
  FROM case_notes n JOIN users u ON u.id = n.author_id LEFT JOIN users rb ON rb.id = n.redacted_by LEFT JOIN alerts a ON a.id = n.alert_id`;

export const noteView = (r: Row) => ({
  id: r.id, cabinetId: r.cabinet_id, alertId: r.alert_id, alertTitle: r.alert_title, author: { id: r.author_id, name: r.author }, kind: r.kind,
  // A removed note keeps its place but not its text.
  body: r.redacted_at ? null : r.body, createdAt: r.created_at.toISOString(),
  redacted: r.redacted_at ? { at: r.redacted_at.toISOString(), by: r.redacted_by_name, reason: r.redacted_reason } : null,
});
export type CaseNoteView = ReturnType<typeof noteView>;

/** Writes a note inside the caller's transaction (resolving an alert does); the checks that need the whole table are the caller's. */
export async function insertNote(c: Tx, n: { cabinetId: string; alertId: string | null; authorId: string; kind: "note" | "resolution"; body: string }): Promise<string> {
  const id = randomUUID();
  await c.query("INSERT INTO case_notes (id, cabinet_id, alert_id, author_id, kind, body) VALUES ($1, $2, $3, $4, $5, $6)", [id, n.cabinetId, n.alertId, n.authorId, n.kind, n.body.slice(0, 2000)]);
  return id;
}

export async function addNote(pool: Pool, userId: string, cabinetId: string, b: CaseNoteCreate): Promise<CaseNoteView> {
  const id = await pool.transaction(async c => {
    if ((await c.query("SELECT 1 FROM cabinets WHERE id = $1 AND status = 'active'", [cabinetId])).rowCount !== 1) throw new Refused("not_found", 404, "no such cabinet");
    // The alert must be this cabinet's own, so a note cannot be hung on another cabinet's alert.
    if (b.alertId && (await c.query("SELECT 1 FROM alerts WHERE id = $1 AND cabinet_id = $2", [b.alertId, cabinetId])).rowCount !== 1) throw new Refused("not_found", 404, "no such alert on this cabinet");
    const recent = Number((await c.query<{ n: number }>("SELECT COUNT(*) AS n FROM case_notes WHERE author_id = $1 AND created_at > DATEADD(hour, -1, SYSUTCDATETIME())", [userId])).rows[0]!.n);
    if (recent >= MAX_NOTES_PER_HOUR) throw new Refused("rate_limited", 429, "you have added a lot of notes in the last hour; wait a little");
    const total = Number((await c.query<{ n: number }>("SELECT COUNT(*) AS n FROM case_notes WHERE cabinet_id = $1", [cabinetId])).rows[0]!.n);
    if (total >= MAX_NOTES_PER_CABINET) throw new Refused("too_many_notes", 409, "this cabinet already has the most notes it can hold; ask an Admin");
    const noteId = await insertNote(c, { cabinetId, alertId: b.alertId ?? null, authorId: userId, kind: "note", body: b.body });
    // The note's text stays out of the audit log (it is free text); its length and what it hangs on are recorded.
    await audit(c, { actorKind: "user", actorId: userId, action: "case_note.add", targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded", details: { noteId, alertId: b.alertId ?? null, length: b.body.length } });
    return noteId;
  });
  return noteView((await pool.query<Row>(`${SELECT} WHERE n.id = $1`, [id])).rows[0]!);
}

/** A cabinet's notes, newest first (at most 200), or only those tied to one alert. */
export async function listNotes(db: Queryable, cabinetId: string, alertId?: string): Promise<CaseNoteView[]> {
  return (await db.query<Row>(`${SELECT} WHERE n.cabinet_id = $1 AND ($2 IS NULL OR n.alert_id = CAST($2 AS uniqueidentifier)) ORDER BY n.created_at DESC OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY`,
    [cabinetId, alertId ?? null])).rows.map(noteView);
}

/** An Admin removes a note's text. Done once; the audit entry says who and why. */
export async function redactNote(pool: Pool, adminId: string, noteId: string, reason: string): Promise<CaseNoteView> {
  await pool.transaction(async c => {
    const r = await c.query("UPDATE case_notes SET body = N'', redacted_at = SYSUTCDATETIME(), redacted_by = $2, redacted_reason = $3 WHERE id = $1 AND redacted_at IS NULL", [noteId, adminId, reason]);
    if (r.rowCount !== 1) {
      const exists = (await c.query("SELECT 1 FROM case_notes WHERE id = $1", [noteId])).rowCount === 1;
      throw new Refused(exists ? "already_removed" : "not_found", exists ? 409 : 404, exists ? "this note's text was already removed" : "no such note");
    }
    const cabinet = (await c.query<{ cabinet_id: string }>("SELECT cabinet_id FROM case_notes WHERE id = $1", [noteId])).rows[0]!.cabinet_id;
    await audit(c, { actorKind: "user", actorId: adminId, action: "case_note.redact", targetKind: "cabinet", targetId: cabinet, outcome: "succeeded", details: { noteId, reason } });
  });
  return noteView((await pool.query<Row>(`${SELECT} WHERE n.id = $1`, [noteId])).rows[0]!);
}
