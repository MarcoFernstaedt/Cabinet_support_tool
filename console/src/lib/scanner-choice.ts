import { entryKey } from "./approved-apps.ts";

// The fingerprint scanner choice as the console builds it from what a person typed (components/ClientScanner.tsx). The server checks it again.

export interface ScannerChoice {
  enabled: boolean;
  service?: { key: string; kind: "service"; name: string; path: string; serviceName: string };
  hardwareIds?: string[] | null;
}
export interface ClientScannerState { enabled: boolean; service: string | null; approval: "approved" | "waiting" | "missing" | null }

/** The fields a person fills in to switch the scanner on, as typed. */
export interface ScannerFields { name: string; serviceName: string; path: string; hardwareIds: string }
export const EMPTY_FIELDS: ScannerFields = { name: "Fingerprint scanner", serviceName: "", path: "", hardwareIds: "" };

/** The choice the fields describe, or null while they are incomplete. The approved-list key follows the approved-programs editor's rule (app: and the name). */
export function choiceFrom(f: ScannerFields): ScannerChoice | null {
  const serviceName = f.serviceName.trim(), path = f.path.trim(), name = f.name.trim();
  if (!serviceName || !path || !name) return null;
  const ids = f.hardwareIds.split(",").map(s => s.trim()).filter(Boolean);
  return { enabled: true, service: { key: entryKey(name), kind: "service", name, path, serviceName },
    ...(ids.length > 0 ? { hardwareIds: ids } : {}) };
}

