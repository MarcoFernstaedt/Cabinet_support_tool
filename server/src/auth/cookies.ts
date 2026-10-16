// The cookies the console sets, in one place: every one is HttpOnly, Secure and SameSite=Strict, and carries the __Host- prefix, which
// browsers accept only with Secure, Path=/ and no Domain, so another site or sub-domain cannot plant or overwrite it.
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "__Host-cabinet_session";
export const DEVICE_COOKIE = "__Host-cabinet_device";

/** One cookie's value from a request, or undefined. */
export function readCookie(request: Pick<FastifyRequest, "headers">, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** Adds a cookie to the reply, keeping any already set on it. */
export function setCookie(reply: FastifyReply, name: string, value: string, maxAgeSeconds: number): void {
  const header = `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  const existing = reply.getHeader("Set-Cookie");
  reply.header("Set-Cookie", existing === undefined ? header : [...(Array.isArray(existing) ? existing : [String(existing)]), header]);
}

export const clearCookie = (reply: FastifyReply, name: string): void => setCookie(reply, name, "", 0);
