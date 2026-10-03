// Synthetic cabinet fixtures. VEG city labels are public; no customer relationship is asserted.
// IPs are RFC 5737 documentation addresses, never site/network details.
export const clients = Object.freeze([
  { id: 'CL-101', name: 'Veterinary Emergency Group (VEG)' },
  { id: 'CL-202', name: 'Cedar Learning (synthetic)' },
]);
export const sites = Object.freeze([
  { id: 'ST-110', clientId: 'CL-101', name: 'VEG Phoenix', region: 'Arizona', cabinets: [
    { id: 'CAB-01', name: 'Entry cabinet', type: 'Sync', role: 'Sync', location: 'Demo zone A', firewall: 'Enabled (sample)', event: 'Sync retry warning (sample)', ip: '192.0.2.11', peer: 'CAB-02', ping: 'Sample reply', driver: 'Driver inventory: unknown (sample)' },
    { id: 'CAB-02', name: 'Exhibit cabinet', type: 'Satellite', role: 'Satellite', location: 'Demo zone B', firewall: 'Disabled (sample)', event: 'Application restart clue (sample)', ip: '192.0.2.12', peer: 'CAB-01', ping: 'Sample timeout', driver: 'Driver inventory: unknown (sample)' },
  ] },
  { id: 'ST-120', clientId: 'CL-101', name: 'VEG Arrowhead', region: 'Arizona', cabinets: [
    { id: 'CAB-03', name: 'Reception cabinet', type: 'Sync', role: 'Sync', location: 'Demo zone A', firewall: 'Unknown (sample)', event: 'No retained sample event', ip: '192.0.2.21', peer: 'CAB-04', ping: 'Not observed', driver: 'Driver inventory: unknown (sample)' },
  ] },
  { id: 'ST-130', clientId: 'CL-101', name: 'VEG Chandler', region: 'Arizona', cabinets: [
    { id: 'CAB-04', name: 'Reception cabinet', type: 'Satellite', role: 'Satellite', location: 'Demo zone A', firewall: 'Enabled (sample)', event: 'No retained sample event', ip: '192.0.2.31', peer: 'CAB-03', ping: 'Not observed', driver: 'Driver inventory: unknown (sample)' },
  ] },
  { id: 'ST-220', clientId: 'CL-202', name: 'Cedar learning lab', region: 'Synthetic region', cabinets: [
    { id: 'CAB-05', name: 'Lobby cabinet', type: 'Sync', role: 'Sync', location: 'Demo zone A', firewall: 'Unknown (sample)', event: 'No retained sample event', ip: '192.0.2.41', peer: 'None specified', ping: 'Not observed', driver: 'Driver inventory: unknown (sample)' },
  ] },
]);
export const modules = Object.freeze([
  { id: 'identity', title: 'Identity & inventory', summary: 'Proposed bounded cabinet identity and device inventory check.' },
  { id: 'connectivity', title: 'Connectivity', summary: 'Proposed network observation; a failed probe alone cannot identify a cause.' },
  { id: 'events', title: 'Event clues', summary: 'Proposed review of retained, allowlisted event summaries, not raw logs.' },
  { id: 'fingerprint', title: 'Fingerprint', summary: 'Proposed scanner-specific checks. Script and allowlisted output fields are pending review.' },
]);
export const scannerTypes = Object.freeze(['Not specified']);
