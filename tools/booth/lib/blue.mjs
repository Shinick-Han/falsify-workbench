import fs from 'node:fs';

import { BoothError } from './errors.mjs';
import {
  ADAPTER_KEYS, HARNESS_KEYS, IDEMPOTENCY_KEY, JOB_KEYS, UUID,
} from './constants.mjs';
import { sha256Hex, stableStringify } from './text.mjs';

const SETTING_KEYS = new Set(['name', 'prompt', 'model', 'effort', 'maxCalls', 'useEvidence', 'harness']);

function ownKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : null;
}

function rejectUnknown(value, allowed, label) {
  const keys = ownKeys(value);
  if (!keys) throw new BoothError('booth_config', `${label} must be an object`);
  const extra = keys.filter(key => !allowed.includes(key));
  if (extra.length) throw new BoothError('booth_config', `${label} has unknown keys: ${extra.join(', ')}`);
  return keys;
}

export function copyHarness(value) {
  rejectUnknown(value, HARNESS_KEYS, 'harness');
  const harness = {};
  if (value.schema !== undefined) {
    if (value.schema !== 'falsify.harness.v1') throw new BoothError('booth_config', 'harness.schema must be falsify.harness.v1');
    harness.schema = value.schema;
  }
  for (const key of ['id', 'name', 'version', 'instructions']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key]) throw new BoothError('booth_config', `harness.${key} must be a string`);
    harness[key] = value[key];
  }
  if (value.role !== undefined) {
    if (value.role !== 'blue') throw new BoothError('booth_config', 'harness.role must be blue');
    harness.role = 'blue';
  }
  if (value.maxCalls !== undefined) {
    if (!Number.isSafeInteger(value.maxCalls) || value.maxCalls < 1) {
      throw new BoothError('booth_config', 'harness.maxCalls must be an integer >= 1');
    }
    harness.maxCalls = value.maxCalls;
  }
  if (value.adapter !== undefined) {
    rejectUnknown(value.adapter, ADAPTER_KEYS, 'harness.adapter');
    if (value.adapter.type !== 'hosted') throw new BoothError('booth_config', 'harness.adapter.type must be hosted');
    const adapter = { type: 'hosted' };
    for (const key of ['model', 'effort']) {
      if (value.adapter[key] === undefined) continue;
      if (typeof value.adapter[key] !== 'string' || !value.adapter[key]) {
        throw new BoothError('booth_config', `harness.adapter.${key} must be a string`);
      }
      adapter[key] = value.adapter[key];
    }
    harness.adapter = adapter;
  }
  return harness;
}

// Invariant: the return value is built only from profile fields listed in SETTING_KEYS.
// pdfPath is checked so a missing file fails before a request exists. Its bytes are not copied.
export function buildBlueRequest({ pdfPath, profile }) {
  if (typeof pdfPath !== 'string' || !pdfPath) throw new BoothError('booth_config', 'pdfPath is required');
  if (!profile || typeof profile !== 'object') throw new BoothError('booth_config', 'profile is required');
  let fd;
  try {
    fd = fs.openSync(pdfPath, 'r');
    const magic = Buffer.alloc(5);
    const read = fs.readSync(fd, magic, 0, 5, 0);
    if (read < 5 || magic.toString('utf8', 0, 5) !== '%PDF-') {
      throw new BoothError('booth_local', `not a PDF: ${pdfPath}`);
    }
  } catch (error) {
    if (error instanceof BoothError) throw error;
    throw new BoothError('booth_local', `cannot read PDF: ${pdfPath}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (typeof profile.prompt !== 'string' || !profile.prompt.trim()) {
    throw new BoothError('booth_config', 'profile prompt is empty');
  }
  const prompt = profile.prompt.normalize('NFC').trim();
  const body = { role: 'blue', prompt };
  if (profile.model != null) {
    if (typeof profile.model !== 'string' || !profile.model.trim()) throw new BoothError('booth_config', 'model must be a string');
    body.model = profile.model.trim();
  }
  if (profile.effort != null) {
    if (typeof profile.effort !== 'string' || !profile.effort.trim()) throw new BoothError('booth_config', 'effort must be a string');
    body.effort = profile.effort.trim();
  }
  if (profile.maxCalls != null) {
    if (!Number.isSafeInteger(profile.maxCalls) || profile.maxCalls < 1) {
      throw new BoothError('booth_config', 'maxCalls must be an integer >= 1');
    }
    body.budget = { maxCalls: profile.maxCalls };
  }
  if (profile.useEvidence != null) {
    if (typeof profile.useEvidence !== 'boolean') throw new BoothError('booth_config', 'useEvidence must be a boolean');
    body.useEvidence = profile.useEvidence;
  }
  if (profile.harness != null) body.harness = copyHarness(profile.harness);
  for (const key of Object.keys(body)) {
    if (!JOB_KEYS.includes(key)) throw new BoothError('booth_blind', `BLUE body refused key ${key}`);
  }
  return body;
}

export function profileFingerprint(profile) {
  return {
    name: profile.name,
    model: profile.model ?? null,
    effort: profile.effort ?? null,
    maxCalls: profile.maxCalls ?? null,
    useEvidence: profile.useEvidence ?? null,
    prompt: profile.prompt,
    harness: profile.harness ?? null,
  };
}

export function configHash(profile) {
  return sha256Hex(stableStringify(profileFingerprint(profile)));
}

// Same receipt, profile, repeat, settings and edited PDF always yield the same server key.
export function idempotencyKey({ receipt, profileName, repeatIndex, configHash: hash, pdfSha256 }) {
  if (typeof pdfSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pdfSha256)) {
    throw new BoothError('booth_config', 'pdf sha256 shape');
  }
  const key = sha256Hex(`${receipt}\n${profileName}\n${repeatIndex}\n${hash}\n${pdfSha256}`);
  if (!IDEMPOTENCY_KEY.test(key)) throw new BoothError('booth_config', 'idempotency key failed shape check');
  return key;
}

export function assembleJobBody(settings, { uploadId, idempotencyKey: key }) {
  if (typeof uploadId !== 'string' || !UUID.test(uploadId)) throw new BoothError('booth_api', 'upload id is not a uuid');
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) throw new BoothError('booth_config', 'idempotency key shape');
  const forbidden = ['edits', 'visualEdits', 'applyOnly', 'declared', 'nickname', 'paper', 'reason', 'defectType', 'before', 'after'];
  for (const name of forbidden) {
    if (Object.hasOwn(settings, name)) throw new BoothError('booth_blind', `BLUE body refused ${name}`);
  }
  const body = {
    role: 'blue',
    prompt: settings.prompt,
    uploadId,
    idempotencyKey: key,
  };
  if (settings.model !== undefined) body.model = settings.model;
  if (settings.effort !== undefined) body.effort = settings.effort;
  if (settings.budget !== undefined) body.budget = { maxCalls: settings.budget.maxCalls };
  if (settings.useEvidence !== undefined) body.useEvidence = settings.useEvidence;
  if (settings.harness !== undefined) body.harness = settings.harness;
  const extra = Object.keys(body).filter(name => !JOB_KEYS.includes(name));
  if (extra.length) throw new BoothError('booth_blind', `BLUE body refused ${extra.join(', ')}`);
  return body;
}

export function allowedProfileKeys() {
  return SETTING_KEYS;
}
