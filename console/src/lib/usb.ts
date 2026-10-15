// USB ports: which hub and port each device is on, what is connected now, and what is wrong. The fingerprint scanner is picked out so a call
// about a scanner that "doesn't show" can be answered from the port it was last seen on. Plain comparisons of fields; no text patterns.
export interface UsbDevice {
  instanceId: string; name: string; kind: "hub" | "device"; location: string | null; hubNumber: number | null; portNumber: number | null;
  present: boolean; status: string; errorCode: number | null; errorText: string | null; hardwareIds: string[];
}
export type Tone = "ok" | "warn" | "crit" | "info";
export interface UsbRow { device: UsbDevice; scanner: boolean; state: "connected" | "not_connected" | "problem"; tone: Tone; note: string | null; where: string }
export interface UsbIssue { tone: Tone; text: string }
export interface UsbAnalysis { rows: UsbRow[]; issues: UsbIssue[]; tone: Tone; summary: string; scanner: UsbRow | null; portsInUse: string[] }

const SCANNER_WORDS = ["fingerprint", "biometric", "finger print"];

/** Hub and port in words: "hub 3, port 2"; the root hub and devices with no location text have none. */
export const whereText = (d: UsbDevice) => d.hubNumber === null && d.portNumber === null ? "no port reported"
  : `hub ${d.hubNumber ?? "?"}, port ${d.portNumber ?? "?"}`;

const isScanner = (d: UsbDevice, ids: string[], name: string | null): boolean => {
  const have = new Set(d.hardwareIds.map(h => h.toLowerCase()));
  if (ids.some(i => have.has(i.toLowerCase()))) return true;
  if (name && d.name.toLowerCase() === name.toLowerCase()) return true;
  const n = d.name.toLowerCase();
  return SCANNER_WORDS.some(w => n.includes(w));
};

/** `scannerIds` are the scanner's hardware IDs as the console knows them; `scannerName` is the name from the scanner check, when it found one. */
export function analyseUsb(devices: UsbDevice[], scannerIds: string[] = [], scannerName: string | null = null, truncated = false): UsbAnalysis {
  const rows: UsbRow[] = devices.map(device => {
    const scanner = device.kind === "device" && isScanner(device, scannerIds, scannerName);
    const problem = device.present && device.errorCode !== null && device.errorCode > 0;
    const state: UsbRow["state"] = problem ? "problem" : device.present ? "connected" : "not_connected";
    const tone: Tone = problem ? "crit" : !device.present ? (scanner ? "crit" : "info") : "ok";
    const note = problem ? `Code ${device.errorCode}${device.errorText ? `: ${device.errorText}` : ""}` : !device.present ? (scanner ? "Not connected now. Last seen on this port." : "Remembered by Windows, not connected now.") : null;
    return { device, scanner, state, tone, note, where: whereText(device) };
  }).sort((a, b) => (a.device.hubNumber ?? -1) - (b.device.hubNumber ?? -1) || (a.device.portNumber ?? -1) - (b.device.portNumber ?? -1) || a.device.name.localeCompare(b.device.name));

  const issues: UsbIssue[] = [];
  const scanner = rows.find(r => r.scanner && r.device.present) ?? rows.find(r => r.scanner) ?? null;
  if (!scanner) issues.push({ tone: "crit", text: "No fingerprint scanner is on any USB port, and Windows has no record of one. Check the cable at both ends and try another port; if it never appears, the scanner or its cable is faulty." });
  else if (scanner.state === "not_connected") issues.push({ tone: "crit", text: `The scanner is not on any port now. It was last on ${scanner.where}. Have them reseat the cable, move it to a different port, or swap the cable.` });
  else if (scanner.state === "problem") issues.push({ tone: "crit", text: `The scanner is on ${scanner.where} but Windows reports ${(scanner.note ?? "").endsWith(".") ? (scanner.note ?? "").slice(0, -1) : scanner.note}. Move it to a different port or replace the cable.` });
  for (const r of rows) {
    if (r.scanner) continue;
    if (r.state === "problem") issues.push({ tone: "crit", text: `${r.device.name} on ${r.where}: ${(r.note ?? "").endsWith(".") ? (r.note ?? "").slice(0, -1) : r.note}. ${r.device.kind === "hub" ? "A hub with a problem takes every device behind it down." : "A device that fails to start on a port usually points to the cable or the port."}` });
  }
  const forgotten = rows.filter(r => r.state === "not_connected" && !r.scanner && r.device.kind === "device").length;
  if (truncated) issues.push({ tone: "warn", text: "The list was cut short; ports further down are not shown." });
  const order: Tone[] = ["ok", "info", "warn", "crit"];
  const tone = issues.reduce<Tone>((t, i) => (order.indexOf(i.tone) > order.indexOf(t) ? i.tone : t), "ok");
  const portsInUse = rows.filter(r => r.device.present && r.device.kind === "device" && r.device.portNumber !== null).map(r => `${r.where}: ${r.device.name}`);
  const summary = issues.find(i => i.tone === "crit")?.text ?? issues[0]?.text
    ?? `${scanner ? `Scanner connected on ${scanner.where}. ` : ""}${rows.filter(r => r.device.present && r.device.kind === "device").length} devices connected, no port problems${forgotten ? `; ${forgotten} remembered but not connected` : ""}.`;
  return { rows, issues, tone, summary, scanner, portsInUse };
}
