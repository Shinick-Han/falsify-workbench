import {spawnSync} from 'node:child_process';

for (const file of ['document-red.spec.cjs', 'document-blue.spec.cjs', 'harness-core.spec.cjs', 'cleanup-static.spec.cjs', 'local-bridge.spec.cjs', 'red-binding.spec.cjs']) {
  const result = spawnSync(process.execPath, ['tests/' + file], {stdio: 'inherit'});
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
