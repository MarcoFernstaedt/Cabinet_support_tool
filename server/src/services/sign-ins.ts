// What people can see about sign-ins: their own recent ones, every account's for an Admin, and the one a session started with.
import type { Queryable } from "../db/db.js";

export interface SignInRow {
  id: number; at: string; username: string; name: string; address: string; network: string; device: string; newNetwork: boolean; newDevice: boolean; completed: boolean;
}

const COLUMNS = `s.id, s.[at], u.username, u.name, s.address, s.network, s.device_label, s.new_network, s.new_device, s.completed`;
type Raw = { id: string; at: Date; username: string; name: string; address: string; network: string; device_label: string; new_network: boolean; new_device: boolean; completed: boolean };
const shape = (r: Raw): SignInRow => ({ id: Number(r.id), at: r.at.toISOString(), username: r.username, name: r.name, address: r.address, network: r.network,
  device: r.device_label, newNetwork: r.new_network, newDevice: r.new_device, completed: r.completed });

/** One person's most recent sign-ins, newest first. */
export async function ownSignIns(db: Queryable, userId: string, limit = 30): Promise<SignInRow[]> {
  return (await db.query<Raw>(`SELECT TOP ($2) ${COLUMNS} FROM sign_ins s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1 ORDER BY s.[at] DESC, s.id DESC`, [userId, limit])).rows.map(shape);
}

/** Every account's recent sign-ins for an Admin; "new" keeps only those from a network or device the account had not used before. */
export async function allSignIns(db: Queryable, scope: "all" | "new", limit = 200): Promise<SignInRow[]> {
  return (await db.query<Raw>(
    `SELECT TOP ($1) ${COLUMNS} FROM sign_ins s JOIN users u ON u.id = s.user_id ${scope === "new" ? "WHERE s.new_network = 1 OR s.new_device = 1" : ""} ORDER BY s.[at] DESC, s.id DESC`, [limit])).rows.map(shape);
}

/** The sign-in a session started with, so the console can say "this sign-in is from a new device". */
export async function sessionSignIn(db: Queryable, sessionHash: Buffer): Promise<SignInRow | null> {
  const r = (await db.query<Raw>(
    `SELECT ${COLUMNS} FROM sessions x JOIN sign_ins s ON s.id = x.sign_in_id JOIN users u ON u.id = s.user_id WHERE x.id_hash = $1`, [sessionHash])).rows[0];
  return r ? shape(r) : null;
}
