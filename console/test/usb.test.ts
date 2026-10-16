import test from "node:test";
import assert from "node:assert/strict";
import { analyseUsb, whereText, type UsbDevice } from "../src/lib/usb.ts";

const dev = (o: Partial<UsbDevice> = {}): UsbDevice => ({ instanceId: "USB\\VID_27C6&PID_5395\\1", name: "Goodix Fingerprint Device", kind: "device", location: "Port_#0002.Hub_#0003",
  hubNumber: 3, portNumber: 2, present: true, status: "OK", errorCode: null, errorText: null, hardwareIds: ["USB\\VID_27C6&PID_5395"], ...o });
const hub = (o: Partial<UsbDevice> = {}) => dev({ instanceId: "USB\\ROOT_HUB30\\1", name: "USB Root Hub", kind: "hub", location: null, hubNumber: null, portNumber: null, hardwareIds: [], ...o });
const key = dev({ instanceId: "USB\\VID_046D&PID_C31C\\2", name: "USB Input Device", portNumber: 3, hardwareIds: ["USB\\VID_046D&PID_C31C"] });

test("a scanner on a port with no problems is fine and names its port", () => {
  const a = analyseUsb([hub(), dev(), key], ["USB\\VID_27C6&PID_5395"]);
  assert.equal(a.tone, "ok"); assert.equal(a.scanner?.where, "hub 3, port 2"); assert.match(a.summary, /hub 3, port 2/);
});

test("the scanner is found by hardware ID, by name, or by the words in its name", () => {
  assert.equal(analyseUsb([dev({ name: "Reader", hardwareIds: ["USB\\X"] })], ["usb\\x"]).scanner?.device.name, "Reader");
  assert.equal(analyseUsb([dev({ name: "Reader", hardwareIds: [] })], [], "reader").scanner?.device.name, "Reader");
  assert.equal(analyseUsb([dev({ name: "Fingerprint Reader", hardwareIds: [] })]).scanner?.device.name, "Fingerprint Reader");
  assert.equal(analyseUsb([key]).scanner, null);
});

test("a scanner Windows remembers but is not connected points at its last port", () => {
  const a = analyseUsb([hub(), dev({ present: false, status: "Not connected" }), key], ["USB\\VID_27C6&PID_5395"]);
  assert.equal(a.tone, "crit"); assert.match(a.summary, /last on hub 3, port 2/); assert.match(a.summary, /different port|swap the cable/);
});

test("no scanner anywhere is a problem", () => { assert.equal(analyseUsb([hub(), key]).tone, "crit"); });

test("a device that fails to start on a port is named with its port and code", () => {
  const bad = dev({ instanceId: "USB\\VID_0000&PID_0002\\3", name: "Unknown USB Device (Device Descriptor Request Failed)", portNumber: 4, hardwareIds: [], status: "Error", errorCode: 43, errorText: "Windows stopped this device." });
  const a = analyseUsb([hub(), dev(), bad]);
  assert.equal(a.tone, "crit"); assert.ok(a.issues.some(i => i.text.includes("hub 3, port 4") && i.text.includes("43")));
});

test("a hub with a problem says every device behind it is down", () => {
  const a = analyseUsb([hub({ errorCode: 10, errorText: "cannot start", status: "Error" }), dev()]);
  assert.ok(a.issues.some(i => i.text.includes("every device behind it")));
});

test("remembered devices that are gone are not an alarm", () => {
  const a = analyseUsb([hub(), dev(), dev({ instanceId: "USB\\OLD\\1", name: "Old stick", present: false, hardwareIds: [], portNumber: 5 })]);
  assert.equal(a.tone, "ok"); assert.match(a.summary, /1 remembered/);
});

test("a cut-off list warns, and rows are in hub and port order", () => {
  const a = analyseUsb([dev({ instanceId: "b", name: "B", portNumber: 4, hardwareIds: [] }), dev({ instanceId: "a", name: "A", portNumber: 1, hardwareIds: [] }), dev()], [], null, true);
  assert.ok(a.issues.some(i => i.tone === "warn"));
  assert.deepEqual(a.rows.map(r => r.device.portNumber), [1, 2, 4]);
});

test("odd or hostile device records do not break the analysis", () => {
  const evil = dev({ name: "<img src=x onerror=alert(1)>\n".repeat(50), hubNumber: null, portNumber: null, location: null, hardwareIds: ["", "\u0000"], errorCode: 4294967295 });
  const a = analyseUsb([evil, hub()], ["", "x"], "");
  assert.ok(a.rows.length === 2);
  assert.equal(whereText(evil), "no port reported");
  assert.doesNotThrow(() => analyseUsb([]));
});

test("devices are placed in a class by the words in their names, hubs by kind, and printers are not a class", async () => {
  const { deviceClass, groupByClass, DEVICE_CLASSES } = await import("../src/lib/usb.ts");
  const d = (name: string, kind: "hub" | "device" = "device") => ({ name, kind });
  assert.equal(deviceClass(d("Goodix Fingerprint Device")), "Fingerprint scanner");
  assert.equal(deviceClass(d("USB Ethernet Adapter (drawer link)")), "Network adapter");
  assert.equal(deviceClass(d("HID-compliant mouse")), "Keyboard and mouse");
  assert.equal(deviceClass(d("USB Input Device")), "Keyboard and mouse");
  assert.equal(deviceClass(d("Honeywell Barcode Scanner")), "Barcode scanner");
  assert.equal(deviceClass(d("Generic Flash Disk")), "Storage");
  assert.equal(deviceClass(d("USB Root Hub", "hub")), "Hub");
  assert.equal(deviceClass(d("HP LaserJet 1020")), "Other");
  assert.equal(deviceClass(d("")), "Other");
  assert.ok(!DEVICE_CLASSES.some(c => c.toLowerCase().includes("printer")));
  const rows = analyseUsb([hub(), dev(), key]).rows;
  assert.deepEqual(groupByClass(rows).map(g => g.cls), ["Fingerprint scanner", "Keyboard and mouse", "Hub"]);
  assert.equal(groupByClass(rows).reduce((n, g) => n + g.rows.length, 0), rows.length, "every device is in exactly one group");
});
