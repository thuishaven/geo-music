import { config } from "../config.js";
import { refreshToken, type TokenSet } from "./spotify-oauth.js";
import type {
  MusicProvider,
  ProviderArtist,
  ProviderTrack,
} from "./types.js";

const API = "https://api.spotify.com/v1";

/** Called whenever the access token is refreshed, so callers can persist it. */
export type OnTokenRefresh = (token: TokenSet) => void | Promise<void>;

export class SpotifyProvider implements MusicProvider {
  readonly name = "Spotify";
  private userId: string | null = null;

  /**
   * @param token   an already-obtained token set (from CLI cache or a web session)
   * @param onRefresh persistence hook called when the token is refreshed
   */
  constructor(
    private token: TokenSet,
    private readonly onRefresh?: OnTokenRefresh,
  ) {}

  /** Verify the token works and capture the user id needed to create playlists. */
  async authenticate(): Promise<void> {
    this.userId = await this.fetchUserId();
  }

  // --- Authenticated API helper ---

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.token.expires_at <= Date.now() + 30_000) {
        this.token = await refreshToken(this.token.refresh_token);
        await this.onRefresh?.(this.token);
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
