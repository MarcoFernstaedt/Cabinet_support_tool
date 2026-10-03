import { clients, sites, modules } from "./demo-data.mjs";

const doc = document;
const view = doc.querySelector("#view");
let query = "";
let selectedModule = "all";
let demoStaffTier = "Tier 1";
const demoClients = clients.map(item => ({ ...item }));
const demoSites = sites.map(item => ({ ...item, cabinets: item.cabinets.map(cabinet => ({ ...cabinet })) }));
let demoRequest = null;

function el(tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function link(text, href, className = "") {
  const a = el("a", className, text);
  a.href = href;
  return a;
}
function cabinetFor(id) {
  for (const site of demoSites) {
    const cabinet = site.cabinets.find(item => item.id === id);
    if (cabinet) return { cabinet, site };
  }
  return null;
}
function heading(eyebrow, title, description) {
  const head = el("div", "page-head");
  head.append(el("p", "eyebrow", eyebrow), el("h1", "", title), el("p", "lede", description));
  return head;
}
function renderFinder() {
  doc.title = "Demo · Cabinet finder";
  doc.querySelector("#breadcrumb").textContent = "Finder";
  view.replaceChildren(heading("01 / DISCOVER", "Demo", "Find a cabinet across synthetic clients and sites. Search filters this local sample only; no device is connected."));
  const box = el("section", "panel finder");
  const label = el("label", "field-label", "Search cabinets or sites");
  label.htmlFor = "finder-search";
  const input = el("input", "search");
  input.id = "finder-search";
  input.type = "search";
  label.textContent = "Search client, site or cabinet ID / name";
  input.placeholder = "Try CL-101, ST-110 or CAB-02";
  input.autocomplete = "off";
  input.value = query;
  const count = el("p", "muted");
  count.id = "finder-count";
  count.setAttribute("role", "status");
  const results = el("div", "site-list");
  box.append(label, input, count, results);
  view.append(box);
  function update() {
    query = input.value;
    const needle = query.trim().toLocaleLowerCase();
    results.replaceChildren();
    let total = 0;
    for (const site of demoSites) {
      const client = demoClients.find(item => item.id === site.clientId);
      const cabinets = site.cabinets.filter(cabinet => [client.id, client.name, site.id, site.name, site.region, cabinet.name, cabinet.id, cabinet.role, cabinet.location].some(value => value.toLocaleLowerCase().includes(needle)));
      if (!cabinets.length) continue;
      total += cabinets.length;
      const group = el("section", "site-group");
      group.append(el("h2", "", `${client.name} / ${site.name}`), el("p", "muted", `${client.id} · ${site.id} · ${site.region} · Demo site`));
      const rows = el("div", "rows");
      for (const cabinet of cabinets) {
        const row = link("", `#cabinet/${cabinet.id}`, "cabinet-row");
        const names = el("span");
        names.append(el("strong", "", cabinet.name), el("small", "", `${cabinet.id} · ${cabinet.role} · ${cabinet.location}`));
        row.append(names, el("span", "arrow", "Open workspace →"));
        rows.append(row);
      }
      group.append(rows);
      results.append(group);
    }
    count.textContent = `${total} demo ${total === 1 ? "cabinet" : "cabinets"} across ${results.children.length} ${results.children.length === 1 ? "site" : "sites"}`;
    if (!total) results.append(el("p", "empty", "No matching demo cabinets. Clear your search to see all cabinets."));
  }
  input.addEventListener("input", update);
  update();
}
function renderCabinet(id) {
  const found = cabinetFor(id);
  if (!found) { location.hash = "#finder"; return; }
  const { cabinet, site } = found;
  doc.title = `${cabinet.name} · Demo`;
  const client = demoClients.find(item => item.id === site.clientId);
  doc.querySelector("#breadcrumb").textContent = `${client.name} / ${site.name} / ${cabinet.name}`;
  view.replaceChildren();
  const back = link("← Back to finder", "#finder", "back");
  const head = heading(`02 / CABINET WORKSPACE · ${cabinet.id}`, cabinet.name, "A site-scoped place to orient, navigate and review a proposed diagnostic plan. Nothing here queries a device.");
  head.prepend(back);
  view.append(head);
  const context = el("section", "context panel");
  context.setAttribute("aria-label", "Site and cabinet context");
  const contextHead = el("div", "section-title");
  contextHead.append(el("span", "eyebrow", "SITE CONTEXT"), el("span", "soft-pill", "DEMO · SYNTHETIC"));
  context.append(contextHead);
  const facts = el("dl", "facts");
  for (const [name, value] of [["Client", `${client.name} · ${client.id}`], ["Site", `${site.name} · ${site.id}`], ["Region", site.region], ["Cabinet", cabinet.id], ["Site role", cabinet.role], ["Cabinet type", cabinet.type], ["Placement", cabinet.location], ["Scanner family", "Not specified"]]) {
    const item = el("div"); item.append(el("dt", "", name), el("dd", "", value)); facts.append(item);
  }
  context.append(facts);
  const siblings = el("nav", "siblings");
  siblings.setAttribute("aria-label", "Cabinets at this site");
  siblings.append(el("span", "field-label", "At this site"));
  for (const sibling of site.cabinets) {
    const a = link(`${sibling.id} · ${sibling.name}`, `#cabinet/${sibling.id}`, "sibling");
    if (sibling.id === id) a.setAttribute("aria-current", "page");
    siblings.append(a);
  }
  context.append(siblings);
  view.append(context);
  const evidence = el("section", "evidence panel");
  evidence.setAttribute("aria-label", "Demo evidence for selected cabinet");
  evidence.append(el("p", "eyebrow", "SAMPLE EVIDENCE · NOT LIVE"), el("h2", "", "Event Viewer and firewall clues"));
  const cards = el("div", "evidence-grid");
  const events = el("article", "evidence-card");
  events.append(el("h3", "", "Event Viewer"), el("p", "", cabinet.event), el("p", "muted", "Illustrative retained summary; not a fetched Windows event or proof of cause."));
  const firewall = el("article", "evidence-card");
  firewall.append(el("h3", "", "Firewall status / clue"), el("p", "", cabinet.firewall), el("p", "muted", "Sample profile clue only; no live inspection, repair or causal conclusion."));
  cards.append(events, firewall);
  const network = el("article", "evidence-card");
  network.append(el("h3", "", "Network / IP"), el("p", "", `${cabinet.ip} · RFC 5737 documentation address, not a hospital address`));
  const drivers = el("article", "evidence-card");
  drivers.append(el("h3", "", "Driver clue"), el("p", "", cabinet.driver), el("p", "muted", "No driver scan performed."));
  const ping = el("article", "evidence-card");
  ping.append(el("h3", "", "Illustrative cabinet-to-cabinet ping"), el("p", "", `${cabinet.id} → ${cabinet.peer}: ${cabinet.ping}`), el("p", "muted", "Sample observation: not executed; observation time: demo fixture (not a real timestamp). Ping success or failure cannot establish firewall cause."));
  cards.append(network, drivers, ping);
  evidence.append(cards, el("p", "muted", "These sample values are synthetic, not live diagnostic results. No agent is connected."));
  view.append(evidence);
  const diagnostics = el("section", "diagnostics panel");
  diagnostics.setAttribute("aria-labelledby", "diagnostics-title");
  const title = el("div", "section-title");
  const titleGroup = el("div");
  titleGroup.append(el("p", "eyebrow", "03 / DIAGNOSTIC DESIGN"), el("h2", "", "Diagnostic modules"));
  titleGroup.querySelector("h2").id = "diagnostics-title";
  title.append(titleGroup, el("span", "soft-pill", "PLAN ONLY · NOT RUN"));
  diagnostics.append(title, el("p", "muted", "“All checks” is one umbrella view composed of named, independently selectable checks. Selecting a check previews scope; it never executes one."));
  const chooser = el("div", "chooser");
  chooser.setAttribute("role", "group");
  chooser.setAttribute("aria-label", "Diagnostic concept selection");
  const detail = el("div", "module-detail");
  for (const item of [{ id: "all", title: "All checks" }, ...modules]) {
    const button = el("button", "choice", item.title);
    button.type = "button";
    button.dataset.module = item.id;
    button.addEventListener("click", () => { selectedModule = item.id; update(); });
    chooser.append(button);
  }
  function update() {
    for (const button of chooser.children) button.setAttribute("aria-pressed", String(button.dataset.module === selectedModule));
    detail.replaceChildren();
    const selected = modules.find(item => item.id === selectedModule);
    detail.append(el("p", "eyebrow", selected ? "INDEPENDENT MODULE / CONCEPT" : "UMBRELLA / CONCEPT"), el("h3", "", selected?.title ?? "All checks"));
    if (!selected) {
      detail.append(el("p", "muted", "A proposed composition of the modules below. No checks have run; there are no results or pass/fail states."));
      const list = el("ol", "module-list");
      for (const item of modules) list.append(el("li", "", `${item.title} — Not run`));
      detail.append(list);
    } else {
      detail.append(el("p", "muted", selected.summary), el("p", "not-run", "STATUS  /  Not run · No result available"));
      if (selected.id === "fingerprint") {
        detail.append(el("p", "muted", `Cabinet type: ${cabinet.type}. Scanner family: not specified. Reviewed definitions and scripts remain pending.`));
      }
    }
  }
  diagnostics.append(chooser, detail);
  view.append(diagnostics);
  update();
}
function renderOnboarding() {
  doc.title = "Demo · Manual onboarding";
  doc.querySelector("#breadcrumb").textContent = "Manual onboarding";
  view.replaceChildren(heading("03 / MANUAL ONBOARDING", "Demo onboarding", "Stage an illustrative cabinet request, review it, then simulate a supervisor decision. Nothing is submitted."));
  const panel = el("section", "panel onboarding");
  const staffLabel = el("label", "field-label", "Demo support team member · Alex (synthetic)"); staffLabel.htmlFor = "staff-tier";
  const staffTier = el("select", "search"); staffTier.id = "staff-tier";
  for (const name of ["Tier 1", "Tier 2"]) { const option = el("option", "", name); option.value = name; staffTier.append(option); }
  staffTier.value = demoStaffTier;
  staffTier.addEventListener("change", () => { demoStaffTier = staffTier.value; });
  const staffBoundary = el("p", "muted", "Tier change is mock local-demo state in this browser session, not staff accounts or permission entitlements. Supervisor/leadership is a separate view label; exact tier permissions are not specified."); staffBoundary.id = "staff-boundary";
  const roleLabel = el("label", "field-label", "Mock role view (not a login)");
  roleLabel.htmlFor = "role-view";
  const role = el("select", "search");
  role.id = "role-view";
  for (const name of ["Tier 1", "Tier 2", "Supervisor"]) {
    const option = el("option", "", name); option.value = name; role.append(option);
  }
  const clientLabel = el("label", "field-label", "Client name (required · demo selection)"); clientLabel.htmlFor = "client-name";
  const clientInput = el("select", "search"); clientInput.id = "client-name"; clientInput.required = true;
  for (const item of demoClients) { const option = el("option", "", item.name); option.value = item.name; clientInput.append(option); }
  const newClientOption = el("option", "", "+ Create new demo client"); newClientOption.value = "__new"; clientInput.append(newClientOption);
  const newClient = el("input", "search"); newClient.id = "new-client"; newClient.placeholder = "New synthetic client name"; newClient.maxLength = 60; newClient.hidden = true;
  const siteLabel = el("label", "field-label", "Site name (required · demo selection)"); siteLabel.htmlFor = "site-name";
  const siteInput = el("select", "search"); siteInput.id = "site-name"; siteInput.required = true;
  const newSite = el("input", "search"); newSite.id = "new-site"; newSite.placeholder = "New synthetic site name"; newSite.maxLength = 60; newSite.hidden = true;
  function updateSites() {
    siteInput.replaceChildren();
    const selectedClient = demoClients.find(item => item.name === clientInput.value);
    for (const item of demoSites.filter(site => site.clientId === selectedClient?.id)) {
      const option = el("option", "", item.name); option.value = item.name; siteInput.append(option);
    }
    const option = el("option", "", "+ Create new demo site"); option.value = "__new"; siteInput.append(option);
    newClient.hidden = clientInput.value !== "__new";
    updateNewSite();
  }
  function updateNewSite() { newSite.hidden = siteInput.value !== "__new"; }
  clientInput.addEventListener("change", updateSites);
  siteInput.addEventListener("change", updateNewSite);
  updateSites();
  const departmentLabel = el("label", "field-label", "Department (optional · local demo text)"); departmentLabel.htmlFor = "department";
  const department = el("input", "search"); department.id = "department"; department.maxLength = 60; department.placeholder = "Demo reception";
  const cabinetLabel = el("label", "field-label", "Cabinet to stage");
  cabinetLabel.htmlFor = "onboarding-cabinet";
  const cabinet = el("select", "search"); cabinet.id = "onboarding-cabinet";
  for (const site of demoSites) for (const item of site.cabinets) {
    const option = el("option", "", `${site.name} / ${item.id} · ${item.role}`);
    option.value = item.id; cabinet.append(option);
  }
  const newCabinetOption = el("option", "", "+ Assign new demo cabinet"); newCabinetOption.value = "__new"; cabinet.append(newCabinetOption);
  const newCabinet = el("input", "search"); newCabinet.id = "new-cabinet"; newCabinet.placeholder = "CAB-06"; newCabinet.maxLength = 6; newCabinet.hidden = true;
  const cabinetType = el("select", "search"); cabinetType.id = "cabinet-type";
  for (const name of ["Sync", "Satellite"]) { const option = el("option", "", name); option.value = name; cabinetType.append(option); }
  const typeLabel = el("label", "field-label", "Cabinet type / site role (Sync or Satellite)"); typeLabel.htmlFor = "cabinet-type";
  cabinet.addEventListener("change", () => { newCabinet.hidden = cabinet.value !== "__new"; });
  const stage = el("button", "choice", "Stage manual request"); stage.id = "stage-request"; stage.type = "button";
  const approve = el("button", "choice", "Simulate approval"); approve.id = "approve-request"; approve.type = "button";
  const reset = el("button", "choice", "Start another demo request"); reset.id = "reset-request"; reset.type = "button";
  const state = el("p", "not-run", "No request staged"); state.id = "onboarding-state"; state.setAttribute("role", "status");
  const guidance = el("p", "muted"); guidance.id = "role-guidance";
  const boundary = el("p", "muted", "No account is created, no authentication occurs, and no server or agent receives a request. This in-memory view resets on reload.");
  boundary.id = "onboarding-boundary";
  let request = demoRequest;
  function update() {
    stage.disabled = role.value !== "Tier 1" || Boolean(request);
    approve.disabled = role.value !== "Supervisor" || !request || request.status !== "Pending supervisor approval";
    cabinet.disabled = Boolean(request);
    reset.disabled = !request || request.status !== "Demo approved";
    state.textContent = request ? `${request.client} / ${request.site}${request.department ? ` / ${request.department}` : ""} · ${request.cabinetId} · ${request.type} · ${request.status} · ${role.value} mock view` : "No request staged";
    guidance.textContent = ({ "Tier 1": "Tier 1: illustrate staging a cabinet request; no real tier entitlements are defined.", "Tier 2": "Tier 2: review and escalate in this mock view; permissions remain unspecified.", "Supervisor": "Supervisor/leadership: simulate a decision in this browser only, not an authorization check." })[role.value];
  }
  stage.addEventListener("click", () => {
    if (role.value !== "Tier 1" || request) return;
    const clientName = clientInput.value === "__new" ? newClient.value.trim() : clientInput.value;
    const siteName = siteInput.value === "__new" ? newSite.value.trim() : siteInput.value;
    const cabinetId = cabinet.value === "__new" ? newCabinet.value.trim().toUpperCase() : cabinet.value;
    const selectedClient = demoClients.find(item => item.name === clientName);
    const selectedSite = demoSites.find(item => item.name === siteName && item.clientId === selectedClient?.id);
    const existingCabinet = cabinetFor(cabinetId);
    if (!clientName || !siteName || !/^CAB-\d{2}$/.test(cabinetId) || clientName.length > 60 || siteName.length > 60 ||
        (clientInput.value === "__new" && selectedClient) ||
        (siteInput.value === "__new" && demoSites.some(item => item.name === siteName)) ||
        (siteInput.value !== "__new" && !selectedSite) ||
        (cabinet.value === "__new" && existingCabinet) ||
        (cabinet.value !== "__new" && (!selectedSite || !selectedSite.cabinets.some(item => item.id === cabinetId)))) {
      state.textContent = "Choose a client and site matching the selected demo cabinet, or enter unique new demo identities."; return;
    }
    const type = cabinet.value === "__new" ? cabinetType.value : existingCabinet.cabinet.type;
    request = { cabinetId, client: clientName, site: siteName, department: department.value.trim().slice(0, 60), type, status: "Pending supervisor approval", newClient: clientInput.value === "__new", newSite: siteInput.value === "__new", newCabinet: cabinet.value === "__new" };
    demoRequest = request; update();
  });
  approve.addEventListener("click", () => {
    if (role.value !== "Supervisor" || request?.status !== "Pending supervisor approval") return;
    if (request.newClient) demoClients.push({ id: `CL-${demoClients.length + 301}`, name: request.client });
    const approvedClient = demoClients.find(item => item.name === request.client);
    if (request.newSite) demoSites.push({ id: `ST-${demoSites.length + 301}`, clientId: approvedClient.id, name: request.site, region: "Synthetic site", cabinets: [] });
    const approvedSite = demoSites.find(item => item.clientId === approvedClient.id && item.name === request.site);
    if (request.newCabinet) approvedSite.cabinets.push({ id: request.cabinetId, name: "New demo cabinet", role: request.type, type: request.type, location: request.department || "Unassigned demo zone", firewall: "Unknown (sample)", event: "No retained sample event", ip: "192.0.2.99", peer: "None specified", ping: "Not observed", driver: "Driver inventory: unknown (sample)" });
    request.status = "Demo approved"; update();
  });
  reset.addEventListener("click", () => { if (request?.status !== "Demo approved") return; demoRequest = null; renderOnboarding(); });
  role.addEventListener("change", update);
  panel.append(staffLabel, staffTier, staffBoundary, roleLabel, role, guidance, clientLabel, clientInput, newClient, siteLabel, siteInput, newSite, departmentLabel, department, cabinetLabel, cabinet, newCabinet, typeLabel, cabinetType, stage, approve, reset, state, boundary);
  view.append(panel);
  update();
}
function route() {
  if (location.hash === "#onboarding") { renderOnboarding(); }
  else {
    const match = /^#cabinet\/(CAB-\d{2})$/.exec(location.hash);
    if (match) renderCabinet(match[1]);
    else renderFinder();
  }
  doc.querySelector("#finder-nav").setAttribute("aria-current", location.hash === "#onboarding" || location.hash.startsWith("#cabinet/") ? "false" : "page");
}
doc.querySelector(".skip").addEventListener("click", event => {
  event.preventDefault();
  doc.querySelector("#main").focus();
});
window.addEventListener("hashchange", () => {
  route();
  const title = view.querySelector("h1");
  title.tabIndex = -1;
  title.focus();
});
route();
