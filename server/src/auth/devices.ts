// Which browser a sign-in came from. The first time an account signs in from a browser, the server gives it a random device value in a
// cookie and keeps only its hash; a later sign-in with a value the account has not used is a "new device", shown to the person and to Admins.
import { createHash, randomBytes } from "node:crypto";
import { isUniqueViolation, type Queryable } from "../db/db.js";
import { networkOf, raiseSecurityAlert } from "../services/security.js";

export const DEVICE_MAX_AGE_SECONDS = 400 * 24 * 3600;
const DEVICE_VALUE = /^[A-Za-z0-9_-]{43}$/;
const hashDevice = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** "Chrome on Windows": the browser and system named in the User-Agent, nothing else (it is a label, not a fingerprint). */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = (userAgent ?? "").slice(0, 400);
  const browser = ua.includes("Edg/") ? "Edge" : ua.includes("OPR/") ? "Opera" : ua.includes("Firefox/") ? "Firefox" : ua.includes("Chrome/") ? "Chrome"
    : ua.includes("Safari/") ? "Safari" : "A browser";
  const system = ua.includes("Windows") ? "Windows" : ua.includes("Android") ? "Android" : ua.includes("iPhone") || ua.includes("iPad") ? "iOS"
    : ua.includes("Mac OS X") ? "macOS" : ua.includes("CrOS") ? "ChromeOS" : ua.includes("Linux") ? "Linux" : "an unknown system";
  return `${browser} on ${system}`;
}

/** Whether this browser's device value is one the account has already signed in with. */
export async function isKnownDevice(db: Queryable, userId: string, deviceCookie: string | undefined): Promise<boolean> {
  if (!deviceCookie || !DEVICE_VALUE.test(deviceCookie)) return false;
  return (await db.query("SELECT TOP (1) 1 AS known FROM user_devices WHERE user_id = $1 AND device_hash = $2", [userId, hashDevice(deviceCookie)])).rows.length > 0;
}

export interface SignIn { signInId: number; deviceValue: string; newNetwork: boolean; newDevice: boolean }

/**
 * Records a sign-in that got past the password: the network and device, whether each is new, and a security alert for a network or device
 * the account has not used before (not for its very first one, which has nothing to compare with).
 */
export async function recordSignIn(db: Queryable, a: { userId: string; username: string; address: string; userAgent: string | undefined; deviceCookie: string | undefined }): Promise<SignIn> {
  const network = networkOf(a.address);
  const label = deviceLabel(a.userAgent);
  const value = a.deviceCookie && DEVICE_VALUE.test(a.deviceCookie) ? a.deviceCookie : randomBytes(32).toString("base64url");
  const knownNetworks = (await db.query<{ network: string }>("SELECT network FROM user_networks WHERE user_id = $1", [a.userId])).rows;
  const knownDevices = Number((await db.query<{ n: string }>("SELECT COUNT(*) AS n FROM user_devices WHERE user_id = $1", [a.userId])).rows[0]!.n);
  const seen = (await db.query("UPDATE user_devices SET last_seen = SYSUTCDATETIME() WHERE user_id = $1 AND device_hash = $2", [a.userId, hashDevice(value)])).rowCount >= 1;
  // Two sign-ins racing with a new device both insert it at most once (the MERGE holds the key range); a unique rule, if the schema has one, is the second guard.
  if (!seen)
    await db.query(`MERGE user_devices WITH (HOLDLOCK) AS t USING (SELECT CAST($1 AS uniqueidentifier) AS user_id, $2 AS device_hash) AS s ON t.user_id = s.user_id AND t.device_hash = s.device_hash
                    WHEN NOT MATCHED THEN INSERT (user_id, device_hash, label) VALUES (s.user_id, s.device_hash, $3);`, [a.userId, hashDevice(value), label]).catch(e => { if (!isUniqueViolation(e)) throw e; });
  await db.query(`MERGE user_networks WITH (HOLDLOCK) AS t USING (SELECT CAST($1 AS uniqueidentifier) AS user_id, $2 AS network) AS s ON t.user_id = s.user_id AND t.network = s.network
                  WHEN MATCHED THEN UPDATE SET last_seen = SYSUTCDATETIME()
                  WHEN NOT MATCHED THEN INSERT (user_id, network) VALUES (s.user_id, s.network);`, [a.userId, network]).catch(e => { if (!isUniqueViolation(e)) throw e; });
  const newNetwork = knownNetworks.length > 0 && !knownNetworks.some(k => k.network === network);
  const newDevice = knownDevices > 0 && !seen;
  if (newNetwork)
    await raiseSecurityAlert(db, { kind: "new_location", signature: `new_location|${a.userId}|${network}`, userId: a.userId,
      title: `${a.username} signed in from a network not used before`, detail: { network, address: a.address, knownNetworks: knownNetworks.map(k => k.network).slice(0, 10) } });
  if (newDevice)
    await raiseSecurityAlert(db, { kind: "new_device", signature: `new_device|${a.userId}|${hashDevice(value).toString("hex").slice(0, 16)}`, userId: a.userId,
      title: `${a.username} signed in from a device not used before (${label})`, detail: { device: label, network, address: a.address } });
  const id = (await db.query<{ id: string }>(
    "INSERT INTO sign_ins (user_id, address, network, device_label, new_network, new_device) OUTPUT inserted.id VALUES ($1, $2, $3, $4, $5, $6)",
    [a.userId, a.address.slice(0, 64), network, label, newNetwork, newDevice])).rows[0]!.id;
  return { signInId: Number(id), deviceValue: value, newNetwork, newDevice };
}
