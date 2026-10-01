import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createEventInspector } from "../app.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const data = [
  { id: "one", cabinet: "CAB-01", channel: "Application", provider: "Windows Error Reporting", level: "Error", eventId: 1001, occurredAt: "2026-09-29T16:00:00Z", message: "sample" },
  { id: "two", cabinet: "CAB-01", channel: "Application", provider: "Application Error", level: "Error", eventId: 1000, occurredAt: "2026-09-29T15:00:00Z", message: "sample" },
  { id: "three", cabinet: "CAB-01", channel: "System", provider: "Service Control Manager", level: "Warning", eventId: 7036, occurredAt: "2026-09-29T14:00:00Z", message: "sample" },
  { id: "other", cabinet: "CAB-02", channel: "Security", provider: "Security", level: "Warning", eventId: 1, occurredAt: "2026-09-29T13:00:00Z", message: "sample" },
];
function setup() {
  const dom = new JSDOM(html, { url: "http://127.0.0.1/" });
  return { doc: dom.window.document, inspector: createEventInspector(dom.window.document, data) };
}

test("operator can drill into a channel, inspect an event, then narrow to its provider", () => {
  const { doc } = setup();
  const channels = [...doc.querySelectorAll("#channel-nav button")];
  assert.deepEqual(channels.map(x => x.textContent.trim()), ["All channels3", "Application2", "System1"]);
  channels.find(x => x.dataset.channel === "Application").click();
  assert.equal(doc.querySelectorAll("[data-event-id]").length, 2);
  assert.equal(doc.querySelector('[data-channel="Application"]').getAttribute("aria-pressed"), "true");
  doc.querySelector('[data-event-id="one"]').click();
  doc.querySelector("#show-provider-events").click();
  assert.equal(doc.querySelectorAll("[data-event-id]").length, 1);
  assert.match(doc.querySelector("#active-filters").textContent, /Windows Error Reporting/);
  assert.equal(doc.querySelector("#selected-event").hidden, false);
  doc.querySelector("#clear-provider-filter").click();
  assert.equal(doc.querySelectorAll("[data-event-id]").length, 2);
});

test("switching channel clears stale selected details and keeps a useful empty state", () => {
  const { doc } = setup();
  doc.querySelector('[data-event-id="one"]').click();
  doc.querySelector('[data-channel="System"]').click();
  assert.equal(doc.querySelector("#selected-event").hidden, true);
  assert.equal(doc.querySelector("#empty-selection").hidden, false);
  assert.equal(doc.querySelectorAll("[data-event-id]").length, 1);
  assert.equal(doc.querySelector("#show-provider-events").disabled, true);
});

test("cabinet change resets channel and provider navigation without old cabinet records", () => {
  const { doc, inspector } = setup();
  doc.querySelector('[data-event-id="one"]').click();
  doc.querySelector("#show-provider-events").click();
  inspector.setCabinet("CAB-02", data);
  assert.deepEqual([...doc.querySelectorAll("#channel-nav button")].map(x => x.dataset.channel), ["all", "Security"]);
  assert.equal(doc.querySelectorAll("[data-event-id]").length, 1);
  assert.equal(doc.querySelector("#active-filters").textContent.trim(), "");
  assert.equal(doc.querySelector("#selected-event").hidden, true);
});

test("clearing a provider filter returns keyboard focus to search", () => {
  const { doc } = setup();
  doc.querySelector('[data-event-id="one"]').click();
  doc.querySelector("#show-provider-events").click();
  doc.querySelector("#clear-provider-filter").focus();
  doc.querySelector("#clear-provider-filter").click();
  assert.equal(doc.activeElement, doc.querySelector("#event-search"));
});

test("records without a provider cannot create an invisible provider restriction", () => {
  const { doc, inspector } = setup();
  inspector.setCabinet("CAB-01", [{ ...data[0], provider: "" }, data[1]]);
  doc.querySelector('[data-event-id="one"]').click();
  assert.equal(doc.querySelector("#show-provider-events").disabled, true);
  doc.querySelector("#show-provider-events").click();
  assert.equal(doc.querySelectorAll("[data-event-id]").length, 2);
  assert.equal(doc.querySelector("#active-filters").textContent.trim(), "");
});

test("a collected channel literally named all stays distinct from all channels", () => {
  const { doc, inspector } = setup();
  inspector.setCabinet("CAB-01", [{ ...data[0], channel: "all" }, data[1]]);
  const options = [...doc.querySelectorAll("#channel-nav button")];
  assert.equal(options.length, 3);
  options.find(x => x.textContent.trim() === "all1").click();
  assert.deepEqual([...doc.querySelectorAll("[data-event-id]")].map(x => x.dataset.eventId), ["one"]);
  assert.equal(options.filter(x => x.getAttribute("aria-pressed") === "true").length, 1);
});

test("untrusted provider/channel names are rendered as text only", () => {
  const { doc, inspector } = setup();
  inspector.setCabinet("CAB-01", [{ ...data[0], id: "bad", channel: "<img src=x onerror=alert(1)>", provider: "<script>alert(1)</script>" }]);
  assert.equal(doc.querySelector("#channel-nav img"), null);
  doc.querySelector('[data-event-id="bad"]').click();
  doc.querySelector("#show-provider-events").click();
  assert.equal(doc.querySelector("#active-filters script"), null);
});
