import { randomBytes } from "node:crypto";
import type { TokenSet } from "../providers/spotify-oauth.js";

/**
 * A per-visitor session. Stored in memory, keyed by a cookie — simple and fine
 * for a single on-prem instance (a restart logs everyone out, which is
 * acceptable for v1). Swap for a shared/persistent store if scaled out.
 */
export interface Session {
  token?: TokenSet;
  /** CSRF state for an in-flight OAuth login. */
  oauthState?: string;
}

const sessions = new Map<string, Session>();

export function createSession(): { sid: string; session: Session } {
  const sid = randomBytes(16).toString("hex");
  const session: Session = {};
  sessions.set(sid, session);
  return { sid, session };
}

export function getSession(sid: string | undefined): Session | undefined {
  return sid ? sessions.get(sid) : undefined;
}
