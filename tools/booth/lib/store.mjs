import fs from 'node:fs';
import path from 'node:path';

import { RECEIPT } from './constants.mjs';
import { BoothError } from './errors.mjs';
import { sha256Hex } from './text.mjs';

export function assertReceipt(receipt) {
  if (typeof receipt !== 'string' || !RECEIPT.test(receipt)) {
    throw new BoothError('booth_config', `receipt shape: ${receipt}`);
  }
  return receipt;
}

export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeJson(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readJsonOptional(file) {
  try {
    return readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function submissionDir(dataDir, receipt) {
  assertReceipt(receipt);
  return path.join(dataDir, 'submissions', receipt);
}

export function pdfPath(dataDir, receipt) {
  return path.join(submissionDir(dataDir, receipt), 'edited.pdf');
}

export function blueRecordPath(dataDir, receipt, profileName, repeatIndex, hash) {
  assertReceipt(receipt);
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(profileName)) throw new BoothError('booth_config', 'profile name shape');
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new BoothError('booth_config', 'config hash shape');
  return path.join(dataDir, 'blue', receipt, profileName, String(repeatIndex), `${hash}.json`);
}

export function listReceipts(dataDir) {
  const dir = path.join(dataDir, 'submissions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => RECEIPT.test(name))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

export function loadSubmission(dataDir, receipt) {
  const row = readJsonOptional(path.join(submissionDir(dataDir, receipt), 'submission.json'));
  if (!row) throw new BoothError('booth_local', `missing pull for ${receipt}`);
  return row;
}

export function fileSha256(file) {
  return sha256Hex(fs.readFileSync(file));
}

export function loadBlueRecords(dataDir, receipt) {
  const dir = path.join(dataDir, 'blue', receipt);
  if (!fs.existsSync(dir)) return [];
  const records = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(next);
      else if (entry.name.endsWith('.json')) {
        const record = readJsonOptional(next);
        if (record) records.push(record);
      }
    }
  }
  records.sort((a, b) => {
    const name = String(a.profile).localeCompare(String(b.profile));
    if (name) return name;
    return Number(a.repeat) - Number(b.repeat);
  });
  return records;
}
