// A browser that cannot start fails at once, or within the launch limit, and says which browser and why; nothing is left running.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChromium } from "./browser-launch.js";

async function withBrowserPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PLAYWRIGHT_CHROMIUM;
  process.env.PLAYWRIGHT_CHROMIUM = path;
  try { return await fn(); } finally { if (before === undefined) delete process.env.PLAYWRIGHT_CHROMIUM; else process.env.PLAYWRIGHT_CHROMIUM = before; }
}

test("a browser path that does not exist is refused at once, naming the path", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "no-browser-")), "chrome");
  const started = Date.now();
  await withBrowserPath(missing, () => assert.rejects(launchChromium(5_000), (e: Error) => e.message.includes(`PLAYWRIGHT_CHROMIUM=${missing}`)));
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});

test("a browser that starts but never answers is given up on at the launch limit, not left hanging", { skip: process.platform === "win32" ? "needs a shell script" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "silent-browser-"));
  const silent = join(dir, "chrome");
  writeFileSync(silent, "#!/bin/sh\nexec sleep 600\n");
  chmodSync(silent, 0o755);
  const started = Date.now();
  await withBrowserPath(silent, () => assert.rejects(launchChromium(3_000), (e: Error) => e.message.includes("did not start within 3 s") && e.message.includes(silent)));
  const took = Date.now() - started;
  assert.ok(took >= 2_500 && took < 15_000, `took ${took} ms`);
});
