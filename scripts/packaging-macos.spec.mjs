import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {preserveZipModes} from './package-release.mjs';

test('Git ZIP carries explicit tracked Unix modes without changing contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'falsify-zip-mode-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {stdio: 'pipe'});
  try {
    git('init');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'plain.txt'), 'ordinary fixture\n');
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\nexit 0\n');
    git('add', 'plain.txt', 'run.sh');
    git('update-index', '--chmod=+x', 'run.sh');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    const archive = join(dir, 'fixture.zip');
    git('archive', '--format=zip', '--prefix=fixture/', '-o', archive, 'HEAD');
    const modes = new Map([['plain.txt', 0o100644], ['run.sh', 0o100755]]);
    writeFileSync(archive, preserveZipModes(readFileSync(archive), 'fixture/', modes));
    const python = process.env.PYTHON_EXECUTABLE || 'python3';
    execFileSync(python, ['-c', `import sys,zipfile,stat\nz=zipfile.ZipFile(sys.argv[1])\nfor name,mode in [('plain.txt',0o644),('run.sh',0o755)]:\n i=z.getinfo('fixture/'+name)\n assert i.create_system==3 and stat.S_IMODE(i.external_attr >> 16)==mode\nassert z.read('fixture/plain.txt')==b'ordinary fixture\\n'\nassert z.read('fixture/run.sh')==b'#!/bin/sh\\nexit 0\\n'`, archive]);
    assert.throws(() => preserveZipModes(readFileSync(archive), 'fixture/', new Map()), /Unexpected ZIP path/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
