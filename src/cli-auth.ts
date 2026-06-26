import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { SpotifyProvider } from "./providers/spotify.js";
import { authorizeUrl, exchangeCode, refreshToken, type TokenSet } from "./providers/spotify-oauth.js";

const TOKEN_FILE = ".spotify-token.json";

async function loadCachedToken(): Promise<TokenSet | null> {
  try {
    const cached = JSON.parse(await readFile(TOKEN_FILE, "utf8")) as TokenSet;
    if (cached.expires_at > Date.now() + 60_000) return cached;
    return await refreshToken(cached.refresh_token);
  } catch {
    return null;
  }
}

/** Run the Authorization Code flow with a loopback redirect, returning the code. */
function runLoopbackFlow(): Promise<TokenSet> {
  const redirect = new URL(config.spotify.redirectUri);
  const state = randomBytes(8).toString("hex");
  const url = authorizeUrl(state, config.spotify.redirectUri);

  return new Promise<TokenSet>((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "", `http://${req.headers.host}`);
      if (reqUrl.pathname !== redirect.pathname) return void res.writeHead(404).end();
      const error = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif"><h2>geo-music</h2>` +
          `<p>${error ? "Authorization failed." : "Authorized. You can close this tab."}</p></body></html>`,
      );
      server.close();
      if (error) return reject(new Error(`Spotify authorization error: ${error}`));
      if (returnedState !== state) return reject(new Error("OAuth state mismatch."));
      if (!code) return reject(new Error("No authorization code returned."));
      exchangeCode(code, config.spotify.redirectUri).then(resolve, reject);
    });
    server.listen(Number(redirect.port) || 80, redirect.hostname, () => {
      console.log("\nAuthorize geo-music in your browser:\n  " + url + "\n");
    });
    server.on("error", reject);
  });
}

/** Build a SpotifyProvider for the CLI, using the cached token or a fresh login. */
export async function spotifyFromCli(): Promise<SpotifyProvider> {
  if (!config.spotify.clientId || !config.spotify.clientSecret) {
    throw new Error(
      "Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Copy .env.example to .env " +
        "and fill them in (or use --dry-run, which needs no Spotify credentials).",
    );
  }
  const token = (await loadCachedToken()) ?? (await runLoopbackFlow());
  const save = (t: TokenSet) => writeFile(TOKEN_FILE, JSON.stringify(t, null, 2), "utf8");
  await save(token);
  const provider = new SpotifyProvider(token, save);
  await provider.authenticate();
  return provider;
}
