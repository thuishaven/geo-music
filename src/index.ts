import { buildPlaylist } from "./pipeline.js";
import { SpotifyProvider } from "./providers/spotify.js";

function usage(): never {
  console.error(`\ngeo-music — Phase 0 prototype\n\n` +
    `Usage:\n  npm start -- "<from>" "<to>"\n\n` +
    `Example:\n  npm start -- "Amsterdam" "Paris"\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) usage();

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
