import { validGuid, validPage } from "./read-only-pages.mjs";

const escape = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const label = value => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value);
const identity = row => row && validGuid(row.id) && label(row.machineId) && label(row.hostname) && row.status === "Pending";
const shell = content => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Enrollment and retirement | Mashura Support</title><link rel="stylesheet" href="/styles.css"></head><body><main class="fleet-page"><p class="tag">LOCAL DEVELOPMENT BUILD · NO MFA · DISPOSABLE SYNTHETIC DATA ONLY</p><a href="/fleet">Cabinet finder</a> · <a href="/enrollment">Pending enrollment</a>${content}</main></body></html>`;

export function pendingRows(data, page) {
  if (!validPage(data, page) || !data.items.every(identity) || new Set(data.items.map(row => row.id.toLowerCase())).size !== data.items.length) throw Error("Invalid pending page");
  return data.items;
}
export function renderQueue(data, page) {
  const rows = pendingRows(data, page).map(row => `<li><strong>${escape(row.hostname)}</strong> · machine ${escape(row.machineId)} · registration ${escape(row.id)} · first seen ${escape(row.firstSeenUtc)}<br><a href="/enrollment/${row.id}/approve?page=${page}">Review approval</a> · <a href="/enrollment/${row.id}/reject?page=${page}">Review rejection</a></li>`).join("");
  return shell(`<h1>Pending enrollment</h1><p>Supervisor decisions only. Reported hostnames are untrusted hints. Approval creates operational access; verify machine identity independently.</p><p role="status">${data.totalCount} pending; page ${page}.</p>${rows ? `<ul class="fleet-list">${rows}</ul>` : "<p>No registrations on this page.</p>"}<nav>${page > 1 ? `<a href="/enrollment?page=${page - 1}">Previous</a>` : ""} ${data.hasMore ? `<a href="/enrollment?page=${page + 1}">Next</a>` : ""}</nav>`);
}
export function pendingTarget(data, page, id) {
  return pendingRows(data, page).find(row => row.id.toLowerCase() === id) ?? null;
}
export function cabinetTarget(data, id) {
  const row = data?.cabinet, site = data?.site;
  if (!row || !site || !validGuid(row.id) || row.id.toLowerCase() !== id || !label(row.machineId) || !label(row.hostname) || typeof row.isActive !== "boolean" || !validGuid(row.siteId) || !validGuid(site.id) || row.siteId.toLowerCase() !== site.id.toLowerCase() || !label(row.clientName) || !label(row.siteName) || !["Sync", "Satellite", "Standalone"].includes(row.role)) throw Error("Invalid cabinet identity");
  return row;
}
export function renderDecision(kind, row, csrf, page = 1) {
  const registration = kind !== "retire";
  const path = registration ? `/enrollment/${row.id}/${kind}?page=${page}` : `/cabinet/${row.id}/retire`;
  const title = { approve: "Approve enrollment", reject: "Reject enrollment", retire: "Retire cabinet" }[kind];
  const fields = kind === "approve" ? `<label>Client <input name="clientName" required maxlength="255"></label><label>Site <input name="siteName" required maxlength="255"></label><label>Department <input name="departmentName" maxlength="255"></label><label>Role <select name="role" required><option value="">Choose role</option><option>Sync</option><option>Satellite</option><option>Standalone</option></select></label>` : "";
  const warning = kind === "retire" ? "After retirement operational access is blocked for this cabinet and history is retained. Credential erasure is unverified; it does not wipe the device or stored keys." : kind === "approve" ? "The Server makes the final decision. A fresh read is not an atomic write precondition. The approval reason is sent to the Server and retained in the named Supervisor audit." : "The Server makes the final decision. A fresh read is not an atomic write precondition.";
  return shell(`<h1>${title}</h1><p>Target ${registration ? "registration" : "cabinet"}: ${escape(row.id)}. Reported hostname: ${escape(row.hostname)}. Machine ID: ${escape(row.machineId)}.${registration ? "" : ` Client: ${escape(row.clientName)}. Site: ${escape(row.siteName)}. Role: ${escape(row.role)}.`}</p><p>${warning}</p><form method="post" action="${path}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="machineId" value="${escape(row.machineId)}">${fields}<label>Reason <textarea name="reason" required maxlength="2000"></textarea></label><button>Confirm ${kind}</button></form>`);
}
export function decisionValues(values, kind) {
  const allowed = kind === "approve" ? ["csrf", "machineId", "reason", "clientName", "siteName", "departmentName", "role"] : ["csrf", "machineId", "reason"];
  if ([...values.keys()].some(key => !allowed.includes(key) || values.getAll(key).length !== 1)) return null;
  const reason = values.get("reason")?.trim();
  if (!reason || reason.length > 2000 || /[\u0000-\u001f\u007f]/.test(reason)) return null;
  if (kind !== "approve") return { reason };
  const clientName = values.get("clientName")?.trim(), siteName = values.get("siteName")?.trim(), departmentName = values.get("departmentName")?.trim() ?? "";
  const role = values.get("role");
  if (!label(clientName) || !label(siteName) || departmentName.length > 255 || /[\u0000-\u001f\u007f]/.test(departmentName) || !["Sync", "Satellite", "Standalone"].includes(role)) return null;
  return { clientName, siteName, departmentName, role, approvalReason: reason };
}
