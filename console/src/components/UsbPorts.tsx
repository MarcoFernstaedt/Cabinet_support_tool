// USB ports of one cabinet: every hub and device with its hub and port, what is connected now, problem codes, and the fingerprint scanner
// picked out. Answers "is the scanner on a port, and which one" without anyone touching the machine.
import { useEffect, useMemo } from "react";
import type { UsbPortsOutput } from "@mashura/cabinet-contracts/types";
import { useOperation } from "../lib/commands";
import { analyseUsb, type UsbDevice } from "../lib/usb";
import { Badge, OperationPanel } from "./ui";

export function UsbPorts({ cabinetId, scannerIds = [], scannerName = null }: { cabinetId: string; scannerIds?: string[]; scannerName?: string | null }) {
  const op = useOperation<UsbPortsOutput>(cabinetId, "usb.ports");
  useEffect(() => { void op.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const out = op.result?.output ?? null;
  const analysis = useMemo(() => out ? analyseUsb(out.devices as UsbDevice[], scannerIds, scannerName, out.truncated) : null, [out, scannerIds.join("|"), scannerName]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <OperationPanel title="USB ports" run={op} onRun={() => void op.start()} buttonLabel="Read ports">
      {() => analysis && (<>
        <p className={`notice ${analysis.tone === "ok" ? "ok" : analysis.tone === "crit" ? "crit" : "warn"}`} role="status">{analysis.summary}</p>
        {analysis.issues.length > 1 && <ul>{analysis.issues.slice(1).map((i, k) => <li key={k}>{i.text}</li>)}</ul>}
        <div className="table-wrap"><table className="table compact">
          <caption className="sr-only">USB ports</caption>
          <thead><tr><th scope="col">Hub</th><th scope="col">Port</th><th scope="col">Device</th><th scope="col">State</th><th scope="col">Detail</th></tr></thead>
          <tbody>{analysis.rows.map(r => (
            <tr key={r.device.instanceId} className={r.scanner ? "highlight" : undefined}>
              <td>{r.device.hubNumber ?? "–"}</td><td>{r.device.portNumber ?? "–"}</td>
              <th scope="row">{r.device.name}{r.scanner && <> <Badge tone="info">Scanner</Badge></>}</th>
              <td><Badge tone={r.tone === "crit" ? "crit" : r.tone === "warn" ? "warn" : r.tone === "ok" ? "ok" : "off"}>{r.state === "problem" ? "Problem" : r.state === "connected" ? "Connected" : "Not connected"}</Badge></td>
              <td>{r.note ?? ""}</td>
            </tr>))}</tbody>
        </table></div>
      </>)}
    </OperationPanel>
  );
}
