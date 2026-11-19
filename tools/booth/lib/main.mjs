import { parseArgv } from './argv.mjs';
import {
  announce, blue, closeBooth, draw, exportCommand, judge, list, missions,
  openBooth, publish, pull, score, status, unpublish,
} from './commands.mjs';
import { USAGE } from './constants.mjs';
import { loadConfig, readToken } from './config.mjs';
import { BoothError } from './errors.mjs';
import { finalCommand, watch } from './live.mjs';

const COMMANDS = {
  status,
  list,
  pull,
  blue,
  score,
  judge,
  publish,
  unpublish,
  draw,
  export: exportCommand,
  missions,
  open: openBooth,
  close: closeBooth,
  announce,
  watch,
  final: finalCommand,
};

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, env: process.env }) {
  const parsed = parseArgv(argv);
  if (parsed.flags.help || !parsed.command || parsed.command === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  const token = readToken(io.env);
  const config = loadConfig(parsed.flags);
  const command = COMMANDS[parsed.command];
  if (!command) throw new BoothError('booth_config', `unknown command ${parsed.command}`);
  await command({
    io,
    token,
    config,
    flags: parsed.flags,
    rest: parsed.rest,
  });
  return 0;
}
