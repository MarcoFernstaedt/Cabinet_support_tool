// Sign-ins: the list (a person's own, or every account's for an Admin) with the ones from a device or network not used before marked, and
// the notice shown right after such a sign-in. The server decides what is new; this only shows it.
import { useState } from "react";
import { useLoad } from "../lib/useLoad";
import { fullTime } from "../lib/time";
import { Link } from "../lib/router";
import { Badge, Empty } from "./ui";
import { Pager, usePaged } from "./Pager";

export interface SignInRow { id: number; at: string; username: string; name: string; address: string; network: string; device: string; newNetwork: boolean; newDevice: boolean; completed: boolean }

const marks = (s: SignInRow) => <>
  {s.newDevice && <Badge tone="warn">New device</Badge>}{s.newDevice && s.newNetwork && " "}{s.newNetwork && <Badge tone="warn">New network</Badge>}
  {!s.newDevice && !s.newNetwork && <span className="muted">Known</span>}{!s.completed && <> <Badge tone="off">Not finished</Badge></>}</>;

export function SignInTable({ rows, showPerson }: { rows: SignInRow[]; showPerson: boolean }) {
  const paged = usePaged(rows);
  if (rows.length === 0) return <Empty>No sign-ins to show.</Empty>;
  return (<>
    <div className="table-wrap"><table className="table compact">
      <caption className="sr-only">Sign-ins, newest first</caption>
      <thead><tr><th scope="col">When</th>{showPerson && <th scope="col">Person</th>}<th scope="col">Device</th><th scope="col">Network</th><th scope="col">Address</th><th scope="col">Status</th></tr></thead>
      <tbody>{paged.rows.map(s => (
        <tr key={s.id}>
          <th scope="row">{fullTime(s.at)}</th>
          {showPerson && <td><Link to="/admin/users">{s.name}</Link> <span className="muted small">{s.username}</span></td>}
          <td>{s.device}</td><td className="small">{s.network}</td><td className="small">{s.address}</td><td>{marks(s)}</td>
        </tr>))}</tbody>
    </table></div>
    <Pager {...paged} label="sign-ins" />
  </>);
}

/** A person's own recent sign-ins. */
export function OwnSignIns() {
  const { data, problem } = useLoad<{ signIns: SignInRow[] }>("/api/auth/sign-ins");
  return (<>{problem && <p className="error" role="alert">{problem}</p>}{data && <SignInTable rows={data.signIns} showPerson={false} />}</>);
}

/** Every account's sign-ins, all or only the new ones (Admin). */
export function AllSignIns() {
  const [scope, setScope] = useState<"new" | "all">("new");
  const { data, problem } = useLoad<{ signIns: SignInRow[] }>(`/api/admin/sign-ins?scope=${scope}`);
  return (<>
    <div className="row gap" role="group" aria-label="Show sign-ins">
      {(["new", "all"] as const).map(s => <button key={s} className={`btn small ${scope === s ? "primary" : ""}`} aria-pressed={scope === s} onClick={() => setScope(s)}>{s === "new" ? "New device or network" : "All"}</button>)}
    </div>
    {problem && <p className="error" role="alert">{problem}</p>}
    {data && <SignInTable rows={data.signIns} showPerson />}
  </>);
}

/** Said once, right after a sign-in from a device or network the account had not used: if it was not you, tell an Admin. */
export function SignInNotice() {
  const { data } = useLoad<{ signIn: SignInRow | null }>("/api/auth/me");
  const [gone, setGone] = useState(false);
  const s = data?.signIn;
  const key = s ? `signin-notice-${s.id}` : "";
  const seen = (() => { try { return key !== "" && sessionStorage.getItem(key) !== null; } catch { return false; } })();
  if (!s || (!s.newDevice && !s.newNetwork) || gone || seen) return null;
  const dismiss = () => { try { sessionStorage.setItem(key, "1"); } catch { /* storage unavailable */ } setGone(true); };
  return (
    <div className="banner warn" role="status">
      This sign-in is from {s.newDevice && s.newNetwork ? "a device and a network" : s.newDevice ? "a device" : "a network"} your account had not used before ({s.device}, {s.address}).
      {" "}If it was not you, tell an Admin now. <Link to="/account">Your recent sign-ins</Link> · <button className="linkish" onClick={dismiss}>Dismiss</button>
    </div>
  );
}
