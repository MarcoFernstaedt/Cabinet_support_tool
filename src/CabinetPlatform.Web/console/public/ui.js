// DOM helpers. Every node is built with DOM APIs and text nodes; untrusted
// strings from the Server are never parsed as HTML.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "href" && typeof v === "string" && !/^(#|\/|https?:)/.test(v)) continue;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

export const clear = el => { while (el.firstChild) el.firstChild.remove(); return el; };

// --- Formatting --------------------------------------------------------------
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function ago(value) {
  if (!value) return "Never";
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return "Unknown";
  const s = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}
export function dateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}
export const pct = v => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 10) / 10}%` : "—");
export function bytes(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}
export function duration(v) {
  // .NET TimeSpan JSON: "d.hh:mm:ss" or "hh:mm:ss(.fffffff)"
  if (typeof v !== "string") return "—";
  const m = /^(-)?(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(v);
  if (!m) return v;
  const [, , d = "0", hh, mm] = m;
  return Number(d) ? `${Number(d)}d ${Number(hh)}h` : Number(hh) ? `${Number(hh)}h ${Number(mm)}m` : `${Number(mm)}m`;
}
export const roleLabel = role => ({ Supervisor: "Administrator", Tier1: "Support · Tier 1", Tier2: "Support · Tier 2" })[role] ?? role;
export const splitWords = s => String(s ?? "").replace(/([a-z])([A-Z])/g, "$1 $2");

// --- Small components --------------------------------------------------------
const HEALTH_ICON = { Healthy: "●", Warning: "▲", Critical: "◆", Offline: "○", Unknown: "?" };
export function healthBadge(status = "Unknown") {
  return h("span", { class: `badge health-${String(status).toLowerCase()}` }, h("span", { "aria-hidden": "true" }, HEALTH_ICON[status] ?? "?"), " ", status);
}
export const chip = (text, kind = "") => h("span", { class: `chip ${kind}` }, text);

export function statTile(label, value, { tone = "", href, note } = {}) {
  const body = [h("span", { class: "stat-label" }, label), h("strong", { class: "stat-value" }, value), note ? h("span", { class: "stat-note" }, note) : null];
  return href ? h("a", { class: `stat ${tone}`, href }, body) : h("div", { class: `stat ${tone}` }, body);
}

export function card(title, body, { actions, cls = "" } = {}) {
  return h("section", { class: `card ${cls}` },
    title || actions ? h("header", { class: "card-head" }, title ? h("h2", null, title) : null, actions ? h("div", { class: "card-actions" }, actions) : null) : null,
    h("div", { class: "card-body" }, body));
}

export function facts(pairs) {
  return h("dl", { class: "facts" }, pairs.filter(Boolean).map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v ?? "—"))));
}

export function empty(text, sub) {
  return h("div", { class: "empty" }, h("p", null, text), sub ? h("p", { class: "muted" }, sub) : null);
}

export function loading() { return h("div", { class: "loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Loading…"); }

export function errorBox(err, retry) {
  return h("div", { class: "error-box", role: "alert" },
    h("strong", null, err?.title ?? "Something went wrong"),
    err?.detail ? h("p", null, err.detail) : null,
    retry ? h("button", { class: "btn", onclick: retry }, "Try again") : null);
}

// table({ columns: [{ label, render(row), cls }], rows, onRow, empty })
export function table({ columns, rows, onRow, emptyText = "Nothing to show.", caption }) {
  if (!rows.length) return empty(emptyText);
  return h("div", { class: "table-wrap" }, h("table", { class: onRow ? "clickable" : "" },
    caption ? h("caption", { class: "sr-only" }, caption) : null,
    h("thead", null, h("tr", null, columns.map(c => h("th", { scope: "col", class: c.cls }, c.label)))),
    h("tbody", null, rows.map(row => {
      const tr = h("tr", null, columns.map(c => h("td", { class: c.cls }, c.render(row))));
      if (onRow) {
        tr.tabIndex = 0;
        tr.addEventListener("click", e => { if (!e.target.closest("a,button")) onRow(row); });
        tr.addEventListener("keydown", e => { if (e.key === "Enter") onRow(row); });
      }
      return tr;
    }))));
}

export function pager(page, totalPages, go) {
  if (!totalPages || totalPages <= 1) return null;
  return h("nav", { class: "pager", "aria-label": "Pages" },
    h("button", { class: "btn ghost", disabled: page <= 1, onclick: () => go(page - 1) }, "‹ Previous"),
    h("span", null, `Page ${page} of ${totalPages}`),
    h("button", { class: "btn ghost", disabled: page >= totalPages, onclick: () => go(page + 1) }, "Next ›"));
}

// --- Toasts & dialogs ---------------------------------------------------------
export function toast(message, kind = "info") {
  let host = document.getElementById("toasts");
  if (!host) { host = h("div", { id: "toasts", role: "status", "aria-live": "polite" }); document.body.append(host); }
  const el = h("div", { class: `toast ${kind}` }, message);
  host.append(el);
  setTimeout(() => el.classList.add("leaving"), 4200);
  setTimeout(() => el.remove(), 4700);
}

// Opens a modal form. `fields` is a list of { name, label, type, options, required, value, hint, maxlength }.
// `submit(values)` returns a promise; a thrown { title, detail, errors } is shown inside the dialog.
export function formDialog({ title, intro, fields, submitLabel = "Save", danger = false, submit }) {
  return new Promise(resolve => {
    const errorEl = h("div", { class: "form-error", role: "alert", hidden: true });
    const inputs = {};
    const form = h("form", { class: "dialog-form", novalidate: true },
      intro ? (intro instanceof Node ? intro : h("p", { class: "muted" }, intro)) : null,
      fields.map(f => {
        const id = `f-${f.name}-${Math.random().toString(36).slice(2, 7)}`;
        let input;
        if (f.type === "select") input = h("select", { id, name: f.name, required: f.required }, (f.options ?? []).map(o => h("option", { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)));
        else if (f.type === "textarea") input = h("textarea", { id, name: f.name, required: f.required, maxlength: f.maxlength ?? 2000, rows: 3, placeholder: f.placeholder }, f.value ?? "");
        else input = h("input", { id, name: f.name, type: f.type ?? "text", required: f.required, maxlength: f.maxlength ?? 255, value: f.value ?? "", autocomplete: f.autocomplete ?? "off", placeholder: f.placeholder, list: f.suggestions?.length ? `${id}-list` : null, readonly: f.readonly });
        inputs[f.name] = input;
        const list = f.suggestions?.length ? h("datalist", { id: `${id}-list` }, [...new Set(f.suggestions)].map(s => h("option", { value: s }))) : null;
        return h("div", { class: "field" }, h("label", { for: id }, f.label, f.required ? h("span", { class: "req", "aria-hidden": "true" }, " *") : null), input, list, f.hint ? h("small", { class: "hint" }, f.hint) : null);
      }),
      errorEl,
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "submit", class: `btn ${danger ? "danger" : "primary"}` }, submitLabel)));
    const dialog = h("dialog", { class: "dialog", "aria-label": title }, h("h2", null, title), form);
    const close = value => { dialog.close(); dialog.remove(); resolve(value); };
    dialog.addEventListener("cancel", e => { e.preventDefault(); close(null); });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
      const missing = fields.find(f => f.required && !values[f.name]);
      if (missing) { errorEl.hidden = false; errorEl.textContent = `${missing.label} is required.`; inputs[missing.name].focus(); return; }
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try { close(await submit(values) ?? true); }
      catch (err) {
        errorEl.hidden = false;
        const extra = err?.errors ? Object.values(err.errors).flat().join(" ") : "";
        errorEl.textContent = [err?.detail || err?.title || "Request failed.", extra].filter(Boolean).join(" ");
        btn.disabled = false;
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    form.querySelector("input,select,textarea")?.focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return formDialog({ title, intro: message, fields: [], submitLabel: confirmLabel, danger, submit: async () => true });
}
