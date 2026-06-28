import { readFile, writeFile, mkdir } from "node:fs/promises";
import { SpotifyProvider } from "../src/providers/spotify.js";
import { refreshToken, type TokenSet } from "../src/providers/spotify-oauth.js";
import { buildPlaylist } from "../src/pipeline.js";

/**
 * Pre-generate the public demo gallery: build a handful of iconic routes as
 * PUBLIC playlists (so the Spotify embed works for anyone) and save each plan to
 * public/demo/<slug>.json, plus an index. Run with the CLI's cached token:
 *
 *   npx tsx scripts/build-demos.ts
 */
const ROUTES: Array<{ slug: string; from: string; to: string }> = [
  { slug: "amsterdam-paris", from: "Amsterdam", to: "Paris" },
  { slug: "lisbon-porto", from: "Lisbon", to: "Porto" },
  { slug: "munich-milan", from: "Munich", to: "Milan" },
  { slug: "berlin-prague", from: "Berlin", to: "Prague" },
];

const TOKEN_FILE = ".spotify-token.json";
const DEMO_DIR = "public/demo";

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
  await mkdir(DEMO_DIR, { recursive: true });
  const index: Array<{ slug: string; from: string; to: string; playlistId: string; tracks: number }> = [];

  for (const route of ROUTES) {
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
