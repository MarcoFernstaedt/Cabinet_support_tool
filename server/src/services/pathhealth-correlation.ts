// The correlation the console actually asks for: "was there loss or a timeout while the sync was failing?"
// (docs/platform/improvement-plan.md §4 B3/B4; docs/platform/research/2026-10/audit-network.md §10).
//
// The rule that matters most here is a negative one: ICMP silence is not loss. If a TCP connect to the same address succeeded, the
// address is reachable, so the silence is packet filtering and saying "loss" would send a technician to replace a working cable.
// A refusal is not loss either: the address answered and the port said no, which is a listener or a firewall rule. What is left is
// real evidence of an unresponsive path: a partly lost ICMP series, a wholly silent series with nothing answering, or a TCP attempt
// that timed out with no answer at all.
//
// The builder lives in this file, not in pathhealth-analysis.ts, so that module never has to import this one (no cycle): it takes
// summaries in, and this file is what turns them into the stored report.
import type { PathHealthCorrelation, PathHealthFailureWindow, PathHealthFinding, PathHealthReport, PathHealthSample, PathHealthSampleSet, PathHealthTargetSummary } from "./pathhealth-contracts.js";
import { parseReport } from "./pathhealth-contracts.js";
import { LOSS_THRESHOLD_PERCENT, icmpPartiallyLost, icmpSilent, reportWindow, summariseTargets } from "./pathhealth-analysis.js";

const timeOf = (value: string): number => Date.parse(value);

interface SampleClass {
  loss: boolean;
  timeout: boolean;
  refused: boolean;
  /** ICMP silent while a TCP connect to the same address succeeded: filtering, and never loss. */
  filtered: boolean;
}

/**
 * Classifies one sample. The ICMP verdict always yields to the TCP evidence:
 * a silent series next to a successful connect is filtering, and a silence with nothing answering is loss.
 */
export function classifySample(sample: PathHealthSample): SampleClass {
  const icmp = sample.icmp;
  const tcp = sample.tcp;
  const tcpWorking = tcp !== null && tcp.connected > 0;
  const timeout = (tcp !== null && tcp.timedOut > 0) || sample.result === "timeout";
  const refused = (tcp !== null && tcp.refused > 0) || sample.result === "refused";
  const partialLoss = icmp !== null && icmp.received > 0 && icmp.received < icmp.sent && icmp.lossPercent >= LOSS_THRESHOLD_PERCENT;
  const silent = icmp !== null && icmp.sent > 0 && icmp.received === 0;
  return {
    loss: partialLoss || (silent && !tcpWorking),
    timeout,
    refused,
    filtered: silent && tcpWorking && !timeout,
  };
}

/**
 * What the samples say about one failed-sync window.
 * `measured` is false when no sample covers the window at all: the answer is then "nothing was measured", never "the path was fine".
 */
export function correlate(set: PathHealthSampleSet, window: PathHealthFailureWindow | null, now: number): PathHealthCorrelation {
  const from = window ? timeOf(window.from) : null;
  const to = window ? (window.to === null ? now : timeOf(window.to)) : null;
  const inWindow = set.samples.filter(s => {
    const at = timeOf(s.at);
    if (from !== null && at < from) return false;
    if (to !== null && at > to) return false;
    return true;
  });
  const classes = inWindow.map(classifySample);
  const measured = inWindow.length > 0;
  const lossDuringWindow = classes.some(c => c.loss || c.timeout);
  const timeoutsDuringWindow = classes.some(c => c.timeout);
  const refusalsDuringWindow = classes.some(c => c.refused);
  const icmpFiltered = classes.some(c => c.filtered);

  if (!measured) return { measured: false, lossDuringWindow: false, timeoutsDuringWindow: false, refusalsDuringWindow: false, icmpFiltered: false, interpretation: "not_measured", confidence: "not_checked" };
  if (lossDuringWindow) return { measured: true, lossDuringWindow: true, timeoutsDuringWindow, refusalsDuringWindow, icmpFiltered, interpretation: "loss_during_window", confidence: "probable" };
  if (refusalsDuringWindow) return { measured: true, lossDuringWindow: false, timeoutsDuringWindow, refusalsDuringWindow, icmpFiltered, interpretation: "application_or_listener", confidence: "probable" };
  // A successful connect while ICMP stayed silent is proof of filtering: the address is reachable, the echo is dropped on purpose.
  if (icmpFiltered) return { measured: true, lossDuringWindow: false, timeoutsDuringWindow, refusalsDuringWindow, icmpFiltered, interpretation: "packet_filtering", confidence: "confirmed" };
  return { measured: true, lossDuringWindow: false, timeoutsDuringWindow, refusalsDuringWindow, icmpFiltered, interpretation: "path_clean", confidence: window === null ? "possible" : "probable" };
}

const targetLine = (summary: PathHealthTargetSummary): string => {
  const where = `${summary.kind === "sync_cabinet" ? "sync cabinet" : "platform"} ${summary.address}${summary.port === null ? "" : `:${summary.port}`}`;
  const icmp = summary.icmp === null ? "ICMP not measured" : `${summary.icmp.sent} sent, ${summary.icmp.received} replied (${summary.icmp.lossPercent}% loss)`;
  const tcp = summary.tcp === null ? "TCP not measured" : `${summary.tcp.connected}/${summary.tcp.attempts} connects, ${summary.tcp.refused} refused, ${summary.tcp.timedOut} timed out`;
  const rtt = summary.icmp?.avgMs == null ? "no reply times" : `reply times min ${summary.icmp.minMs} / avg ${summary.icmp.avgMs} / max ${summary.icmp.maxMs} ms, worst series ${summary.icmp.maxLossPercent}% loss`;
  return `${where}: ${icmp}; ${tcp}; ${rtt}.`;
};

const windowLine = (window: PathHealthFailureWindow): string =>
  `Failed sync window ${window.from} to ${window.to ?? "now"}, ${window.failedChecks} failed ${window.failedChecks === 1 ? "check" : "checks"}.`;

/**
 * The findings for one window, in the same shape the network diagnosis uses.
 * A finding is raised when the measurements support it; when they do not, the report says what was and was not measured instead of guessing.
 */
export function pathHealthFindings(input: { set: PathHealthSampleSet; summaries: readonly PathHealthTargetSummary[]; correlation: PathHealthCorrelation; window: PathHealthFailureWindow | null }): PathHealthFinding[] {
  const { summaries, correlation, window } = input;
  const findings: PathHealthFinding[] = [];
  const measured = summaries.filter(s => s.icmp !== null || s.tcp !== null);
  const lines = measured.map(targetLine);
  const sync = summaries.filter(s => s.kind === "sync_cabinet");
  const platform = summaries.filter(s => s.kind === "platform_server");

  if (!correlation.measured) {
    findings.push({
      id: "pathhealth-not-measured", layer: "sync", severity: "info", certainty: "not_checked",
      title: "No sync-path samples cover this window",
      evidence: window ? [windowLine(window), `Stored samples: ${input.set.samples.length}.`, "Nothing about the path can be concluded from a window with no samples in it."] : ["No failed sync window and no samples."],
      fix: "Check that this cabinet reports path-health samples and that its sample budget was not exhausted, then correlate the window again.",
    });
    return findings;
  }

  if (correlation.interpretation === "loss_during_window") {
    const details = measured.filter(s => (s.icmp !== null && (icmpPartiallyLost(s.icmp) || icmpSilent(s.icmp))) || (s.tcp !== null && s.tcp.timedOut > 0));
    findings.push({
      id: "pathhealth-loss-window", layer: "sync", severity: "problem", certainty: correlation.confidence,
      title: correlation.timeoutsDuringWindow ? "Packet loss and no answer on the sync path during the failed sync window" : "Packet loss on the sync path during the failed sync window",
      evidence: [
        ...(window ? [windowLine(window)] : []),
        ...(details.length > 0 ? details.map(targetLine) : lines),
        "Loss on both ICMP and TCP to the same address points at the path itself: the cable, the switch port, the powerline adapter or the Wi-Fi link.",
      ],
      fix: "Check the cable, the switch port and the powerline or access point between this cabinet and the sync cabinet, then measure again; the sync failures are consistent with dropped packets on the way.",
    });
  }

  if (correlation.refusalsDuringWindow && !correlation.lossDuringWindow) {
    const refused = measured.filter(s => s.tcp !== null && s.tcp.refused > 0);
    findings.push({
      id: "pathhealth-refused", layer: "sync", severity: "problem", certainty: "probable",
      title: "The sync port refuses connections while the address answers",
      evidence: [
        ...(window ? [windowLine(window)] : []),
        ...(refused.length > 0 ? refused.map(targetLine) : lines),
        "A refusal means the address answered and the port said no: the path carried the packet, so the listener or a firewall rule on the sync cabinet is what to look at, not the network.",
      ],
      fix: "Check that the sync service is running on the sync cabinet and listening on the port this site is configured for, and check the sync cabinet's own firewall rule for that port.",
    });
  }

  // Raised whether or not the window is otherwise clean: it is the finding that keeps a silent ICMP series from being read as loss.
  if (correlation.icmpFiltered) {
    const silent = measured.filter(s => s.icmp !== null && icmpSilent(s.icmp));
    findings.push({
      id: "pathhealth-icmp-filtered", layer: "firewall", severity: "info", certainty: "confirmed",
      title: "The sync target does not answer ping, but its port answers: this is packet filtering, not packet loss",
      evidence: [
        ...(silent.length > 0 ? silent.map(targetLine) : lines),
        "ICMP silence is not evidence of loss here: TCP connect to the same address succeeded in the same window, so the address is reachable and the echo requests are being dropped on purpose.",
      ],
      fix: "No network fault to fix. If the platform needs a ping answer from this site, allow ICMP echo requests from the sync cabinet; the path itself is working.",
    });
  }

  if (correlation.interpretation === "path_clean" && window !== null) {
    findings.push({
      id: "pathhealth-clean-path", layer: "sync", severity: "warning", certainty: correlation.confidence,
      title: "The path was clean while the sync failed",
      evidence: [
        windowLine(window),
        ...lines,
        "Every sample in the failed window reached the sync target, so the failure is more likely to be the sync service or its settings than the network path.",
      ],
      fix: "Look at the sync service on the sync cabinet (is it running, which port is it on, what does its own log show for these times) and at this site's sync settings.",
    });
  }

  const syncBad = sync.some(s => s.state === "loss" || s.state === "loss_and_timeouts" || s.state === "timeouts");
  const platformFine = platform.every(s => s.state === "ok" || s.state === "filtering" || s.state === "not_measured");
  if (syncBad && platformFine && platform.some(s => s.state === "ok" || s.state === "filtering")) {
    findings.push({
      id: "pathhealth-asymmetric", layer: "sync", severity: "warning", certainty: "possible",
      title: "The sync cabinet looks worse than the platform endpoint",
      evidence: [
        ...sync.map(targetLine),
        ...platform.map(targetLine),
        "Loss confined to the same-site hop points at the local segment (switch port, cable, powerline adapter) rather than at the Internet connection.",
      ],
      fix: "Test the local segment: another switch port, another patch cable, and the sync cabinet's link speed and duplex.",
    });
  }

  if (window === null && correlation.interpretation === "path_clean" && summaries.every(s => s.state === "ok" || s.state === "filtering" || s.state === "not_measured")) {
    findings.push({
      id: "pathhealth-ok", layer: "sync", severity: "ok", certainty: "possible",
      title: "Sync path measured clean",
      evidence: lines,
      fix: null,
    });
  }

  return findings;
}

/**
 * The whole report: summaries, correlation and findings, checked against the report contract before it leaves the server.
 * A refused report is a bug in this file, so the contract error is allowed to surface.
 */
export function buildPathHealthReport(input: { set: PathHealthSampleSet; now: number; window: PathHealthFailureWindow | null; dropped: number }): PathHealthReport {
  const summaries = summariseTargets(input.set);
  const correlation = correlate(input.set, input.window, input.now);
  return parseReport({
    cabinetId: input.set.cabinetId,
    siteId: input.set.siteId,
    window: reportWindow(input.set, input.dropped),
    syncFailureWindow: input.window,
    targets: summaries,
    correlation,
    findings: pathHealthFindings({ set: input.set, summaries, correlation, window: input.window }),
  });
}

/** The one-line answer for a console badge, from a report that is already trusted. */
export function correlationSummary(correlation: PathHealthCorrelation): string {
  switch (correlation.interpretation) {
    case "loss_during_window": return "loss measured during the failed sync window";
    case "packet_filtering": return "no answer to ping, but the port answers: filtering, not loss";
    case "application_or_listener": return "the sync port refused connections: the listener, not the path";
    case "path_clean": return "no loss or timeout measured in the window";
    default: return "not measured";
  }
}
