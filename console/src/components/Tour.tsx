// The getting-started tour: shown at first sign-in, and again from Account whenever wanted.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { atLeast, useSession } from "../lib/session";

const STEPS = (admin: boolean) => [
  { title: "Welcome to Cabinet Diagnostics", body: "This console reads what Windows reports on each cabinet so you can find problems without remoting in. Everything you open and run is recorded with your name." },
  { title: "Find a cabinet", body: "Go Fleet → client → site → cabinet, or type any client, site, cabinet or Windows host name into the jump box at the top of every page." },
  { title: "The cabinet view", body: "The cabinet's name, client, site and role stay at the top. The sidebar lists the other cabinets at the same site for one-click switching. Sections cover event logs, the fingerprint scanner, devices, updates, drives, network, firewall and files." },
  { title: "Fingerprint scanner", body: "One click runs the standard scanner troubleshooting on the cabinet: plugged in, Windows errors, driver, USB power saving, repeated reconnects, USB hub problems and the biometric service. Each check says what to try next. If the scanner's hardware ID is not set yet, it lists the likely scanners so you can pick it." },
  { title: "Event logs", body: "Browse every readable log, filter by level, time, source and event ID, and open any entry in full, including its raw XML. Logs turned off in Windows are marked." },
  { title: "Drive health", body: "Check SMART health before a drive fails. Any reallocated or pending sectors mean it is time to send the client a replacement drive." },
  ...(admin ? [{ title: "Admin", body: "Admin holds pending cabinets for approval, install tokens for new cabinets, the fleet's scanner hardware IDs and the audit log. Every admin action asks for your authenticator code." }] : []),
  { title: "You're set", body: "You can run this tour again any time from your Account page." },
];

export function Tour({ onClose }: { onClose: () => void }) {
  const { me } = useSession();
  const steps = STEPS(atLeast(me, "admin"));
  const [i, setI] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const finish = () => { void api("POST", "/api/auth/tour-complete", {}).catch(() => undefined); ref.current?.close(); onClose(); };
  const step = steps[i]!;
  return (
    <dialog ref={ref} className="dialog tour" aria-labelledby="tour-title" aria-describedby="tour-body" onCancel={finish}>
      <p className="muted small">Step {i + 1} of {steps.length}</p>
      <h2 id="tour-title">{step.title}</h2>
      <p id="tour-body">{step.body}</p>
      <div className="row gap between">
        <button className="btn ghost" onClick={finish}>Skip tour</button>
        <div className="row gap">
          <button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>Back</button>
          {i < steps.length - 1 ? <button className="btn primary" autoFocus onClick={() => setI(i + 1)}>Next</button>
            : <button className="btn primary" autoFocus onClick={finish}>Finish</button>}
        </div>
      </div>
    </dialog>
  );
}
