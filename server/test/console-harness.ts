// What the console API tests share: signing people in with their authenticator, calling the API as them, and getting an
// authenticator-code token bound to one action. Each test file makes one harness and points it at its app.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { paramsHash } from "../src/auth/canonical.js";
import { hashPassword } from "../src/auth/passwords.js";
import type { SecretBox } from "../src/auth/secrets.js";
import * as totp from "../src/auth/totp.js";
import type { TestDatabase } from "./database.js";

export const ORIGIN = "https://console.test";
export type Role = "tier1" | "tier2" | "admin";
export interface Account { id: string; username: string; password: string; secret: Buffer; cookie?: string }

export class ConsoleHarness {
  /** The clock the app is built with (`now: () => harness.clock`); every code moves it on, so each is a fresh 30-second step. */
  clock = Date.now();
  app!: FastifyInstance;
  db!: TestDatabase;

  constructor(private readonly secrets: SecretBox) {}

  /** Makes an account with an authenticator and signs it in. */
  async account(role: Role, writeLimit = 100): Promise<Account> {
    const a: Account = { id: randomUUID(), username: `${role}.${randomBytes(3).toString("hex")}`, password: "correct horse battery staple", secret: totp.newSecret() };
    await this.db.app.query(`INSERT INTO users (id, username, name, role, password_hash, must_change_password, totp_enabled, totp_secret_enc, write_limit)
                             VALUES ($1, $2, $3, $4, $5, false, true, $6, $7)`, [a.id, a.username, `Test ${a.username}`, role, await hashPassword(a.password), this.secrets.seal(a.secret), writeLimit]);
    const login = await this.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ username: a.username, password: a.password }) });
    a.cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    assert.equal((await this.call("POST", "/api/auth/totp", { code: this.code(a) }, a)).body.stage, "complete");
    return a;
  }

  /** The next authenticator code for this person. */
  code(a: Account): string { this.clock += 30_000; return totp.code(a.secret, totp.stepAt(this.clock)); }

  async call(method: "GET" | "POST" | "PUT", url: string, body: unknown, a?: Account) {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (a?.cookie) headers.cookie = a.cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await this.app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    let parsed: any = r.body; try { parsed = JSON.parse(r.body); } catch { /* not JSON */ }
    return { status: r.statusCode, body: parsed };
  }

  /** An authenticator-code token for one action on one target, bound to the exact parameters. */
  async codeToken(a: Account, action: string, target: string, params: unknown): Promise<string> {
    const r = await this.call("POST", "/api/auth/step-up", { code: this.code(a), action, target, paramsHash: paramsHash(params) }, a);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token as string;
  }
}
