// Same-origin calls to the Console BFF. The browser holds only an HttpOnly
// session cookie; the CSRF token below is echoed on every state change.
let csrfToken = null;
let onExpired = () => {};

export const setCsrf = value => { csrfToken = value; };
export const onSessionExpired = fn => { onExpired = fn; };

export async function request(method, path, body) {
  const init = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.headers["X-CSRF-Token"] = csrfToken ?? "";
    init.body = JSON.stringify(body ?? {});
  }
  let response;
  try { response = await fetch(path, init); }
  catch { throw { status: 0, title: "The Console cannot be reached. Check your connection." }; }
  let data = {};
  try { data = await response.json(); } catch { /* empty body */ }
  if (response.status === 401 && !path.startsWith("/auth/")) { onExpired(); }
  if (!response.ok) throw { status: response.status, ...data };
  return data;
}

const qs = params => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const get = (path, params) => request("GET", path + qs(params));
export const post = (path, body) => request("POST", path, body);
export const patch = (path, body) => request("PATCH", path, body);
export const put = (path, body) => request("PUT", path, body);
