// Fictional presentation fixtures. No addresses, customer identities or measurements.
export const sites = Object.freeze([
  { id: "harbor", name: "Harbor Arcade", region: "North district", cabinets: [
    { id: "CAB-01", name: "Atrium scanner", type: "Scanner A", location: "Entrance hall" },
    { id: "CAB-02", name: "Gallery scanner", type: "Scanner B", location: "Gallery wing" },
  ] },
  { id: "orchard", name: "Orchard Exhibit", region: "West district", cabinets: [
    { id: "CAB-03", name: "Lobby scanner", type: "Scanner C", location: "Lobby" },
  ] },
]);

// Diagnostic composition is a proposed information architecture, not an action catalog.
export const modules = Object.freeze([
  { id: "identity", title: "Identity & inventory", summary: "Proposed bounded cabinet identity and device inventory check." },
  { id: "connectivity", title: "Connectivity", summary: "Proposed network observation; a failed probe alone cannot identify a cause." },
  { id: "events", title: "Event clues", summary: "Proposed review of retained, allowlisted event summaries, not raw logs." },
  { id: "fingerprint", title: "Fingerprint", summary: "Proposed scanner-specific checks. Script and allowlisted output fields are pending review." },
]);
export const scannerTypes = Object.freeze(["Scanner A", "Scanner B", "Scanner C"]);
