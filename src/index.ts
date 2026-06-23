import { buildPlaylist } from "./pipeline.js";
import { previewRoute } from "./preview.js";
import { SpotifyProvider } from "./providers/spotify.js";

function usage(): never {
  console.error(`\ngeo-music — Phase 0 prototype\n\n` +
    `Usage:\n  npm start -- [--dry-run] "<from>" "<to>"\n\n` +
    `Examples:\n  npm start -- "Amsterdam" "Paris"\n` +
    `  npm start -- --dry-run "Amsterdam" "Paris"   # no Spotify needed\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [from, to] = args.filter((a) => a !== "--dry-run");
  if (!from || !to) usage();

  if (dryRun) {
    await previewRoute(from, to);
    return;
  }

  const provider = new SpotifyProvider();
  await provider.authenticate();

  const result = await buildPlaylist(provider, from, to);

  console.log(
    `\n✓ Created playlist: ${result.trackCount} tracks across ${result.placeCount} places, ` +
      `~${result.actualMinutes} min (target ~${result.targetMinutes} min).\n` +
      `  ${result.url}\n`,
  );
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
