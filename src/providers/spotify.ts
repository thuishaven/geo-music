import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import type {
  MusicProvider,
  ProviderArtist,
  ProviderTrack,
} from "./types.js";

const ACCOUNTS = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";
const SCOPES = "playlist-modify-public playlist-modify-private";
const TOKEN_FILE = ".spotify-token.json";

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

interface SpotifyTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function basicAuthHeader(): string {
  const raw = `${config.spotify.clientId}:${config.spotify.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

export class SpotifyProvider implements MusicProvider {
  readonly name = "Spotify";
  private token: TokenSet | null = null;
  private userId: string | null = null;

  async authenticate(): Promise<void> {
    this.token = (await this.loadCachedToken()) ?? (await this.runOAuthFlow());
    this.userId = await this.fetchUserId();
  }

  // --- OAuth (Authorization Code flow with loopback redirect) ---

  private async loadCachedToken(): Promise<TokenSet | null> {
    try {
      const raw = await readFile(TOKEN_FILE, "utf8");
      const cached = JSON.parse(raw) as TokenSet;
      if (cached.expires_at > Date.now() + 60_000) return cached;
      // Expired: refresh it.
      return await this.refresh(cached.refresh_token);
    } catch {
      return null; // No cache yet.
    }
  }

  private async runOAuthFlow(): Promise<TokenSet> {
    const redirect = new URL(config.spotify.redirectUri);
    const state = randomBytes(8).toString("hex");
    const authUrl =
      `${ACCOUNTS}/authorize?response_type=code` +
      `&client_id=${encodeURIComponent(config.spotify.clientId)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(config.spotify.redirectUri)}` +
      `&state=${state}`;

    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const reqUrl = new URL(req.url ?? "", `http://${req.headers.host}`);
        if (reqUrl.pathname !== redirect.pathname) {
          res.writeHead(404).end();
          return;
        }
        const error = reqUrl.searchParams.get("error");
        const returnedCode = reqUrl.searchParams.get("code");
        const returnedState = reqUrl.searchParams.get("state");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body style="font-family:sans-serif">` +
            `<h2>geo-music</h2><p>${error ? "Authorization failed." : "Authorized. You can close this tab."}</p>` +
            `</body></html>`,
        );
        server.close();
        if (error) return reject(new Error(`Spotify authorization error: ${error}`));
        if (returnedState !== state) return reject(new Error("OAuth state mismatch."));
        if (!returnedCode) return reject(new Error("No authorization code returned."));
        resolve(returnedCode);
      });
      server.listen(Number(redirect.port) || 80, redirect.hostname, () => {
        console.log("\nAuthorize geo-music in your browser:\n  " + authUrl + "\n");
      });
      server.on("error", reject);
    });

    return await this.exchangeCode(code);
  }

  private async exchangeCode(code: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.spotify.redirectUri,
    });
    const data = await this.tokenRequest(body);
    const token: TokenSet = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? "",
      expires_at: Date.now() + data.expires_in * 1000,
    };
    await this.saveToken(token);
    return token;
  }

  private async refresh(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const data = await this.tokenRequest(body);
    const token: TokenSet = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    await this.saveToken(token);
    return token;
  }

  private async tokenRequest(body: URLSearchParams): Promise<SpotifyTokenResponse> {
    const res = await fetch(`${ACCOUNTS}/api/token`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`Spotify token request failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as SpotifyTokenResponse;
  }

  private async saveToken(token: TokenSet): Promise<void> {
    this.token = token;
    await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), "utf8");
  }

  // --- Authenticated API helper ---

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token) throw new Error("Not authenticated. Call authenticate() first.");
    if (this.token.expires_at <= Date.now() + 30_000) {
      this.token = await this.refresh(this.token.refresh_token);
    }
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token.access_token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Spotify ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  private async fetchUserId(): Promise<string> {
    const me = await this.api<{ id: string }>("/me");
    return me.id;
  }

  // --- MusicProvider surface ---

  async searchArtist(name: string): Promise<ProviderArtist | null> {
    const q = encodeURIComponent(name);
    const data = await this.api<{
      artists: { items: Array<{ id: string; name: string; popularity: number }> };
    }>(`/search?q=${q}&type=artist&limit=1`);
    const hit = data.artists.items[0];
    return hit ? { id: hit.id, name: hit.name, popularity: hit.popularity } : null;
  }

  async getTopTrack(artistId: string): Promise<ProviderTrack | null> {
    const data = await this.api<{
      tracks: Array<{ uri: string; name: string; artists: Array<{ name: string }> }>;
    }>(`/artists/${artistId}/top-tracks?market=${config.spotify.market}`);
    const top = data.tracks[0];
    return top
      ? { uri: top.uri, name: top.name, artistName: top.artists[0]?.name ?? "" }
      : null;
  }

  async createPlaylist(name: string, description: string): Promise<string> {
    if (!this.userId) throw new Error("No user id; authenticate() first.");
    const playlist = await this.api<{ id: string }>(`/users/${this.userId}/playlists`, {
      method: "POST",
      body: JSON.stringify({ name, description, public: false }),
    });
    return playlist.id;
  }

  async addTracks(playlistId: string, trackUris: string[]): Promise<void> {
    // Spotify accepts at most 100 uris per request.
    for (let i = 0; i < trackUris.length; i += 100) {
      const batch = trackUris.slice(i, i + 100);
      await this.api(`/playlists/${playlistId}/tracks`, {
        method: "POST",
        body: JSON.stringify({ uris: batch }),
      });
    }
  }

  playlistUrl(playlistId: string): string {
    return `https://open.spotify.com/playlist/${playlistId}`;
  }
}
