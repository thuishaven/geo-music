/**
 * The provider-agnostic contract from SPEC.md §5. The whole geo pipeline is
 * shared; only this last mile differs per music service. Spotify is implemented
 * first; Apple Music slots in later as a second implementation.
 */
export interface ProviderArtist {
  id: string;
  name: string;
  /** Provider popularity (0-100 for Spotify), used to rank artists. */
  popularity: number;
  /** Genre tags (lowercased), used to limit classical density per segment. */
  genres: string[];
}

export interface ProviderTrack {
  /** Service-native track identifier (e.g. a Spotify URI). */
  uri: string;
  name: string;
  artistName: string;
  /** All credited artist ids, so co-credits (orchestras, narrators) can be vetted. */
  artistIds: string[];
  /** All credited artist names (stable, unlike genres) for name-based vetting. */
  artistNames: string[];
  /** Track popularity (0-100); used to drop novelty/low-quality top tracks. */
  popularity: number;
  /** Track length in milliseconds, used to size the playlist to the drive. */
  durationMs: number;
}

export interface MusicProvider {
  /** Display name of the service, for logging. */
  readonly name: string;

  /** Authenticate (user-level), so playlists can be created on their behalf. */
  authenticate(): Promise<void>;

  /** Resolve an artist name to a strict (name-matching) catalog match, or null. */
  searchArtist(name: string): Promise<ProviderArtist | null>;

  /** Fetch an artist directly by catalog id (used for MB-link resolution). */
  getArtistById(id: string): Promise<ProviderArtist | null>;

  /**
   * The artist's most popular playable tracks (up to `limit`), most popular
   * first. Returns fewer (or none) if the artist has fewer playable tracks.
   */
  getTopTracks(artistId: string, limit: number): Promise<ProviderTrack[]>;

  /** Look up genres (lowercased) for a batch of artist ids, keyed by id. */
  getArtistGenres(ids: string[]): Promise<Map<string, string[]>>;

  /** Create an empty playlist and return its id. */
  createPlaylist(name: string, description: string): Promise<string>;

  /** Append tracks (by uri) to a playlist. */
  addTracks(playlistId: string, trackUris: string[]): Promise<void>;

  /** Human-openable URL for a created playlist (for the CLI to print). */
  playlistUrl(playlistId: string): string;
}
