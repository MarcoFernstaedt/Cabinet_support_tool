// Kept apart from automatic-close.ts so the SQL-only modules (usb-sql.ts) can use it without importing the database driver.
/**
 * The OUTPUT clause every automatic close of alerts carries, so closeAutomatically can audit each row it closed. alerts has a trigger, and
 * SQL Server refuses OUTPUT without INTO on such a table, hence the table variable closeAutomatically declares.
 */
export const CLOSED_OUTPUT = "OUTPUT inserted.id, inserted.cabinet_id, inserted.resolution INTO @closed (id, cabinet_id, resolution)";
