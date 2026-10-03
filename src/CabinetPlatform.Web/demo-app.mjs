import { sites, modules, scannerTypes } from "./demo-data.mjs";

const doc = document;
const view = doc.querySelector("#view");
let query = "";
let selectedModule = "all";

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
  for (const site of sites) {
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
  doc.title = "Cabinet finder · Fictional demo";
  doc.querySelector("#breadcrumb").textContent = "Finder";
  view.replaceChildren(heading("01 / DISCOVER", "Find a cabinet", "Browse fictional sites and open a cabinet workspace. Search filters this local fixture only."));
  const box = el("section", "panel finder");
  const label = el("label", "field-label", "Search cabinets or sites");
  label.htmlFor = "finder-search";
  const input = el("input", "search");
  input.id = "finder-search";
  input.type = "search";
  input.placeholder = "Try Harbor, Atrium or CAB-02";
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
    for (const site of sites) {
      const cabinets = site.cabinets.filter(cabinet => [site.name, site.region, cabinet.name, cabinet.id, cabinet.type, cabinet.location].some(value => value.toLocaleLowerCase().includes(needle)));
      if (!cabinets.length) continue;
      total += cabinets.length;
      const group = el("section", "site-group");
      group.append(el("h2", "", site.name), el("p", "muted", `${site.region} · Fictional site`));
      const rows = el("div", "rows");
      for (const cabinet of cabinets) {
        const row = link("", `#cabinet/${cabinet.id}`, "cabinet-row");
        const names = el("span");
        names.append(el("strong", "", cabinet.name), el("small", "", `${cabinet.id} · ${cabinet.type} · ${cabinet.location}`));
        row.append(names, el("span", "arrow", "Open workspace →"));
        rows.append(row);
      }
      group.append(rows);
      results.append(group);
    }
    count.textContent = `${total} fictional ${total === 1 ? "cabinet" : "cabinets"} across ${results.children.length} ${results.children.length === 1 ? "site" : "sites"}`;
    if (!total) results.append(el("p", "empty", "No matching cabinets in this fictional fixture. Clear your search to see all cabinets."));
  }
  input.addEventListener("input", update);
  update();
}
function renderCabinet(id) {
  const found = cabinetFor(id);
  if (!found) { location.hash = "#finder"; return; }
  const { cabinet, site } = found;
  doc.title = `${cabinet.name} · Fictional demo`;
  doc.querySelector("#breadcrumb").textContent = `${site.name} / ${cabinet.name}`;
  view.replaceChildren();
  const back = link("← Back to finder", "#finder", "back");
  const head = heading(`02 / CABINET WORKSPACE · ${cabinet.id}`, cabinet.name, "A site-scoped place to orient, navigate and review a proposed diagnostic plan. Nothing here queries a device.");
  head.prepend(back);
  view.append(head);
  const context = el("section", "context panel");
  context.setAttribute("aria-label", "Site and cabinet context");
  const contextHead = el("div", "section-title");
  contextHead.append(el("span", "eyebrow", "SITE CONTEXT"), el("span", "soft-pill", "FICTIONAL"));
  context.append(contextHead);
  const facts = el("dl", "facts");
  for (const [name, value] of [["Site", site.name], ["Region", site.region], ["Cabinet", cabinet.id], ["Placement", cabinet.location], ["Scanner family", cabinet.type]]) {
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
        detail.append(el("p", "muted", `Selected cabinet family: ${cabinet.type}. Each scanner family needs its own reviewed definition; the exact script is pending.`));
        const families = el("div", "families");
        for (const type of scannerTypes) families.append(el("span", type === cabinet.type ? "family current" : "family", `${type} · Definition pending`));
        detail.append(families);
      }
    }
  }
  diagnostics.append(chooser, detail);
  view.append(diagnostics);
  update();
}
function route() {
  const match = /^#cabinet\/(CAB-0[1-3])$/.exec(location.hash);
  if (match) renderCabinet(match[1]);
  else renderFinder();
  doc.querySelector("#finder-nav").setAttribute("aria-current", match ? "false" : "page");
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
