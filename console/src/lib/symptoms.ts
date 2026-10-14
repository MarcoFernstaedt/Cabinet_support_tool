// Which Troubleshoot symptom fits an alert, chosen from plain words in its title.
/** The symptom id to start from for an alert; null when none fits. */
export function symptomForAlert(title: string): string | null {
  const t = title.toLowerCase();
  const rules: [string[], string][] = [[["scanner", "fingerprint", "biometric"], "scanner"], [["drive", "disk", "smart", "storage"], "disk"], [["blue screen", "crash", "restart", "reboot", "unexpected shutdown"], "restart"],
    [["service"], "service"], [["update"], "update"], [["sync", "firewall"], "sync"], [["network", "dns", "dhcp", "gateway", "packet", "offline"], "network"], [["slow", "memory", "cpu", "performance"], "slow"]];
  for (const [words, id] of rules) if (words.some(w => t.includes(w))) return id;
  return null;
}

