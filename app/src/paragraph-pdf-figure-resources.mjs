/* AGPL-3.0-only. Keep form resource names resolvable before PDFium flattens a figure. */
const KINDS = ['ExtGState', 'Font', 'XObject', 'ColorSpace', 'Properties', 'Pattern', 'Shading'];
const DELIM = '%()<>[]{}/%';
export const FIGURE_TEXT_REFUSAL = '그림 안 글자를 고치면 그림이 깨져서 만들지 않았습니다. 표·그래프·그림 고치기를 쓰세요.';

function latin(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return text;
}

function ascii(text) {
  return Uint8Array.from(text, ch => ch.charCodeAt(0));
}

function isDelim(byte) {
  return byte <= 32 || DELIM.indexOf(String.fromCharCode(byte)) >= 0;
}

function liveDict(dict) {
  return Boolean(dict && !dict.isNull() && dict.isDictionary());
}

function childDict(dict, key) {
  if (!liveDict(dict)) return null;
  const child = dict.get(key);
  return liveDict(child) ? child : null;
}

function entries(dict) {
  if (!liveDict(dict)) return [];
  const out = [];
  dict.forEach((value, key) => out.push([String(key).replace(/^\//, ''), value]));
  return out;
}

function isForm(obj) {
  if (!obj || obj.isNull?.() || !obj.isStream?.()) return false;
  try { return obj.get('Subtype')?.asName?.() === 'Form'; }
  catch { return false; }
}

function concatBytes(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function skipLine(bytes, i) {
  while (i < bytes.length && bytes[i] !== 10 && bytes[i] !== 13) i++;
  return i;
}

function skipLiteral(bytes, i) {
  let depth = 1;
  i++;
  while (i < bytes.length && depth) {
    if (bytes[i] === 92) { i += 2; continue; }
    if (bytes[i] === 40) depth++;
    else if (bytes[i] === 41) depth--;
    i++;
  }
  return i;
}

function skipHex(bytes, i) {
  i++;
  while (i < bytes.length && bytes[i] !== 62) i++;
  return i < bytes.length ? i + 1 : i;
}

function skipInert(bytes, i) {
  const c = bytes[i];
  if (c === 37) return skipLine(bytes, i);
  if (c === 40) return skipLiteral(bytes, i);
  if (c === 60 && bytes[i + 1] !== 60) return skipHex(bytes, i);
  return i;
}

function pushName(bytes, i, map, parts) {
  let j = i + 1;
  while (j < bytes.length && !isDelim(bytes[j])) j++;
  const next = map.get(latin(bytes.subarray(i + 1, j)));
  parts.push(next ? ascii('/' + next) : bytes.subarray(i, j));
  return j;
}

function rewriteNames(bytes, map) {
  const parts = [];
  let i = 0;
  while (i < bytes.length) {
    const skipped = skipInert(bytes, i);
    if (skipped > i) { parts.push(bytes.subarray(i, skipped)); i = skipped; continue; }
    if (bytes[i] === 47) { i = pushName(bytes, i, map, parts); continue; }
    parts.push(bytes.subarray(i, i + 1));
    i++;
  }
  return concatBytes(parts);
}

function freshName(taken, counter) {
  let name = 'Fg' + counter.n;
  while (taken.has(name)) { counter.n += 1; name = 'Fg' + counter.n; }
  counter.n += 1;
  taken.add(name);
  return name;
}

function ensureDict(doc, parent, key) {
  const current = parent.get(key);
  if (liveDict(current)) return current;
  return parent.put(key, doc.newDictionary());
}

function placeOnPages(doc, pages, kind, name, value) {
  for (const page of pages) ensureDict(doc, ensureDict(doc, page, 'Resources'), kind).put(name, value);
}

function renameKinds(doc, pages, taken, counter, resources) {
  const map = new Map();
  for (const kind of KINDS) {
    const dict = childDict(resources, kind);
    for (const [name, value] of entries(dict)) {
      const renamed = freshName(taken, counter);
      dict.delete(name);
      dict.put(renamed, value);
      map.set(name, renamed);
      placeOnPages(doc, pages, kind, renamed, value);
    }
  }
  return map;
}

function promoteForm(doc, pages, taken, counter, seen, obj) {
  if (!isForm(obj)) return;
  const id = obj.isIndirect() ? obj.asIndirect() : 0;
  if (id && seen.has(id)) return;
  if (id) seen.add(id);
  const resources = childDict(obj, 'Resources');
  if (!resources) return;
  for (const [, value] of entries(childDict(resources, 'XObject'))) promoteForm(doc, pages, taken, counter, seen, value);
  const map = renameKinds(doc, pages, taken, counter, resources);
  if (map.size) obj.writeStream(rewriteNames(obj.readStream().asUint8Array(), map));
}

function pageObjects(doc) {
  const pages = [];
  for (let i = 0; i < doc.countPages(); i++) pages.push(doc.findPage(i));
  return pages;
}

function takenNames(pages) {
  const taken = new Set();
  for (const page of pages) {
    const resources = childDict(page, 'Resources');
    for (const kind of KINDS) for (const [name] of entries(childDict(resources, kind))) taken.add(name);
  }
  return taken;
}

function savedBytes(doc) {
  const saved = doc.saveToBuffer('garbage=0,compress=false');
  try { return saved.asUint8Array().slice(); }
  finally { saved.destroy(); }
}

export function promoteFormResources(bytes, mupdf) {
  const doc = new mupdf.PDFDocument(bytes);
  try {
    const pages = pageObjects(doc);
    const taken = takenNames(pages);
    const counter = {n: 1};
    const seen = new Set();
    for (const page of pages) {
      for (const [, value] of entries(childDict(childDict(page, 'Resources'), 'XObject'))) {
        promoteForm(doc, pages, taken, counter, seen, value);
      }
    }
    return savedBytes(doc);
  } finally { doc.destroy(); }
}

function pdfLiteral(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = '(';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return '';
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\';
    out += ch;
  }
  return out + ')';
}

function editNeedles(edits) {
  const needles = [];
  if (!Array.isArray(edits)) return needles;
  for (const edit of edits) {
    const literal = pdfLiteral(edit?.before);
    if (literal) needles.push(ascii(literal));
  }
  return needles;
}

function indexOfBytes(hay, needle) {
  if (!needle.length || hay.length < needle.length) return -1;
  for (let i = 0; i <= hay.length - needle.length; i++) {
    let same = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) same = false;
    if (same) return i;
  }
  return -1;
}

function formHolds(obj, needles, seen) {
  if (!isForm(obj)) return false;
  const id = obj.isIndirect() ? obj.asIndirect() : 0;
  if (id && seen.has(id)) return false;
  if (id) seen.add(id);
  const raw = obj.readStream().asUint8Array();
  for (const needle of needles) if (indexOfBytes(raw, needle) >= 0) return true;
  for (const [, value] of entries(childDict(childDict(obj, 'Resources'), 'XObject'))) {
    if (formHolds(value, needles, seen)) return true;
  }
  return false;
}

function documentHolds(doc, needles) {
  const seen = new Set();
  for (let index = 0; index < doc.countPages(); index++) {
    const resources = childDict(doc.findPage(index), 'Resources');
    for (const [, value] of entries(childDict(resources, 'XObject'))) {
      if (formHolds(value, needles, seen)) return true;
    }
  }
  return false;
}

export function formStreamsHoldEdits(bytes, edits, mupdf) {
  const needles = editNeedles(edits);
  if (!needles.length) return false;
  const doc = new mupdf.PDFDocument(bytes);
  try { return documentHolds(doc, needles); }
  finally { doc.destroy(); }
}

function tokensOf(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const skipped = skipInert(bytes, i);
    if (skipped > i) { i = skipped; continue; }
    if (bytes[i] <= 32) { i++; continue; }
    if (bytes[i] === 47) {
      const start = i + 1;
      i++;
      while (i < bytes.length && !isDelim(bytes[i])) i++;
      out.push('/' + latin(bytes.subarray(start, i)));
      continue;
    }
    const start = i;
    while (i < bytes.length && !isDelim(bytes[i])) i++;
    if (i === start) i++;
    else out.push(latin(bytes.subarray(start, i)));
  }
  return out;
}

function previousName(tokens, index) {
  for (let i = index - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token.startsWith('/')) return token.slice(1);
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) return '';
  }
  return '';
}

function missingExtGState(tokens, resources) {
  const have = new Set(entries(childDict(resources, 'ExtGState')).map(([name]) => name));
  const missing = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'gs') continue;
    const name = previousName(tokens, i);
    if (name && !have.has(name)) missing.push(name);
  }
  return missing;
}

function contentStreams(obj) {
  if (isForm(obj)) return [obj];
  const contents = obj.get?.('Contents');
  if (!contents || contents.isNull?.()) return [];
  if (contents.isArray?.()) {
    const out = [];
    contents.forEach(item => { if (item?.isStream?.()) out.push(item); });
    return out;
  }
  return contents.isStream?.() ? [contents] : [];
}

function scanObject(obj, resources, seen, missing) {
  if (!obj || obj.isNull?.()) return;
  const id = obj.isIndirect?.() ? obj.asIndirect() : 0;
  if (id && seen.has(id)) return;
  if (id) seen.add(id);
  for (const stream of contentStreams(obj)) {
    const found = missingExtGState(tokensOf(stream.readStream().asUint8Array()), resources);
    for (const name of found) missing.push(name);
  }
  for (const [, value] of entries(childDict(resources, 'XObject'))) {
    if (isForm(value)) scanObject(value, childDict(value, 'Resources'), seen, missing);
  }
}

export function missingExtGStates(bytes, mupdf) {
  const doc = new mupdf.PDFDocument(bytes);
  try {
    const missing = [];
    const seen = new Set();
    for (const page of pageObjects(doc)) scanObject(page, childDict(page, 'Resources'), seen, missing);
    return [...new Set(missing)];
  } finally { doc.destroy(); }
}

function documentText(bytes, mupdf) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const parts = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const text = page.toStructuredText();
      try { parts.push(text.asText()); }
      finally { text.destroy(); page.destroy(); }
    }
    return parts.join(' ');
  } finally { doc.destroy(); }
}

function textTokens(text) {
  if (typeof text !== 'string') return [];
  return text.replace(/\s+/g, ' ').trim().split(' ').map(normalizeToken).filter(Boolean);
}

function normalizeToken(word) {
  return word.replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%]+$/gu, '');
}

function sameSpan(words, index, drop) {
  for (let k = 0; k < drop.length; k++) if (words[index + k] !== drop[k]) return false;
  return true;
}

function withoutPhrase(words, phrase) {
  const drop = textTokens(phrase);
  if (!drop.length) return words;
  for (let i = 0; i + drop.length <= words.length; i++) {
    if (!sameSpan(words, i, drop)) continue;
    return words.slice(0, i).concat(words.slice(i + drop.length));
  }
  return words;
}

function lostWords(beforeText, afterText, edits) {
  let before = textTokens(beforeText);
  let after = textTokens(afterText);
  for (const edit of edits || []) {
    before = withoutPhrase(before, edit?.before);
    after = withoutPhrase(after, edit?.after);
  }
  const counts = new Map();
  for (const word of after) counts.set(word, (counts.get(word) || 0) + 1);
  const lost = [];
  for (const word of before) {
    const have = counts.get(word) || 0;
    if (!have) lost.push(word);
    else counts.set(word, have - 1);
  }
  return lost;
}

export function assessFigureText(source, output, edits, mupdf) {
  const missing = missingExtGStates(output, mupdf);
  if (missing.length) return {missing};
  const lost = lostWords(documentText(source, mupdf), documentText(output, mupdf), edits);
  if (lost.length) return {lost};
  return null;
}
