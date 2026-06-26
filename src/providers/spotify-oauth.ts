import { config } from "../config.js";

/** A Spotify OAuth token set. */
export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

const ACCOUNTS = "https://accounts.spotify.com";
export const SPOTIFY_SCOPES = "playlist-modify-public playlist-modify-private";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function basicAuthHeader(): string {
  const raw = `${config.spotify.clientId}:${config.spotify.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/** Build the Spotify authorize URL for the Authorization Code flow. */
export function authorizeUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.spotify.clientId,
    scope: SPOTIFY_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `${ACCOUNTS}/authorize?${params.toString()}`;
}

async function tokenRequest(body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Spotify token request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? (body.get("refresh_token") ?? ""),
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

/** Exchange an authorization code for a token set. */
export function exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
  return tokenRequest(
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  );
}

/** Refresh an access token, preserving the refresh token if a new one isn't returned. */
export function refreshToken(refresh: string): Promise<TokenSet> {
  return tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }));
}
