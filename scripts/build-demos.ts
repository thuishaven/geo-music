import { readFile, writeFile, mkdir } from "node:fs/promises";
import { SpotifyProvider } from "../src/providers/spotify.js";
import { refreshToken, type TokenSet } from "../src/providers/spotify-oauth.js";
import { buildPlaylist } from "../src/pipeline.js";

/**
 * Pre-generate the public demo gallery: build the routes in demo-routes.json as
 * PUBLIC playlists (so the Spotify embed works for anyone) and save each plan to
 * public/demo/<slug>.json, plus an index. Run with the CLI's cached token:
 *
 *   npm run demos        (after npm start has cached a token)
 *
 * Curate your own gallery by editing demo-routes.json, then set
 * ENABLE_DEMO_GALLERY=true to show it on the homepage.
 */
type Route = { slug: string; from: string; to: string };

const TOKEN_FILE = ".spotify-token.json";
const ROUTES_FILE = "demo-routes.json";
const DEMO_DIR = "public/demo";

async function loadRoutes(): Promise<Route[]> {
  return JSON.parse(await readFile(ROUTES_FILE, "utf8")) as Route[];
}

async function loadProvider(): Promise<SpotifyProvider> {
  let token = JSON.parse(await readFile(TOKEN_FILE, "utf8")) as TokenSet;
  if (token.expires_at <= Date.now() + 60_000) token = await refreshToken(token.refresh_token);
  const save = (t: TokenSet) => writeFile(TOKEN_FILE, JSON.stringify(t, null, 2), "utf8");
  await save(token);
  const provider = new SpotifyProvider(token, save);
  await provider.authenticate();
  return provider;
}

async function main(): Promise<void> {
  const provider = await loadProvider();
  const routes = await loadRoutes();
  await mkdir(DEMO_DIR, { recursive: true });
  const index: Array<{ slug: string; from: string; to: string; playlistId: string; tracks: number }> = [];

  for (const route of routes) {
    console.log(`\n=== ${route.from} → ${route.to} ===`);
    try {
      const result = await buildPlaylist(provider, route.from, route.to, { public: true });
      await writeFile(`${DEMO_DIR}/${route.slug}.json`, JSON.stringify(result.plan), "utf8");
      index.push({
        slug: route.slug,
        from: route.from,
        to: route.to,
        playlistId: result.playlistId,
        tracks: result.trackCount,
      });
      console.log(`  saved ${route.slug}.json (${result.trackCount} tracks)`);
    } catch (err) {
      console.error(`  skipped ${route.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await writeFile(`${DEMO_DIR}/index.json`, JSON.stringify(index, null, 2), "utf8");
  console.log(`\nWrote ${index.length} demo(s) to ${DEMO_DIR}/index.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
