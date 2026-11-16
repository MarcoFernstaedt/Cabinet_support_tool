// Named shell frames use the session transport. Durable queues work across API workers.
import { audit, transaction, type Pool, type Tx } from "../db/db.js";
import { closeSessionRecord, lockedSessionRecord, recordSessionRefusal } from "./session-records.js";
import { SessionLifecycle } from "./session-lifecycle.js";
import { Refused } from "./errors.js";
import { envelopes } from "../contracts.js";

export type ShellInput = { kind: "shell.in"; data: string } | { kind: "shell.resize"; columns: number; rows: number } | { kind: "shell.exit" };
export type ShellOutput = { kind: "shell.out"; data: string } | { kind: "shell.exit"; code: number };

/** The log preserves terminal input, including edits/control bytes; it does not claim to parse shell language. */
async function appendInput(tx: Tx, sessionId: string, cabinetId: string, operatorId: string, data: string): Promise<void> {
  const pending = (await tx.query<{ seq: string; input_data: string }>("SELECT TOP (1) seq, input_data FROM session_shell_commands WHERE session_id = $1 AND complete = 0 ORDER BY seq DESC", [sessionId])).rows[0];
  let buffer = Buffer.concat([pending ? Buffer.from(pending.input_data, "base64") : Buffer.alloc(0), Buffer.from(data, "base64")]);
  if (buffer.length > 65536) throw new Refused("shell_line_too_large", 413, "terminal input line exceeds 64 KiB");
  let existing = pending?.seq;
  do {
    const end = buffer.findIndex(b => b === 10 || b === 13);
    const complete = end >= 0;
    const part = complete ? buffer.subarray(0, end + 1) : buffer;
    if (!part.length) break;
    const encoded = part.toString("base64");
    if (existing) await tx.query("UPDATE session_shell_commands SET input_data = $2, complete = $3 WHERE seq = $1", [existing, encoded, complete ? 1 : 0]);
    else await tx.query("INSERT INTO session_shell_commands (session_id, input_data, complete) VALUES ($1, $2, $3)", [sessionId, encoded, complete ? 1 : 0]);
    if (complete) await audit(tx, { actorKind: "user", actorId: operatorId, action: "shell.command", targetKind: "cabinet", targetId: cabinetId,
      outcome: "succeeded", details: { sessionId, input: encoded } });
    existing = undefined;
    buffer = complete ? buffer.subarray(end + 1) : Buffer.alloc(0);
  } while (buffer.length);
}

export class SessionShell {
  private readonly lifecycle: SessionLifecycle;
  constructor(private readonly pool: Pool) { this.lifecycle = new SessionLifecycle(pool, () => undefined); }

  async exchange(cabinetId: string, sessionId: string, side: "agent" | "console", frame: unknown, operatorId?: string): Promise<unknown> {
    const parsed = side === "console" ? envelopes.sessionControl.parse(frame) : envelopes.sessionFrame.parse(frame);
    const kind: string | undefined = "kind" in parsed ? String(parsed.kind) : undefined;
    if (kind === undefined && !(side === "agent" && "data" in parsed && parsed.data === "") && !(side === "console" && "control" in parsed && parsed.control === "keepalive"))
      throw new Refused("shell_frame_required", 400, "a named shell frame is required");
    if ("data" in parsed && Buffer.byteLength(parsed.data, "base64") > 16_384)
      throw new Refused("frame_too_large", 413, "shell frame exceeds 16 KiB");
    try {
      if (!await this.lifecycle.authorize(cabinetId, sessionId, kind !== undefined))
        throw new Refused("not_found", 404, "no live session");
      return await transaction(this.pool, async tx => {
        const row = await lockedSessionRecord(tx, sessionId);
        if (!row || row.cabinet_id !== cabinetId || row.closed_at || row.kind !== "shell" || (side === "console" && row.operator_id !== operatorId))
          throw new Refused("not_found", 404, "no such shell session");
        if (kind) {
          const pending = (await tx.query<{ n: number }>("SELECT COUNT(*) AS n FROM session_shell_frames WHERE session_id = $1 AND direction = $2 AND delivered_at IS NULL", [sessionId, side])).rows[0]!.n;
          if (pending >= 16) throw new Refused("relay_backpressure", 429, "shell queue is full");
          if (side === "console" && kind === "shell.in" && "data" in parsed)
            await appendInput(tx, sessionId, cabinetId, operatorId!, parsed.data);
          // Commit both directions before a byte can be returned to the peer. Partial input survives process death.
          await tx.query("INSERT INTO session_shell_frames (session_id, direction, frame) VALUES ($1, $2, $3)", [sessionId, side, JSON.stringify(parsed)]);
          await audit(tx, { actorKind: side === "console" ? "user" : "agent", actorId: operatorId ?? cabinetId,
            action: kind, targetKind: "cabinet", targetId: cabinetId, outcome: "succeeded", details: { sessionId, frame: parsed } });
        }
        if (side === "agent" && kind === "shell.exit") {
          await closeSessionRecord(tx, sessionId, "explicit", "Shell process exited", { actorKind: "agent", actorId: cabinetId });
          return { control: "close" };
        }
        const next = (await tx.query<{ frame: string }>(`UPDATE session_shell_frames SET delivered_at = SYSUTCDATETIME()
          OUTPUT inserted.frame WHERE seq = (SELECT TOP (1) seq FROM session_shell_frames
          WHERE session_id = $1 AND direction = $2 AND delivered_at IS NULL ORDER BY seq)`, [sessionId, side === "agent" ? "console" : "agent"])).rows[0];
        return next ? (typeof next.frame === "string" ? JSON.parse(next.frame) : next.frame) : side === "agent" ? { control: "keepalive" } : null;
      });
    } catch (e) {
      if (e instanceof Refused) await recordSessionRefusal(this.pool, { actorKind: side === "console" ? "user" : "agent", actorId: operatorId ?? cabinetId }, cabinetId, e.code, sessionId);
      throw e;
    }
  }
}
