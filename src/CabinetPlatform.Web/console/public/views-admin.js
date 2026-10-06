// Administrator-only views: cabinet enrollment decisions and staff accounts.
// The Server's Supervisor policy is authoritative; the BFF refuses these
// routes for support tiers too.
import { get, post, patch } from "./api.js";
import { h, ago, dateTime, chip, card, facts, empty, table, toast, formDialog, roleLabel } from "./ui.js";

const ROLES = ["Sync", "Satellite", "Standalone"];

function pageHead(title, sub, actions) {
  return h("header", { class: "page-head" },
    h("div", null, h("p", { class: "eyebrow" }, "Administration"), h("h1", null, title), sub ? h("p", { class: "muted" }, sub) : null),
    actions ? h("div", { class: "page-actions" }, actions) : null);
}

// --- Enrollment ---------------------------------------------------------------------------------
export async function enrollmentView({ query, ctx }) {
  const status = ["Pending", "Approved", "Rejected"].includes(query.status) ? query.status : "Pending";
  const [data, sites] = await Promise.all([
    get("/api/registrations/pending", { status, pageSize: 100 }),
    get("/api/fleet/sites", { pageSize: 200 }),
  ]);
  const tabs = h("div", { class: "tabs compact", role: "tablist" }, ["Pending", "Approved", "Rejected"].map(s =>
    h("a", { role: "tab", href: `#/admin/enrollment?status=${s}`, class: s === status ? "active" : "", "aria-selected": s === status ? "true" : "false" }, s)));

  const list = data.items.length
    ? h("div", { class: "enroll-list" }, data.items.map(r => registrationCard(r, status, sites.items, ctx)))
    : empty(status === "Pending" ? "No cabinets are waiting for approval." : `No ${status.toLowerCase()} registrations.`,
      status === "Pending" ? "When an agent is installed on a cabinet it registers itself and appears here for review." : null);

  return h("div", { class: "page" },
    pageHead("Cabinet enrollment", "Agents register themselves; nothing reaches the fleet until an administrator verifies the machine and assigns it to a client and site.",
      h("button", { class: "btn", onclick: () => ctx.rerender() }, "↻ Refresh")),
    tabs, list);
}

function registrationCard(r, status, sites, ctx) {
  return h("article", { class: "enroll-card" },
    h("div", { class: "enroll-main" },
      h("div", { class: "row gap wrap" }, h("h2", null, r.hostname), chip(r.status, r.status === "Pending" ? "warn" : r.status === "Approved" ? "ok" : "crit")),
      facts([
        ["Machine ID", h("code", null, r.machineId)],
        ["Operating system", r.osVersion ?? "—"],
        ["Agent version", r.agentVersion ?? "—"],
        ["First seen", `${dateTime(r.firstSeenUtc)} (${ago(r.firstSeenUtc)})`],
        ["Last seen", ago(r.lastSeenUtc)],
        r.decidedUtc ? ["Decided", dateTime(r.decidedUtc)] : null,
      ])),
    status === "Pending" ? h("div", { class: "enroll-actions" },
      h("button", { class: "btn primary", onclick: () => approve(r, sites, ctx) }, "Approve…"),
      h("button", { class: "btn ghost danger-text", onclick: () => reject(r, ctx) }, "Reject…")) : null);
}

async function approve(r, sites, ctx) {
  const ok = await formDialog({
    title: `Approve ${r.hostname}`,
    intro: h("div", { class: "notice" }, "Confirm the machine ID matches the cabinet on site before approving. ",
      h("strong", null, r.machineId)),
    submitLabel: "Approve and enroll",
    fields: [
      { name: "friendlyName", label: "Display name", value: r.hostname, maxlength: 120, hint: "What support staff will see, e.g. “Pharmacy CAB-02”." },
      { name: "clientName", label: "Client", required: true, suggestions: sites.map(s => s.clientName), hint: "Pick an existing client or type a new one." },
      { name: "siteName", label: "Site", required: true, suggestions: sites.map(s => s.siteName) },
      { name: "departmentName", label: "Department", maxlength: 255 },
      { name: "role", label: "Cabinet role", type: "select", value: "Satellite", options: ROLES.map(v => ({ value: v, label: { Sync: "Sync — holds the site database", Satellite: "Satellite — syncs to the site's Sync cabinet", Standalone: "Standalone — no sync relationship" }[v] })) },
      { name: "ticketReference", label: "Ticket reference", maxlength: 64 },
      { name: "approvalReason", label: "Approval note", type: "textarea", required: true, placeholder: "e.g. Verified machine ID with on-site technician" },
    ],
    submit: v => post(`/api/registrations/${r.id}/approve`, {
      friendlyName: v.friendlyName || undefined, clientName: v.clientName, siteName: v.siteName,
      departmentName: v.departmentName || undefined, role: v.role, approvalReason: v.approvalReason, ticketReference: v.ticketReference || undefined,
    }),
  });
  if (!ok) return;
  toast(`${r.hostname} approved. It will appear in Cabinets after its next check-in.`, "success");
  ctx.refreshBadges();
  ctx.rerender();
}

async function reject(r, ctx) {
  const ok = await formDialog({
    title: `Reject ${r.hostname}?`, danger: true, submitLabel: "Reject registration",
    intro: "A rejected machine stays rejected even if it keeps registering.",
    fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }, { name: "ticketReference", label: "Ticket reference", maxlength: 64 }],
    submit: v => post(`/api/registrations/${r.id}/reject`, { reason: v.reason, ticketReference: v.ticketReference || undefined }),
  });
  if (!ok) return;
  toast(`${r.hostname} rejected.`, "success");
  ctx.refreshBadges();
  ctx.rerender();
}

// --- Staff -----------------------------------------------------------------------------------------
function generatePassword() {
  // 20 characters from four classes, so it always satisfies the Server policy.
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#$%&*+-=?@"];
  const all = sets.join("");
  const rand = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const chars = sets.map(s => s[rand(s.length)]);
  while (chars.length < 20) chars.push(all[rand(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rand(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

function statusChips(u) {
  return h("div", { class: "row gap wrap" },
    u.isActive ? chip("Active", "ok") : chip("Deactivated", "muted"),
    u.isLockedOut ? chip("Locked", "crit") : null,
    u.mustChangePassword ? chip("Onboarding", "info") : null);
}

export async function staffView({ ctx }) {
  const data = await get("/api/users", { pageSize: 200 });
  const me = ctx.session.user.id;
  const rows = data.items.slice().sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.displayName.localeCompare(b.displayName));
  const counts = { admins: rows.filter(u => u.isActive && u.role === "Supervisor").length, support: rows.filter(u => u.isActive && u.role !== "Supervisor").length };

  return h("div", { class: "page" },
    pageHead("Staff accounts", `${counts.admins} administrator${counts.admins === 1 ? "" : "s"} and ${counts.support} support staff active. New accounts must set their own password at first sign-in.`,
      h("button", { class: "btn primary", onclick: () => createUser(ctx) }, "＋ Add staff member")),
    card(null, table({
      rows, emptyText: "No staff accounts.",
      columns: [
        { label: "Name", render: u => h("div", { class: "cell-stack" }, h("strong", null, u.displayName, u.id === me ? " (you)" : ""), h("small", null, u.username)) },
        { label: "Role", render: u => chip(roleLabel(u.role), u.role === "Supervisor" ? "admin" : "") },
        { label: "Status", render: statusChips },
        { label: "Last sign-in", render: u => u.lastLoginUtc ? h("span", { title: dateTime(u.lastLoginUtc) }, ago(u.lastLoginUtc)) : "Never" },
        { label: "Created", render: u => dateTime(u.createdUtc) },
        { label: "", render: u => h("div", { class: "row gap wrap end" },
          h("button", { class: "btn small", onclick: () => editUser(u, ctx), disabled: !u.isActive }, "Edit"),
          u.isLockedOut ? h("button", { class: "btn small", onclick: () => update(u, { clearLockout: true }, "Account unlocked.", ctx) }, "Unlock") : null,
          u.id !== me && u.isActive ? h("button", { class: "btn small", onclick: () => revoke(u, ctx) }, "Sign out everywhere") : null,
          u.id !== me ? (u.isActive
            ? h("button", { class: "btn small danger-text", onclick: () => deactivate(u, ctx) }, "Deactivate")
            : h("button", { class: "btn small", onclick: () => update(u, { isActive: true }, `${u.displayName} reactivated.`, ctx) }, "Reactivate")) : null) },
      ],
    })));
}

async function createUser(ctx) {
  const password = generatePassword();
  const created = await formDialog({
    title: "Add staff member",
    intro: "Support staff (Tier 1 or 2) work cabinets, run diagnostics and handle alerts. Administrators can do everything support can, plus enrollment and staff management.",
    submitLabel: "Create account",
    fields: [
      { name: "displayName", label: "Full name", required: true, maxlength: 120 },
      { name: "username", label: "Username", required: true, maxlength: 64, hint: "ASCII letters, digits, dot, dash or underscore." },
      { name: "role", label: "Role", type: "select", value: "Tier1", options: [{ value: "Tier1", label: "Support · Tier 1" }, { value: "Tier2", label: "Support · Tier 2" }, { value: "Supervisor", label: "Administrator" }] },
      { name: "initialPassword", label: "Temporary password", required: true, value: password, maxlength: 256, hint: "Generated for you. Share it through a secure channel; it only works until they set their own." },
    ],
    submit: v => post("/api/users", v),
  });
  if (!created || created === true) return;
  toast(`${created.displayName} can now sign in as “${created.username}”.`, "success");
  ctx.rerender();
}

async function editUser(u, ctx) {
  const isSelf = u.id === ctx.session.user.id;
  const ok = await formDialog({
    title: `Edit ${u.displayName}`, submitLabel: "Save changes",
    fields: [
      { name: "displayName", label: "Full name", required: true, value: u.displayName, maxlength: 120 },
      isSelf ? { name: "role", label: "Role", value: roleLabel(u.role), readonly: true, hint: "You cannot change your own role." }
        : { name: "role", label: "Role", type: "select", value: u.role, options: [{ value: "Tier1", label: "Support · Tier 1" }, { value: "Tier2", label: "Support · Tier 2" }, { value: "Supervisor", label: "Administrator" }] },
    ],
    submit: v => patch(`/api/users/${u.id}`, { displayName: v.displayName, role: isSelf ? undefined : v.role }),
  });
  if (ok) { toast("Account updated.", "success"); ctx.rerender(); }
}

async function update(u, body, message, ctx) {
  try { await patch(`/api/users/${u.id}`, body); toast(message, "success"); ctx.rerender(); }
  catch (err) { toast(err.detail || err.title || "Update failed.", "error"); }
}

async function deactivate(u, ctx) {
  const ok = await formDialog({
    title: `Deactivate ${u.displayName}?`, danger: true, submitLabel: "Deactivate",
    intro: "They are signed out immediately and cannot sign in until reactivated. Their audit history is kept.",
    fields: [], submit: () => patch(`/api/users/${u.id}`, { isActive: false }),
  });
  if (ok) { toast(`${u.displayName} deactivated.`, "success"); ctx.rerender(); }
}

async function revoke(u, ctx) {
  const ok = await formDialog({
    title: `Sign ${u.displayName} out everywhere?`, submitLabel: "Revoke sessions",
    fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
    submit: v => post(`/api/users/${u.id}/revoke-sessions`, { reason: v.reason }),
  });
  if (ok) { toast("All of their sessions were ended.", "success"); ctx.rerender(); }
}
