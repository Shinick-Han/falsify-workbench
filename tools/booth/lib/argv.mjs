function camel(flag) {
  return flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Flags may appear before or after the command. A value never starts with "--".
export function parseArgv(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[camel(body.slice(0, eq))] = body.slice(eq + 1);
      continue;
    }
    const key = camel(body);
    const next = args[i + 1];
    if (next == null || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return {
    command: positionals[0] || '',
    rest: positionals.slice(1),
    flags,
  };
}
