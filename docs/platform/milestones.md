# What is left, by milestone

Milestones 0 to 12, the demo, crash investigation, time zones, fleet operations and evidence are built; see [status-report.md](status-report.md). This is everything that remains, in the order proposed. Sizes are rough: S is a few days, M about a week, L two weeks or more.

| Milestone | What it delivers | Size | Waiting on |
|---|---|---|---|
| **13. Ready for real cabinets** | Run the installer, broker, time and service operations on real Windows; restore the Windows CI job; sign the agent and its package; NuGet lock files in the Docker build; images pinned by digest; `__Host-` session cookie | M | GitHub Actions minutes; a code-signing certificate |
| **14. Emergency offline access** | The "Cabinet Support Diagnostics" desktop console, signed single-use emergency credentials, offline network playbook, local evidence and security log, reconciliation and alerts on reconnection ([14-emergency-access.md](../spec/14-emergency-access.md)) | L | The decisions in 09 under "Emergency offline access" |
| **15. Restarts and Windows updates** | Restart now or scheduled (all tiers); install security and quality updates (Tier 1 and 2, never restarting on its own); both as fleet operations; a site's sync cabinet never changed together with its satellites | M | Nothing; decided |
| **16. Support call workflow** | Choose a symptom, run its playbook, apply the fix, copy case notes; site readiness checklist; maintenance windows; repeated-restart and USB disconnect alerts; more network checks (routes, connections, TLS to the server) | L | Nothing |
| **17. Crash dumps and packet capture** | Minidump metadata on the cabinet; Admin-only, encrypted, time-limited upload; 60-second filtered packet capture | M | Safeguards to confirm in 09 |
| **18. Baselines and drift** | Versioned baselines per client and model (services, drivers, updates, allowlisted registry values); configuration snapshots; software inventory and approved repair or removal | L | Nothing |
| **19. Advanced diagnostics** | Performance counters and bottleneck findings; Windows servicing health (DISM and SFC as Tier 2 with a code); Defender, BitLocker, certificates, power plans | M | Nothing |

Added to the demo since the table was written: `network.renewLease` (ships in the next signed agent release, milestone 13), cabinet-only alerts, one-site bulk changes, three more scenarios (a USB device missing, low disk space, event-log errors mapped to issues) and one guided tour. Still to build for the USB alert on real cabinets: an agent monitor that reports "nothing on any USB port while a scanner is expected".

Open product questions that do not block a milestone: the third fingerprint scanner model and its hardware IDs; whether Tier 2 may delete Windows' built-in firewall rules; whether signed scripts are ever allowed (kept out for now).
