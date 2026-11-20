import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { copyHarness } from './blue.mjs';
import { PROFILE_NAME, TOKEN } from './constants.mjs';
import { BoothError } from './errors.mjs';

const CONFIG_KEYS = ['apiBase', 'dataDir', 'blue', 'live'];
const LIVE_KEYS = [
  'liveProfile', 'finalProfile', 'concurrency', 'intervalSec', 'retries', 'retryBackoffMs',
  'prizeMessage', 'finalPrizeMessage', 'finalCaughtMessage', 'publicNote',
];
export const NOTE_KEYS = ['caught', 'partial', 'missed', 'missedNone'];

// Visitor-facing Korean. {page} is the finding's 1-based page, {quote} its sentence, {rationale} its reason.
// Nothing here comes from the visitor's declared edit.
export const DEFAULT_NOTES = Object.freeze({
  caught: '내가 심어 둔 결함을 AI가 찾았어요. (AI가 짚은 곳: {page}쪽)\nAI가 짚은 문장: "{quote}"\nAI 설명: {rationale}',
  partial: '내가 심어 둔 결함 근처를 AI가 짚었어요. 적발로 처리돼요. (AI가 짚은 곳: {page}쪽)\nAI가 짚은 문장: "{quote}"\nAI 설명: {rationale}',
  missed: 'AI는 다른 곳을 짚었어요. AI가 먼저 본 곳은 {page}쪽이었고, 심어 둔 결함은 AI 눈을 피했어요.',
  missedNone: 'AI가 이번 수정본에서 결함을 짚지 못했어요. 심어 둔 결함은 AI 눈을 피했어요.',
});

export function defaultLive() {
  return {
    liveProfile: 'live',
    finalProfile: 'final',
    concurrency: 12,
    intervalSec: 10,
    retries: 2,
    retryBackoffMs: 5000,
    prizeMessage: '',
    finalPrizeMessage: '',
    finalCaughtMessage: '빠른 AI는 이겼어요! 정밀 AI는 찾아냈지만, 받은 즉석 선물은 그대로 유효해요.',
    publicNote: { ...DEFAULT_NOTES },
  };
}

function boundedString(value, label, max) {
  if (typeof value !== 'string' || value.length > max) {
    throw new BoothError('booth_config', `${label} must be a string of at most ${max} characters`);
  }
  return value;
}

function copyMessages(raw, live) {
  for (const key of ['prizeMessage', 'finalPrizeMessage', 'finalCaughtMessage']) {
    if (raw[key] !== undefined) live[key] = boundedString(raw[key], `live.${key}`, 500);
  }
}

function normalizeLive(raw) {
  const live = defaultLive();
  if (raw === undefined) return live;
  rejectUnknown(raw, LIVE_KEYS, 'live');
  for (const key of ['liveProfile', 'finalProfile']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !PROFILE_NAME.test(raw[key])) throw new BoothError('booth_config', `live.${key} shape`);
    live[key] = raw[key];
  }
  if (raw.concurrency !== undefined) live.concurrency = integer(raw.concurrency, 'live.concurrency', 1, 256);
  if (raw.intervalSec !== undefined) live.intervalSec = integer(raw.intervalSec, 'live.intervalSec', 1, 3600);
  if (raw.retries !== undefined) live.retries = integer(raw.retries, 'live.retries', 0, 10);
  if (raw.retryBackoffMs !== undefined) live.retryBackoffMs = integer(raw.retryBackoffMs, 'live.retryBackoffMs', 0, 600000);
  copyMessages(raw, live);
  if (raw.publicNote !== undefined) {
    rejectUnknown(raw.publicNote, NOTE_KEYS, 'live.publicNote');
    for (const key of NOTE_KEYS) {
      if (raw.publicNote[key] !== undefined) live.publicNote[key] = boundedString(raw.publicNote[key], `live.publicNote.${key}`, 1000);
    }
  }
  return live;
}
const BLUE_KEYS = ['concurrency', 'repeat', 'profiles', 'pollIntervalMs', 'pollTimeoutMs'];
const PROFILE_FILE_KEYS = ['name', 'model', 'effort', 'maxCalls', 'useEvidence', 'prompt', 'promptFile', 'harness', 'harnessFile'];

export function integer(value, label, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new BoothError('booth_config', `${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function booleanFlag(value, label) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new BoothError('booth_config', `${label} must be true or false`);
}

function rejectUnknown(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoothError('booth_config', `${label} must be an object`);
  }
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new BoothError('booth_config', `${label} has unknown keys: ${extra.join(', ')}`);
}

export function readToken(env) {
  const token = env.FALSIFY_BOOTH_TOKEN;
  if (!token) throw new BoothError('booth_auth', 'FALSIFY_BOOTH_TOKEN is not set');
  if (!TOKEN.test(token)) throw new BoothError('booth_auth', 'FALSIFY_BOOTH_TOKEN does not match the operator token shape');
  return token;
}

export function loadConfigFile(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof BoothError) throw error;
    throw new BoothError('booth_config', `cannot read config: ${error.message}`);
  }
  rejectUnknown(raw, CONFIG_KEYS, 'config');
  const config = {
    apiBase: '',
    dataDir: '',
    blue: { concurrency: 1, repeat: 1, profiles: [], pollIntervalMs: 200, pollTimeoutMs: 900000 },
    live: normalizeLive(raw.live),
  };
  if (raw.apiBase !== undefined) {
    if (typeof raw.apiBase !== 'string') throw new BoothError('booth_config', 'apiBase must be a string');
    config.apiBase = raw.apiBase;
  }
  if (raw.dataDir !== undefined && raw.dataDir !== null) {
    if (typeof raw.dataDir !== 'string') throw new BoothError('booth_config', 'dataDir must be a string');
    config.dataDir = raw.dataDir;
  }
  if (raw.blue !== undefined) {
    rejectUnknown(raw.blue, BLUE_KEYS, 'blue');
    if (raw.blue.concurrency !== undefined) config.blue.concurrency = integer(raw.blue.concurrency, 'concurrency', 1, 256);
    if (raw.blue.repeat !== undefined) config.blue.repeat = integer(raw.blue.repeat, 'repeat', 1, 50);
    if (raw.blue.pollIntervalMs !== undefined) config.blue.pollIntervalMs = integer(raw.blue.pollIntervalMs, 'pollIntervalMs', 10, 60000);
    if (raw.blue.pollTimeoutMs !== undefined) config.blue.pollTimeoutMs = integer(raw.blue.pollTimeoutMs, 'pollTimeoutMs', 100, 3600000);
    if (raw.blue.profiles !== undefined) {
      if (!Array.isArray(raw.blue.profiles)) throw new BoothError('booth_config', 'profiles must be an array');
      config.blue.profiles = raw.blue.profiles.map(profile => normalizeProfile(profile));
    }
  }
  config.configDir = path.dirname(path.resolve(file));
  return config;
}

function normalizeProfile(profile) {
  rejectUnknown(profile, PROFILE_FILE_KEYS, 'profile');
  if (typeof profile.name !== 'string' || !PROFILE_NAME.test(profile.name)) {
    throw new BoothError('booth_config', 'profile name must match [A-Za-z0-9._:-]{1,64}');
  }
  const next = { name: profile.name };
  if (profile.model !== undefined) next.model = requiredString(profile.model, 'model');
  if (profile.effort !== undefined) next.effort = requiredString(profile.effort, 'effort');
  if (profile.maxCalls !== undefined) next.maxCalls = integer(profile.maxCalls, 'maxCalls', 1, Number.MAX_SAFE_INTEGER);
  if (profile.useEvidence !== undefined) next.useEvidence = booleanFlag(profile.useEvidence, 'useEvidence');
  if (profile.prompt !== undefined) next.prompt = requiredString(profile.prompt, 'prompt');
  if (profile.promptFile !== undefined) next.promptFile = requiredString(profile.promptFile, 'promptFile');
  if (profile.harness !== undefined) next.harness = copyHarness(profile.harness);
  if (profile.harnessFile !== undefined) next.harnessFile = requiredString(profile.harnessFile, 'harnessFile');
  return next;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new BoothError('booth_config', `${label} must be a non-empty string`);
  return value;
}

export function emptyConfig() {
  return {
    apiBase: '',
    dataDir: '',
    configDir: process.cwd(),
    blue: { concurrency: 1, repeat: 1, profiles: [], pollIntervalMs: 200, pollTimeoutMs: 900000 },
    live: defaultLive(),
  };
}

export function resolveDataDir(config, flags, home = os.homedir()) {
  const chosen = (flags.dataDir && flags.dataDir !== true ? flags.dataDir : '') || config.dataDir || path.join(home, 'falsify-booth-data');
  return path.resolve(chosen);
}

export function resolveApiBase(config, flags) {
  const base = (flags.api && flags.api !== true ? flags.api : '') || config.apiBase;
  if (!base) throw new BoothError('booth_config', 'set apiBase in config or pass --api');
  return base;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new BoothError('booth_config', `cannot read ${file}: ${error.message}`);
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    if (error instanceof BoothError) throw error;
    throw new BoothError('booth_config', `cannot parse ${file}: ${error.message}`);
  }
}

function resolveBlueProfiles(config, flags) {
  const selected = flags.profile && flags.profile !== true ? String(flags.profile) : '';
  let profiles = config.blue.profiles.slice();
  if (!selected && config.live) {
    // watch and final own their profiles; a plain `blue` run does not bill them too.
    const reserved = new Set([config.live.liveProfile, config.live.finalProfile]);
    const batch = profiles.filter(profile => !reserved.has(profile.name));
    if (batch.length) profiles = batch;
  }
  if (selected) {
    const found = profiles.find(profile => profile.name === selected);
    if (!found) {
      if (!PROFILE_NAME.test(selected)) throw new BoothError('booth_config', 'profile name shape');
      profiles = [{ name: selected }];
    } else {
      profiles = [found];
    }
  }
  if (!profiles.length) throw new BoothError('booth_config', 'blue needs at least one profile');
  return profiles.map(profile => materializeProfile(profile, flags, config.configDir));
}

function materializeProfile(profile, flags, configDir) {
  const next = { ...profile };
  if (flags.model && flags.model !== true) next.model = String(flags.model);
  if (flags.effort && flags.effort !== true) next.effort = String(flags.effort);
  if (flags.maxCalls !== undefined && flags.maxCalls !== true) next.maxCalls = integer(flags.maxCalls, 'maxCalls', 1, Number.MAX_SAFE_INTEGER);
  if (flags.useEvidence !== undefined && flags.useEvidence !== true) next.useEvidence = booleanFlag(flags.useEvidence, 'useEvidence');
  if (flags.promptFile && flags.promptFile !== true) {
    next.prompt = readText(path.resolve(flags.promptFile));
    delete next.promptFile;
  } else if (next.promptFile) {
    next.prompt = readText(path.resolve(configDir, next.promptFile));
    delete next.promptFile;
  }
  if (flags.harnessFile && flags.harnessFile !== true) {
    next.harness = copyHarness(readJsonFile(path.resolve(flags.harnessFile)));
    delete next.harnessFile;
  } else if (next.harnessFile) {
    next.harness = copyHarness(readJsonFile(path.resolve(configDir, next.harnessFile)));
    delete next.harnessFile;
  }
  if (typeof next.prompt !== 'string' || !next.prompt.trim()) {
    throw new BoothError('booth_config', `profile ${next.name} needs a prompt or --prompt-file`);
  }
  return next;
}

export function resolveBluePlan(config, flags) {
  const repeat = flags.repeat !== undefined && flags.repeat !== true
    ? integer(flags.repeat, 'repeat', 1, 50)
    : config.blue.repeat;
  const concurrency = flags.concurrency !== undefined && flags.concurrency !== true
    ? integer(flags.concurrency, 'concurrency', 1, 256)
    : config.blue.concurrency;
  return {
    profiles: resolveBlueProfiles(config, flags),
    repeat,
    concurrency,
    pollIntervalMs: config.blue.pollIntervalMs,
    pollTimeoutMs: config.blue.pollTimeoutMs,
  };
}

export function loadConfig(flags) {
  if (flags.config && flags.config !== true) return loadConfigFile(String(flags.config));
  return emptyConfig();
}
