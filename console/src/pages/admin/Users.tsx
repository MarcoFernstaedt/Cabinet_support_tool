// Users and their activity (docs/spec/06-console-spec.md "Admin screens"): create, change role,
// set the write limit, disable, reset password or authenticator, delete; and per person, the
// cabinets they opened and everything they did. The server enforces every rule shown here.
import { useState } from "react";
import { api, ApiError } from "../../lib/api";
import { Link } from "../../lib/router";
import { roleName, useSession, type Role } from "../../lib/session";
import { ago, fullTime } from "../../lib/time";
import { Breadcrumbs } from "../../components/Layout";
import { Badge, Empty } from "../../components/ui";
import { useStepUp } from "../../components/StepUp";
import { Pager, usePaged } from "../../components/Pager";
import { useLoad } from "../../lib/useLoad";
import { AuditTable, type AuditRow } from "./Audit";

export interface UserRow {
  id: string; username: string; name: string; role: Role; status: "active" | "disabled" | "deleted"; totpEnabled: boolean; writeLimit: number; canApproveFixes: boolean;
  writesPaused: boolean; writesPausedReason: string | null; lastLoginAt: string | null; createdAt: string; locked: boolean; online: boolean;
}

/** A one-time password, shown once with a warning; never stored by the console. */
function OneTimePassword({ who, password, onDone }: { who: string; password: string; onDone: () => void }) {
  return (
    <div className="notice warn" role="status">
      <p><strong>Temporary password for {who}</strong>, shown only now. Give it to them in person or by phone; they must change it at their first sign-in.</p>
      <p><code className="secret">{password}</code></p>
      <button className="btn small" onClick={onDone}>I have passed it on</button>
    </div>
  );
}

/** Brings a deleted account back: a written reason (kept in the audit log), then a new temporary password, shown once. */
function Reactivate({ id, who, onPassword, onCancel }: { id: string; who: string; onPassword: (p: string) => void; onCancel?: () => void }) {
  const step = useStepUp();
  const [reason, setReason] = useState("");
  const go = () => step.ask("user.reactivate", id,
    <p>Reactivate the account <strong>{who}</strong>. It comes back with a new temporary password and a fresh authenticator setup. Your reason goes into the audit log.</p>,
    async token => { const r = await api<{ temporaryPassword: string }>("POST", `/api/admin/users/${id}/reactivate`, { reason: reason.trim(), stepUpToken: token }); onPassword(r.temporaryPassword); },
    { reason: reason.trim() });
  return (
    <form className="row gap wrap" onSubmit={e => { e.preventDefault(); go(); }}>
      <label className="field inline grow"><span>Reason for reactivating {who}</span>
        <input required minLength={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <button className="btn primary" type="submit">Reactivate account</button>
      {onCancel && <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>}
      {step.dialog}
    </form>
  );
}

/** The new-account form, with its one-time password; used on Users and on the setup page. */
export function NewAccount({ onCreated, onStart, heading = "New account" }: { onCreated: (text: string) => void; onStart?: () => void; heading?: string }) {
  const step = useStepUp();
  const [draft, setDraft] = useState({ username: "", name: "", role: "tier1" as Role });
  const [shown, setShown] = useState<{ who: string; password: string } | null>(null);
  const [deleted, setDeleted] = useState<{ id: string; username: string } | null>(null);
  const create = () => { setDeleted(null); setShown(null); onStart?.(); step.ask("user.create", "fleet",
    <p>Create a {roleName(draft.role)} account <strong>{draft.username}</strong> for {draft.name}. They choose their own password and set up an authenticator at their first sign-in.</p>,
    async token => {
      let r: { id: string; temporaryPassword: string };
      try { r = await api<{ id: string; temporaryPassword: string }>("POST", "/api/admin/users", { ...draft, stepUpToken: token }); }
      catch (e) {
        // A username that belonged to a deleted account: offer to bring that account back instead.
        if (e instanceof ApiError && e.code === "username_deleted" && typeof e.data.userId === "string") { setDeleted({ id: e.data.userId, username: draft.username }); return; }
        throw e;
      }
      setShown({ who: draft.username, password: r.temporaryPassword });
      setDraft({ username: "", name: "", role: "tier1" });
      onCreated(`Account ${draft.username} created.`);
    }, draft); };
  return (
    <section className="panel" aria-labelledby="new-user">
      <h2 id="new-user">{heading}</h2>
      {shown && <OneTimePassword who={shown.who} password={shown.password} onDone={() => setShown(null)} />}
      {deleted && <div className="notice warn" role="status">
        <p>The username <strong>{deleted.username}</strong> belonged to an account that was deleted. You can bring that account back instead of creating a new one.</p>
        <Reactivate id={deleted.id} who={deleted.username} onCancel={() => setDeleted(null)}
          onPassword={password => { setShown({ who: deleted.username, password }); setDeleted(null); setDraft({ username: "", name: "", role: "tier1" }); onCreated(`Account ${deleted.username} reactivated.`); }} />
      </div>}
      <form className="row gap wrap" onSubmit={e => { e.preventDefault(); create(); }}>
        <label className="field inline"><span>Username</span><input required pattern="[a-z0-9._\-]{2,64}" title="Lower-case letters, digits, dot, dash or underscore"
          value={draft.username} onChange={e => setDraft(d => ({ ...d, username: e.target.value.toLowerCase() }))} /></label>
        <label className="field inline"><span>Full name</span><input required maxLength={128} value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} /></label>
        <label className="field inline"><span>Role</span><select value={draft.role} onChange={e => setDraft(d => ({ ...d, role: e.target.value as Role }))}>
          {(["tier1", "tier2", "admin"] as const).map(r => <option key={r} value={r}>{roleName(r)}</option>)}</select></label>
        <button className="btn primary" type="submit">Create account</button>
      </form>
      {step.dialog}
    </section>
  );
}

export function Users() {
  const { me } = useSession();
  const [showDeleted, setShowDeleted] = useState(false);
  const { data, problem, reload } = useLoad<UserRow[]>(`/api/admin/users${showDeleted ? "?deleted=true" : ""}`);
  const paged = usePaged(data ?? []);
  const step = useStepUp();
  const [shown, setShown] = useState<{ who: string; password: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const after = (text: string) => { setDone(text); reload(); };

  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Users" }]} />
      <h1>Users</h1>
      {shown && <OneTimePassword who={shown.who} password={shown.password} onDone={() => setShown(null)} />}
      {done && <p className="notice ok" role="status">{done}</p>}
      <NewAccount onCreated={after} onStart={() => setDone(null)} />

      {problem && <p className="error" role="alert">{problem}</p>}
      <label className="check"><input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} /> Show deleted accounts</label>
      {data && (data.length === 0 ? <Empty>No accounts.</Empty> : (
        <table className="table">
          <caption className="sr-only">Accounts</caption>
          <thead><tr><th scope="col">Person</th><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Changes per hour</th><th scope="col">Last sign-in</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{paged.rows.map(u => <UserLine key={u.id} u={u} self={u.id === me.id} ask={step.ask} after={after} onPassword={(password) => setShown({ who: u.username, password })} />)}</tbody>
        </table>))}
      <Pager {...paged} label="accounts" />
      {step.dialog}
    </div>
  );
}

function UserLine({ u, self, ask, after, onPassword }: { u: UserRow; self: boolean; ask: ReturnType<typeof useStepUp>["ask"]; after: (t: string) => void;
  onPassword: (p: string) => void }) {
  const [role, setRole] = useState<Role>(u.role);
  const [limit, setLimit] = useState(String(u.writeLimit));
  const [reactivating, setReactivating] = useState(false);
  const update = (change: Record<string, unknown>, what: string) => ask("user.update", u.id, <p>{what} for <strong>{u.name}</strong> ({u.username}).</p>,
    async token => { await api("PUT", `/api/admin/users/${u.id}`, { ...change, stepUpToken: token }); after(`${u.username}: ${what.toLowerCase()}.`); }, change);
  const action = (path: string, act: string, what: string, extra?: string) => ask(act, u.id, <><p>{what} for <strong>{u.name}</strong> ({u.username}).</p>{extra && <p className="notice warn">{extra}</p>}</>,
    async token => {
      const r = await api<{ temporaryPassword?: string }>("POST", `/api/admin/users/${u.id}/${path}`, { stepUpToken: token });
      if (r.temporaryPassword) onPassword(r.temporaryPassword);
      after(`${u.username}: ${what.toLowerCase()} done.`);
    });
  if (u.status === "deleted") return (
    <tr className="muted">
      <th scope="row">{u.name} <Badge tone="off">Deleted</Badge></th>
      <td><code>{u.username}</code></td>
      <td colSpan={4}>{reactivating
        ? <Reactivate id={u.id} who={u.username} onCancel={() => setReactivating(false)} onPassword={p => { onPassword(p); setReactivating(false); after(`${u.username}: reactivated.`); }} />
        : <button className="btn small" onClick={() => setReactivating(true)}>Reactivate…</button>}</td>
    </tr>);
  return (
    <tr>
      <th scope="row">{u.name}
        <div className="small">{u.online && <Badge tone="ok">Online</Badge>} {!u.totpEnabled && <Badge tone="warn">No authenticator</Badge>} {u.locked && <Badge tone="crit">Locked</Badge>}
          {u.writesPaused && <Badge tone="warn">Changes paused</Badge>}</div>
        <Link to={`/admin/users/${u.id}`} className="small">Activity</Link></th>
      <td><code>{u.username}</code></td>
      <td>
        <label className="sr-only" htmlFor={`role-${u.id}`}>Role for {u.username}</label>
        <select id={`role-${u.id}`} value={role} disabled={self} onChange={e => setRole(e.target.value as Role)}>
          {(["tier1", "tier2", "admin"] as const).map(r => <option key={r} value={r}>{roleName(r)}</option>)}</select>
        {role !== u.role && <button className="btn small primary" onClick={() => update({ role }, `Change role to ${roleName(role)}`)}>Save</button>}
        {u.role === "tier2" && (
          <label className="small row gap" title="A Tier 2 who may approve or reject the known fixes members submit. An Admin always may.">
            <input type="checkbox" checked={u.canApproveFixes} onChange={e => update({ canApproveFixes: e.target.checked }, e.target.checked ? "Allow them to approve known fixes" : "Stop them approving known fixes")} /> Approves fixes</label>)}
        {u.role === "admin" && <div className="muted small">Approves fixes</div>}
      </td>
      <td>{u.status === "active" ? <Badge tone="ok">Active</Badge> : <Badge tone="off">Disabled</Badge>}</td>
      <td>
        <label className="sr-only" htmlFor={`limit-${u.id}`}>Changes per hour for {u.username}</label>
        <input id={`limit-${u.id}`} inputMode="numeric" size={4} value={limit} onChange={e => setLimit(e.target.value.replace(/\D/g, "").slice(0, 3))} />
        {Number(limit) > 200 && <span className="error">At most 200.</span>}
        {Number(limit) !== u.writeLimit && Number(limit) >= 1 && Number(limit) <= 200 && <button className="btn small primary" onClick={() => update({ writeLimit: Number(limit) }, `Set the hourly change limit to ${limit}`)}>Save</button>}
      </td>
      <td>{u.lastLoginAt ? <span title={fullTime(u.lastLoginAt)}>{ago(u.lastLoginAt)}</span> : <span className="muted">never</span>}</td>
      <td><div className="row gap wrap">
        {!self && (u.status === "active"
          ? <button className="btn small" onClick={() => update({ status: "disabled" }, "Disable the account (their sessions end now)")}>Disable</button>
          : <button className="btn small" onClick={() => update({ status: "active" }, "Enable the account")}>Enable</button>)}
        <button className="btn small" onClick={() => action("reset-password", "user.password.reset", "Reset the password", "A temporary password is shown once; their sessions end now.")}>Reset password</button>
        {u.totpEnabled && <button className="btn small" onClick={() => action("reset-authenticator", "user.totp.reset", "Remove the authenticator", "They set up a new one at their next sign-in; their sessions end now.")}>Reset authenticator</button>}
        {u.writesPaused && <button className="btn small" onClick={() => action("resume-writes", "user.resume_writes", "Resume their changes to cabinets")}>Resume changes</button>}
        {!self && <button className="btn small danger" onClick={() => action("delete", "user.delete", "Delete the account", "They can never sign in again. Their history stays in the audit log.")}>Delete</button>}
      </div></td>
    </tr>
  );
}

interface Activity {
  user: { id: string; name: string; username: string; role: Role; status: string; lastLoginAt: string | null };
  cabinetsViewed: { id: string; name: string; views: number; lastViewedAt: string }[];
  actions: AuditRow[];
}

/** One person: the cabinets they opened and everything they did, with exact times. */
export function UserActivity({ id }: { id: string }) {
  const [range, setRange] = useState({ from: "", to: "" });
  const [query, setQuery] = useState("");
  const { data, problem } = useLoad<Activity>(`/api/admin/users/${id}/activity${query}`);
  const viewed = usePaged(data?.cabinetsViewed ?? []);
  const did = usePaged(data?.actions ?? []);
  return (
    <div className="page">
      <Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Users", to: "/admin/users" }, { label: data?.user.name ?? "Activity" }]} />
      <h1>{data ? `${data.user.name}'s activity` : "Activity"}</h1>
      {data && <p className="muted">{roleName(data.user.role)} · {data.user.username} · last sign-in {data.user.lastLoginAt ? fullTime(data.user.lastLoginAt) : "never"}</p>}
      <form className="row gap wrap" onSubmit={e => { e.preventDefault(); const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v)); setQuery(q.size ? `?${q}` : ""); }}>
        <label className="field inline"><span>From</span><input type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} /></label>
        <label className="field inline"><span>To</span><input type="date" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} /></label>
        <button className="btn">Show</button>
      </form>
      {problem && <p className="error" role="alert">{problem}</p>}
      {data && <>
        <section className="panel" aria-labelledby="viewed">
          <h2 id="viewed">Cabinets opened</h2>
          {data.cabinetsViewed.length === 0 ? <Empty>No cabinets opened in this period.</Empty> : (
            <table className="table compact">
              <caption className="sr-only">Cabinets opened, most recent first</caption>
              <thead><tr><th scope="col">Cabinet</th><th scope="col">Times opened</th><th scope="col">Last opened</th></tr></thead>
              <tbody>{viewed.rows.map(k => <tr key={k.id}><th scope="row"><Link to={`/cabinets/${k.id}`}>{k.name}</Link></th><td>{k.views}</td><td>{fullTime(k.lastViewedAt)}</td></tr>)}</tbody>
            </table>)}
          <Pager {...viewed} label="cabinets opened" />
        </section>
        <section className="panel" aria-labelledby="did">
          <h2 id="did">Everything they did</h2>
          <AuditTable rows={did.rows} />
          <Pager {...did} label="actions" />
        </section>
      </>}
    </div>
  );
}

