// A whole console for browser tests: a database, the console API serving the built console, and one Admin who signs in with a code.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Page } from "playwright";
import { buildConsoleApi } from "../src/console-api/server.js";
import { ResultStream } from "../src/console-api/stream.js";
import { SecretBox } from "../src/auth/secrets.js";
import { hashPassword } from "../src/auth/passwords.js";
import * as totp from "../src/auth/totp.js";
import { developmentIssuingKey } from "../src/pki/issuing.js";
import { createTestDatabase, type TestDatabase, startFeed } from "./database.js";
import { tempDir } from "./helpers.js";

const freePort = (): Promise<number> => new Promise(r => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

export interface Console {
  db: TestDatabase; origin: string; adminId: string; password: string;
  /** A current authenticator code (moves the test clock on, so each code is new). */
  code(): Promise<string>;
  signIn(page: Page): Promise<void>;
  /** Another person, with the same password and authenticator as the Admin, who has not seen the welcome tour. */
  addUser(username: string, role: "tier1" | "tier2" | "admin", canApproveFixes?: boolean): Promise<string>;
  /** Signs in and stops at what the person sees first: the welcome tour, if they have not had it. */
  signInAs(page: Page, username: string): Promise<void>;
  /** From the signed-in Fleet page: sets the guided demo up (the simulated fleet) and closes its panel. */
  startDemo(page: Page): Promise<void>;
  /** Confirms the open dialog with a fresh authenticator code. */
  confirmWithCode(page: Page): Promise<void>;
  close(): Promise<void>;
}

/**
 * How long turning demo mode on may take before the tour shows (D17, D27): measured at 16.6 to 18.6 s on an idle machine, two test files run
 * at once, and a loaded machine stretches it further. One limit for every test that turns the demo on.
 */
export const DEMO_ON_LIMIT_MS = 90_000;

/** A fresh install with one Admin (username ada.admin) who has not yet seen the getting-started tour. */
export async function startConsole(staticDir: string): Promise<Console> {
  const db = await createTestDatabase();
  let clock = Date.now();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new SecretBox(randomBytes(32).toString("base64"));
  const stream = new ResultStream(await startFeed(db), db.app);
  await stream.start();
  const app = await buildConsoleApi({ pool: db.app, secrets, issuingKey: await developmentIssuingKey(tempDir()), origin, stream, staticDir, ...(process.env.LOGS ? {} : { logger: false }), now: () => clock });
  await app.listen({ host: "127.0.0.1", port });
  const password = "correct horse battery staple";
  const secret = totp.newSecret();
  const adminId = randomUUID();
  const passwordHash = await hashPassword(password);
  await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed)
                      VALUES ($1, 'ada.admin', 'Ada Admin', 'admin', $2, 0, 1, $3, 0)`, [adminId, passwordHash, secrets.seal(secret)]);
  const code = async () => { clock += 30_000; return totp.code(secret, totp.stepAt(clock)); };
  const signInAs = async (page: Page, username: string) => {
    await page.goto(origin);
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel(/6-digit code/).fill(await code());
    await page.getByRole("button", { name: "Continue" }).click();
  };
  const confirmWithCode = async (page: Page) => {
    await page.getByRole("dialog").getByLabel("Authenticator code").fill(await code());
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  };
  return {
    db, origin, adminId, password, code,
    signInAs,
    async signIn(page) {
      await signInAs(page, "ada.admin");
      await page.getByRole("button", { name: "Skip tour" }).click();
      await page.getByRole("heading", { name: "Fleet", level: 1 }).waitFor();
    },
    async addUser(username, role, canApproveFixes = false) {
      const id = randomUUID();
      await db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, tour_completed, can_approve_fixes)
                          VALUES ($1, $2, $3, $4, $5, 0, 1, $6, 0, $7)`, [id, username, `Test ${username}`, role, passwordHash, secrets.seal(secret), canApproveFixes]);
      return id;
    },
    confirmWithCode,
    async startDemo(page) {
      await page.getByRole("link", { name: "Admin", exact: true }).click();
      await page.locator("ul.tiles").getByRole("link", { name: /Setup/ }).click();
      await page.getByRole("button", { name: "Start the guided demo" }).click();
      await confirmWithCode(page);
      await page.locator("aside.demo-tour").getByRole("heading", { name: "Site overview" }).waitFor({ timeout: DEMO_ON_LIMIT_MS });
      await page.locator("aside.demo-tour").getByRole("button", { name: "Stop" }).click();
    },
    async close() { await app.close(); await stream.stop(); await db.drop(); },
  };
}
