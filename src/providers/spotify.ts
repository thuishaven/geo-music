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
    if (!config.spotify.clientId || !config.spotify.clientSecret) {
      throw new Error(
        "Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Copy .env.example to .env " +
          "and fill them in (or use --dry-run, which needs no Spotify credentials).",
      );
    }
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
    for (let attempt = 0; attempt < 3; attempt++) {
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
      if (res.status === 429 || res.status >= 500) {
        // Retry on rate-limit (honouring Retry-After) and transient 5xx errors.
        const wait = (Number(res.headers.get("retry-after")) || 2) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Spotify ${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`);
      }
      return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    }
    throw new Error(`Spotify ${init.method ?? "GET"} ${path} failed after rate-limit retries.`);
  }

  private async fetchUserId(): Promise<string> {
    const me = await this.api<{ id: string }>("/me");
    return me.id;
  }

  // --- MusicProvider surface ---

  /** Normalize an artist name for strict comparison (case/diacritics/punctuation). */
  private static normalize(s: string): string {
    return s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  async searchArtist(
    name: string,
  ): Promise<{ strict: ProviderArtist | null; top: ProviderArtist | null }> {
    const q = encodeURIComponent(name);
    const data = await this.api<{
      artists: { items: Array<{ id: string; name: string; popularity: number; genres?: string[] }> };
    }>(`/search?q=${q}&type=artist&limit=10`);
    const items = data.artists.items;
    const toArtist = (a: (typeof items)[number]): ProviderArtist => ({
      id: a.id,
      name: a.name,
      popularity: a.popularity,
      genres: (a.genres ?? []).map((g) => g.toLowerCase()),
    });
    // Strict: a result whose name matches (so "MOLLY" can't become "Molly
    // Santana"); among matches take the most popular. Top: most relevant result.
    const target = SpotifyProvider.normalize(name);
    const strictHit = items
      .filter((a) => SpotifyProvider.normalize(a.name) === target)
      .sort((a, b) => b.popularity - a.popularity)[0];
    return {
      strict: strictHit ? toArtist(strictHit) : null,
      top: items[0] ? toArtist(items[0]) : null,
    };
  }

  async getArtistById(id: string): Promise<ProviderArtist | null> {
    const a = await this.api<{ id: string; name: string; popularity: number; genres?: string[] }>(
      `/artists/${id}`,
    );
    return a
      ? { id: a.id, name: a.name, popularity: a.popularity, genres: (a.genres ?? []).map((g) => g.toLowerCase()) }
      : null;
  }

  async getTopTracks(artistId: string, limit: number): Promise<ProviderTrack[]> {
    const data = await this.api<{
      tracks: Array<{
        uri: string;
        name: string;
        duration_ms: number;
        popularity: number;
        artists: Array<{ name: string; id: string }>;
      }>;
    }>(`/artists/${artistId}/top-tracks?market=${config.spotify.market}`);
    return data.tracks.slice(0, limit).map((t) => ({
      uri: t.uri,
      name: t.name,
      artistName: t.artists[0]?.name ?? "",
      artistIds: t.artists.map((a) => a.id),
      artistNames: t.artists.map((a) => a.name),
      popularity: t.popularity,
      durationMs: t.duration_ms,
    }));
  }

  async getArtistGenres(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const data = await this.api<{ artists: Array<{ id: string; genres?: string[] } | null> }>(
        `/artists?ids=${batch.join(",")}`,
      );
      for (const a of data.artists) {
        if (a) out.set(a.id, (a.genres ?? []).map((g) => g.toLowerCase()));
      }
    }
    return out;
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
