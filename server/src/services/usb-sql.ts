// The USB layer's SQL, kept as data in a module that imports nothing but the pure policy module.
//
// Why it is here and not inline in usb-store.ts: usb-store.ts is the one file in the layer that imports the SQL driver,
// so anything it holds can only be exercised against a live SQL Server. A statement and its parameters kept here can be
// checked against migrations/0001_baseline.sql by usb-sql.test.ts, with no database and no cabinet — which is what
// catches a column that does not exist (cabinets has no removed_at; the migration marks it with status = 'removed') and
// a placeholder with no parameter behind it.
//
// The keys written here are the ones usb-policy.ts builds, so the four joins below and the writes in usb-store.ts agree
// on one spelling: `usb.policy` for the fleet, `usb.policy.<level>.<lowercased id>` otherwise.
import { USB_POLICY_SETTING_KEY, usbPolicySettingKey, type UsbScopeLevel } from "./usb-policy.js";

/** Every USB incident's alert signature starts with this; usb-rules.ts's usbIncidentKey() is the other half of it. */
export const USB_INCIDENT_SIGNATURE_PREFIX = "usb:";

/**
 * The four policy rows for one cabinet in a single read, which is what runs on every heartbeat: the cabinet's own
 * policy, its site's, its client's and the fleet's. Ids are lowered on both sides of every key.
 */
export const usbPolicyLevelsSql = `SELECT k.[value] AS cabinet, s.[value] AS site, c.[value] AS client, f.[value] AS fleet,
          LOWER(CONVERT(nvarchar(64), cab.site_id)) AS site_id, LOWER(CONVERT(nvarchar(64), sit.client_id)) AS client_id
     FROM cabinets cab
     JOIN sites sit ON sit.id = cab.site_id
     LEFT JOIN settings k ON k.[key] = $2 + N'.cabinet.' + LOWER(CONVERT(nvarchar(64), cab.id))
     LEFT JOIN settings s ON s.[key] = $2 + N'.site.' + LOWER(CONVERT(nvarchar(64), cab.site_id))
     LEFT JOIN settings c ON c.[key] = $2 + N'.client.' + LOWER(CONVERT(nvarchar(64), sit.client_id))
     LEFT JOIN settings f ON f.[key] = $2
    WHERE cab.id = $1`;

/** `$1` the cabinet, `$2` the fleet key the per-level keys are built on. */
export const usbPolicyLevelsParams = (cabinetId: string): readonly unknown[] => [cabinetId, USB_POLICY_SETTING_KEY];

/**
 * Whether an id is a live scope. A removed client or site carries a removed_at timestamp; a cabinet carries no such
 * column — the migration marks a removed cabinet with status = 'removed' — so the two shapes differ on purpose.
 */
export const usbScopeExistsSql: Readonly<Record<"client" | "site" | "cabinet", string>> = {
  client: "SELECT 1 AS ok FROM clients WHERE id = $1 AND removed_at IS NULL",
  site: "SELECT 1 AS ok FROM sites WHERE id = $1 AND removed_at IS NULL",
  cabinet: "SELECT 1 AS ok FROM cabinets WHERE id = $1 AND status <> 'removed'",
};

/** `$1` the scope id. */
export const usbScopeExistsParams = (scopeId: string): readonly unknown[] => [scopeId];

/** One scope's stored document, as text, or no row at all. */
export const usbPolicyRowSql = "SELECT [value] FROM settings WHERE [key] = $1";

/** `$1` the scope's settings key. */
export const usbPolicyRowParams = (level: UsbScopeLevel, scopeId: string | null): readonly unknown[] => [usbPolicySettingKey(level, scopeId)];

/** Clears a scope's stored document, which puts the broader scope back in force. */
export const usbPolicyDeleteSql = "DELETE FROM settings WHERE [key] = $1";

/** `$1` the scope's settings key. */
export const usbPolicyDeleteParams = (level: UsbScopeLevel, scopeId: string | null): readonly unknown[] => [usbPolicySettingKey(level, scopeId)];

/** The three issue types the rules raise, by key. A rule whose key is missing here cannot open an alert. */
export const usbIssueCatalogSql = "SELECT [key], [id], [name], [severity] FROM issue_types WHERE [key] IN ('usb_missing', 'usb_flap', 'usb_dependency')";

/** No parameters. */
export const usbIssueCatalogParams = (): readonly unknown[] => [];

/** The USB incidents a cabinet is already carrying, so a repeat updates its own row instead of opening another. */
export const usbOpenIncidentsSql = `SELECT a.signature, a.severity, a.occurrences, a.last_seen
     FROM alerts a
    WHERE a.cabinet_id = $1 AND a.signature LIKE '${USB_INCIDENT_SIGNATURE_PREFIX}%' AND a.state <> 'resolved'`;

/** `$1` the cabinet. */
export const usbOpenIncidentsParams = (cabinetId: string): readonly unknown[] => [cabinetId];

/**
 * Closes one USB incident whose condition is gone. Shaped like alerts.ts's resolveOfflineFor(): state, resolved_at and
 * resolution in one update, over the open rows only, seeking by cabinet and signature.
 */
export const usbResolveIncidentSql = `UPDATE a SET state = 'resolved', resolved_at = SYSUTCDATETIME(), resolution = $3
                FROM alerts a WITH (FORCESEEK)
               WHERE a.cabinet_id = $1 AND a.signature = $2 AND a.state <> 'resolved'`;

/** `$1` the cabinet, `$2` the incident's signature, `$3` the resolution text the operator will read. */
export const usbResolveIncidentParams = (cabinetId: string, signature: string, resolution: string | null): readonly unknown[] => [cabinetId, signature, resolution];
