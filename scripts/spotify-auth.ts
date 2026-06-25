import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { config } from "../src/config.js";

/**
 * Manual OAuth helper for headless/remote setups where the loopback redirect
 * (127.0.0.1:8888) isn't reachable from your browser. Two steps:
 *
 *   npx tsx scripts/spotify-auth.ts                 # prints the authorize URL
 *   npx tsx scripts/spotify-auth.ts "<code or url>" # exchanges + caches token
 *
 * The cached token (.spotify-token.json) is then picked up by `npm start`.
 */
const ACCOUNTS = "https://accounts.spotify.com";
const SCOPES = "playlist-modify-public playlist-modify-private";
const TOKEN_FILE = ".spotify-token.json";

function basicAuth(): string {
  const raw = `${config.spotify.clientId}:${config.spotify.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

function authorizeUrl(): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.spotify.clientId,
    scope: SCOPES,
    redirect_uri: config.spotify.redirectUri,
  });
  return `${ACCOUNTS}/authorize?${params.toString()}`;
}

/** Accept either a raw code or the full pasted redirect URL. */
function extractCode(input: string): string {
  if (input.includes("code=")) {
    try {
      const code = new URL(input).searchParams.get("code");
      if (code) return code;
    } catch {
      /* not a URL, fall through */
    }
  }
  return input.trim();
}

async function exchange(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.spotify.redirectUri,
  });
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? "",
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), "utf8");
  console.log(`\n✓ Saved token to ${TOKEN_FILE}. You can now run: npm start -- "Amsterdam" "Paris"\n`);
}

const arg = process.argv[2];
if (!arg) {
  console.log(
    `\n1) Open this URL, log in to Spotify, click Agree:\n\n  ${authorizeUrl()}\n\n` +
      `2) Your browser will redirect to ${config.spotify.redirectUri} and probably show a\n` +
      `   "can't connect" error — that's expected. Copy the full address from the address\n` +
      `   bar (it contains ...?code=...), then run:\n\n` +
      `   npx tsx scripts/spotify-auth.ts "<paste the code or full URL here>"\n`,
  );
} else {
  exchange(extractCode(arg)).catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
