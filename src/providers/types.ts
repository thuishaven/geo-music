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
}

export interface ProviderTrack {
  /** Service-native track identifier (e.g. a Spotify URI). */
  uri: string;
  name: string;
  artistName: string;
}

export interface MusicProvider {
  /** Display name of the service, for logging. */
  readonly name: string;

  /** Authenticate (user-level), so playlists can be created on their behalf. */
  authenticate(): Promise<void>;

  /** Resolve an artist name to the best catalog match, or null if not found. */
  searchArtist(name: string): Promise<ProviderArtist | null>;

  /** The artist's most popular playable track, or null if none. */
  getTopTrack(artistId: string): Promise<ProviderTrack | null>;

  /** Create an empty playlist and return its id. */
  createPlaylist(name: string, description: string): Promise<string>;

  /** Append tracks (by uri) to a playlist. */
  addTracks(playlistId: string, trackUris: string[]): Promise<void>;

  /** Human-openable URL for a created playlist (for the CLI to print). */
  playlistUrl(playlistId: string): string;
}
