import { createEventInspector } from "./app.mjs";

// Fictional records only. This preview must not be mistaken for fleet data.
const sampleRecords = [
  {
    id: "sample-a",
    cabinet: "CAB-01",
    channel: "Application",
    provider: "Windows Error Reporting",
    level: "Error",
    eventId: 1001,
    occurredAt: "2026-09-29T16:42:00Z",
    message:
      "Sample application stopped responding. No live cabinet was queried.",
  },
  {
    id: "sample-b",
    cabinet: "CAB-01",
    channel: "System",
    provider: "Service Control Manager",
    level: "Warning",
    eventId: 7036,
    occurredAt: "2026-09-29T16:37:00Z",
    message: "Sample service entered a stopped state.",
  },
  {
    id: "sample-c",
    cabinet: "CAB-01",
    channel: "Application",
    provider: "Application Error",
    level: "Error",
    eventId: 1000,
    occurredAt: "2026-09-29T16:31:00Z",
    message:
      "Sample application fault. This message is invented for layout and interaction testing.",
  },
  {
    id: "sample-d",
    cabinet: "CAB-01",
    channel: "System",
    provider: "Microsoft-Windows-Kernel-General",
    level: "Information",
    eventId: 12,
    occurredAt: "2026-09-29T15:12:00Z",
    message: "Sample startup record.",
  },
];
createEventInspector(document, sampleRecords);
