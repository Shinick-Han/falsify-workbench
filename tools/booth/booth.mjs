import { BoothError, scrub } from './lib/errors.mjs';
import { main } from './lib/main.mjs';

// Exit through exitCode so a result written to stdout is flushed.
try {
  process.exitCode = await main(process.argv);
} catch (error) {
  const secret = process.env.FALSIFY_BOOTH_TOKEN;
  if (error instanceof BoothError) {
    process.stderr.write(`booth: ${error.code}: ${scrub(error.message, secret)}\n`);
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write(`booth: booth_internal: ${scrub(error instanceof Error ? error.message : String(error), secret)}\n`);
    process.exitCode = 1;
  }
}
