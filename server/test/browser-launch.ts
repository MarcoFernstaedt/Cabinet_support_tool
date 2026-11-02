// Starts the Chromium the browser tests drive. Every console e2e test launches through here, first, before it starts a database,
// a server or the demo simulator: a browser that cannot start then fails the test at once with the reason, and leaves nothing
// running that would keep the test process alive (before, the launch came after those had started, outside the try that stops
// them, so a browser that would not start left the file hanging until the runner's own limit).
import type { Browser } from "playwright";

/** Long enough for a cold start on a slow runner; Playwright's own default is three minutes. */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** Launches Chromium (the one PLAYWRIGHT_CHROMIUM names, else Playwright's own) or fails within `timeoutMs` saying which and why. */
export async function launchChromium(timeoutMs = LAUNCH_TIMEOUT_MS): Promise<Browser> {
  const { chromium } = await import("playwright");
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  try {
    return await chromium.launch({ ...(executablePath ? { executablePath } : {}), timeout: timeoutMs });
  } catch (e) {
    const which = executablePath ? `PLAYWRIGHT_CHROMIUM=${executablePath}` : "Playwright's own Chromium (PLAYWRIGHT_CHROMIUM is not set)";
    throw new Error(`Chromium did not start within ${timeoutMs / 1000} s: ${which}. ${String((e as Error).message).split("\n")[0]}`);
  }
}
