// app/src/browser-pdf.mjs
import * as mupdf from "./browser-pdf-vendor/mupdf.js";

// app/src/browser-fonts.mjs
var error = (message) => new Error(message);
var key = (value) => String(value || "").replace(/^[A-Z]{6}\+/, "").toLowerCase().replace(/[\s_-]+/g, "");
function parseFont(bytes) {
  const bad = () => {
    throw error("\uC62C\uBC14\uB978 TTF \uB610\uB294 OTF \uAE00\uAF34 \uD30C\uC77C\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
  };
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => {
    if (o < 0 || o + 2 > bytes.length) bad();
    return view.getUint16(o);
  };
  const u32 = (o) => {
    if (o < 0 || o + 4 > bytes.length) bad();
    return view.getUint32(o);
  };
  const tag = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  function validateHeader() {
    const sig = u32(0);
    if (sig === 1953784678) throw error("\uAE00\uAF34 \uCEEC\uB809\uC158(TTC/OTC)\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uB2E8\uC77C TTF \uB610\uB294 OTF\uB97C \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
    if (sig !== 65536 && sig !== 1330926671 && sig !== 1953658213) bad();
    const count3 = u16(4), tables2 = /* @__PURE__ */ new Map();
    if (!count3 || 12 + count3 * 16 > bytes.length) bad();
    return { count: count3, tables: tables2 };
  }
  const { count: count2, tables } = validateHeader();
  function readTables() {
    for (let i = 0; i < count2; i++) {
      const p = 12 + i * 16, name = tag(p), offset = u32(p + 8), length = u32(p + 12);
      if (offset > bytes.length || length > bytes.length - offset || tables.has(name)) bad();
      tables.set(name, { offset, length });
    }
  }
  readTables();
  function requiredTables() {
    if (tables.has("fvar")) throw error("\uAC00\uBCC0 \uAE00\uAF34\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uACE0\uC815 \uAD75\uAE30\uC758 TTF \uB610\uB294 OTF\uB97C \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
    const names2 = tables.get("name"), os22 = tables.get("OS/2"), head2 = tables.get("head");
    if (!names2 || names2.length < 6 || !os22 || os22.length < 64 || !head2 || head2.length < 46) bad();
    return { names: names2, os2: os22, head: head2 };
  }
  const { names, os2, head } = requiredTables();
  const n = names.offset, entries = u16(n + 2), strings = n + u16(n + 4), end = n + names.length;
  if (n + 6 + entries * 12 > end || strings > end) bad();
  const values = /* @__PURE__ */ new Map();
  function decodeName(platform, encoding, length, start) {
    let text;
    if (platform === 0 || platform === 3) {
      if (length % 2) bad();
      text = "";
      for (let j = 0; j < length; j += 2) text += String.fromCharCode(u16(start + j));
    } else if (platform === 1 && encoding === 0) text = String.fromCharCode(...bytes.subarray(start, start + length));
    else return null;
    return text;
  }
  function readNames() {
    for (let i = 0; i < entries; i++) {
      const p = n + 6 + i * 12, platform = u16(p), encoding = u16(p + 2), language = u16(p + 4), id = u16(p + 6), length = u16(p + 8), start = strings + u16(p + 10);
      if (start > end || length > end - start) bad();
      if (![1, 2, 6, 16, 17].includes(id)) continue;
      let text;
      text = decodeName(platform, encoding, length, start);
      if (text === null) continue;
      text = text.replace(/\0/g, "").trim();
      const score = (platform === 3 ? 4 : platform === 0 ? 3 : 1) + (language === 1033 ? 2 : 0);
      if (text && (!values.has(id) || values.get(id).score < score)) values.set(id, { text, score });
    }
  }
  readNames();
  const get = (id) => values.get(id)?.text;
  const family = get(16) || get(1), postscriptName = get(6);
  if (!family) bad();
  function fontMetadata() {
    const weight = u16(os2.offset + 4), fsType = u16(os2.offset + 8), selection = u16(os2.offset + 62), macStyle = u16(head.offset + 44);
    if (weight < 1 || weight > 1e3) bad();
    if (fsType & 512 || fsType & 2 && !(fsType & 12)) throw error("\uC774 \uAE00\uAF34\uC740 \uC784\uBCA0\uB529 \uC81C\uD55C \uB610\uB294 \uBE44\uD2B8\uB9F5 \uC804\uC6A9 \uC81C\uD55C\uC774 \uC788\uC5B4 PDF\uC5D0 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uB2E4\uB978 \uAE00\uAF34\uC744 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
    return { family, ...postscriptName ? { postscriptName } : {}, weight, italic: Boolean(selection & 1 || macStyle & 2), fsType };
  }
  return fontMetadata();
}
function familyKey(value) {
  let name = String(value || "").replace(/^[A-Z]{6}\+/, "");
  name = name.replace(/^(TimesNewRomanPS|Arial)-(BoldItalic|BoldOblique|Bold|Italic|Oblique)MT$/i, (_, family, variant) => `${/^arial$/i.test(family) ? "Arial" : "TimesNewRoman"}-${variant}`);
  name = name.replace(/[-,](?:bolditalic|boldoblique|bold|italic|oblique|regular|roman)$/i, "");
  const normalized2 = key(name);
  return { timesnewromanpsmt: "timesnewroman", arialmt: "arial" }[normalized2] || normalized2;
}

// app/src/paragraph-pdf-content-operators.mjs
var ws = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
var delim = (c) => ws(c) || c === void 0 || "()<>[]{}/%".includes(String.fromCharCode(c));
var identity = () => [1, 0, 0, 1, 0, 0];
var mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
var translate = (m, x, y) => mul([1, 0, 0, 1, x, y], m);
function lexer(data, diagnostics) {
  let i = 0;
  const fail = (message, start) => {
    diagnostics.push({ message, offset: start });
    i = data.length;
    return null;
  };
  const skip = () => {
    while (i < data.length) {
      if (ws(data[i])) i++;
      else if (data[i] === 37) {
        while (i < data.length && data[i] !== 10 && data[i] !== 13) i++;
      } else break;
    }
  };
  function literalEscape(start, out) {
    if (i >= data.length) {
      fail("Unterminated literal string", start);
      return false;
    }
    let x = data[i++];
    if (x === 13 || x === 10) {
      if (x === 13 && data[i] === 10) i++;
      return true;
    }
    if (x >= 48 && x <= 55) {
      let n = x - 48, count2 = 1;
      while (count2 < 3 && data[i] >= 48 && data[i] <= 55) {
        n = n * 8 + data[i++] - 48;
        count2++;
      }
      out.push(n & 255);
      return true;
    }
    out.push({ 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[x] ?? x);
    return true;
  }
  function literalString(start) {
    let depth = 1, out = [];
    while (i < data.length && depth) {
      let x = data[i++];
      if (x === 92) {
        if (!literalEscape(start, out)) return null;
        continue;
      }
      if (x === 40) depth++;
      else if (x === 41 && --depth === 0) break;
      if (x === 13) {
        if (data[i] === 10) i++;
        x = 10;
      }
      out.push(x);
    }
    if (depth) return fail("Unterminated literal string", start);
    return { type: "string", bytes: Uint8Array.from(out), start, end: i };
  }
  function hexString(start) {
    let hex = "";
    while (i < data.length && data[i] !== 62) {
      const x = data[i++];
      if (ws(x)) continue;
      const ch = String.fromCharCode(x);
      if (!/[0-9a-f]/i.test(ch)) return fail("Invalid hex string", start);
      hex += ch;
    }
    if (i >= data.length) return fail("Unterminated hex string", start);
    i++;
    if (hex.length % 2) hex += "0";
    return { type: "string", bytes: Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16)), start, end: i };
  }
  function composite(start, c) {
    const dictionary = c === 60;
    if (dictionary) i++;
    const items = [];
    while (true) {
      skip();
      if (i >= data.length) return fail("Unterminated composite object", start);
      if (!dictionary && data[i] === 93 || dictionary && data[i] === 62 && data[i + 1] === 62) {
        i += dictionary ? 2 : 1;
        break;
      }
      const t = next();
      if (!t) return null;
      items.push(t);
    }
    return { type: dictionary ? "dict" : "array", items, start, end: i };
  }
  function nameToken(start) {
    let name = "";
    while (!delim(data[i])) {
      if (data[i] === 35 && /^[0-9a-f]{2}$/i.test(String.fromCharCode(data[i + 1] ?? 0, data[i + 2] ?? 0))) {
        name += String.fromCharCode(parseInt(String.fromCharCode(data[i + 1], data[i + 2]), 16));
        i += 3;
      } else name += String.fromCharCode(data[i++]);
    }
    return { type: "name", value: name, start, end: i };
  }
  function next() {
    skip();
    if (i >= data.length) return null;
    const start = i, c = data[i++];
    if (c === 40) return literalString(start);
    if (c === 60 && data[i] !== 60) return hexString(start);
    if (c === 91 || c === 60 && data[i] === 60) return composite(start, c);
    if (c === 47) return nameToken(start);
    if (delim(c)) return fail("Unexpected delimiter", start);
    while (!delim(data[i])) i++;
    let value = "";
    for (let k = start; k < i; k++) value += String.fromCharCode(data[k]);
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return { type: "number", value: Number(value), start, end: i };
    if (["true", "false", "null"].includes(value)) return { type: "value", value, start, end: i };
    return { type: "operator", value, start, end: i };
  }
  return next;
}
function scanTextShows(input, { measure: measure2 } = {}) {
  const diagnostics = [], shows = [];
  let data;
  if (input instanceof Uint8Array) data = input;
  else if (typeof input === "string") {
    data = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      if (input.charCodeAt(i) > 255) {
        diagnostics.push({ message: "Input is not Latin-1", offset: i });
        return { shows, diagnostics };
      }
      data[i] = input.charCodeAt(i);
    }
  } else return { shows, diagnostics: [{ message: "Input must be Uint8Array or Latin-1 string", offset: 0 }] };
  const next = lexer(data, diagnostics);
  let s = { fontName: null, fontSize: 0, textMatrix: identity(), lineMatrix: identity(), ctm: identity(), charSpace: 0, wordSpace: 0, hScale: 100, rise: 0, renderMode: 0, leading: 0 };
  let uncertain = false, lineUncertain = false, stateUncertain = false, inText = false, stack = [], args = [];
  const nums = (n) => args.length === n && args.every((t) => t.type === "number" && Number.isFinite(t.value));
  const bad = (t) => {
    diagnostics.push({ message: `Invalid operands for ${t.value}`, offset: t.start });
    uncertain = lineUncertain = stateUncertain = true;
  };
  const snapshot = () => ({ ...s, textMatrix: [...s.textMatrix], lineMatrix: [...s.lineMatrix], ctm: [...s.ctm] });
  const move = (x, y) => {
    s.lineMatrix = translate(s.lineMatrix, x, y);
    s.textMatrix = [...s.lineMatrix];
    uncertain = lineUncertain;
  };
  const harmless = /* @__PURE__ */ new Set(["w", "J", "j", "M", "d", "ri", "i", "m", "l", "c", "v", "y", "h", "re", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n", "W", "W*", "CS", "cs", "SC", "SCN", "sc", "scn", "G", "g", "RG", "rg", "K", "k", "sh", "Do", "MP", "DP", "BMC", "BDC", "EMC", "BX", "EX", "d0", "d1"]);
  function handleStateOperator(op, t, v) {
    if (op === "BT") {
      if (args.length) bad(t);
      s.textMatrix = identity();
      s.lineMatrix = identity();
      uncertain = lineUncertain = false;
      inText = true;
    } else if (op === "ET") {
      if (args.length) bad(t);
      inText = false;
    } else if (op === "q") {
      stack.push({ s: snapshot(), stateUncertain });
    } else if (op === "Q") {
      if (!stack.length) bad(t);
      else {
        const saved = stack.pop();
        const tm = s.textMatrix, lm = s.lineMatrix, u = uncertain, lu = lineUncertain;
        s = saved.s;
        stateUncertain = saved.stateUncertain;
        s.textMatrix = tm;
        s.lineMatrix = lm;
        uncertain = u;
        lineUncertain = lu;
      }
    } else if (op === "cm") {
      if (nums(6)) s.ctm = mul(v, s.ctm);
      else bad(t);
    } else return handleTextState(op, t, v);
    return true;
  }
  function handleTextState(op, t, v) {
    if (op === "Tm") {
      if (nums(6)) {
        s.textMatrix = [...v];
        s.lineMatrix = [...v];
        uncertain = lineUncertain = false;
      } else bad(t);
    } else if (op === "Td" || op === "TD") {
      if (nums(2)) {
        if (op === "TD") s.leading = -v[1];
        move(...v);
      } else bad(t);
    } else if (op === "T*") {
      if (!args.length) move(0, -s.leading);
      else bad(t);
    } else if (op === "Tf") {
      if (args.length === 2 && args[0].type === "name" && args[1].type === "number") {
        s.fontName = v[0];
        s.fontSize = v[1];
      } else bad(t);
    } else if (["TL", "Tc", "Tw", "Tz", "Ts", "Tr"].includes(op)) {
      if (nums(1)) s[{ TL: "leading", Tc: "charSpace", Tw: "wordSpace", Tz: "hScale", Ts: "rise", Tr: "renderMode" }[op]] = v[0];
      else bad(t);
    } else return false;
    return true;
  }
  function validTextShow(op, args2) {
    return op === "TJ" ? args2.length === 1 && args2[0].type === "array" && args2[0].items.every((x) => x.type === "string" || x.type === "number") : op === '"' ? args2.length === 3 && args2[0].type === "number" && args2[1].type === "number" && args2[2].type === "string" : args2.length === 1 && args2[0].type === "string";
  }
  function advanceText(parts) {
    let advance = 0, known = true;
    for (const p of parts) {
      if (p.type === "adjustment") advance -= p.value / 1e3 * s.fontSize;
      else {
        let n;
        try {
          n = measure2?.(s.fontName, p.bytes, snapshot());
        } catch {
          n = NaN;
        }
        if (!Number.isFinite(n)) known = false;
        else advance += n;
      }
    }
    if (known) s.textMatrix = translate(s.textMatrix, advance * s.hScale / 100, 0);
    else uncertain = true;
  }
  function handleTextShow(op, t, v) {
    const valid = validTextShow(op, args);
    if (!valid || !inText) {
      bad(t);
      return;
    }
    if (op === '"') {
      s.wordSpace = v[0];
      s.charSpace = v[1];
    }
    if (op === "'" || op === '"') move(0, -s.leading);
    const src = op === "TJ" ? args[0].items : [args[args.length - 1]];
    const parts = src.map((x) => x.type === "string" ? { type: "string", bytes: x.bytes, start: x.start, end: x.end } : { type: "adjustment", value: x.value, start: x.start, end: x.end });
    shows.push({ start: args[0].start, end: t.end, operatorStart: t.start, operatorEnd: t.end, kind: op, parts, ...snapshot(), uncertain: uncertain || stateUncertain });
    advanceText(parts);
  }
  for (let t; t = next(); ) {
    if (t.type !== "operator") {
      args.push(t);
      continue;
    }
    const op = t.value, v = args.map((a) => a.value);
    if (op === "BI") {
      diagnostics.push({ message: "Inline image boundary cannot be proven; scanning stopped", offset: t.start });
      break;
    }
    if (handleStateOperator(op, t, v)) {
    } else if (["Tj", "TJ", "'", '"'].includes(op)) {
      handleTextShow(op, t, v);
    } else if (!harmless.has(op)) {
      diagnostics.push({ message: `Unknown operator ${op}`, offset: t.start });
      uncertain = lineUncertain = stateUncertain = true;
    }
    args = [];
  }
  if (args.length) diagnostics.push({ message: "Trailing operands without operator", offset: args[0].start });
  return { shows, diagnostics };
}

// app/src/browser-pdf.mjs
var ENGINE = Object.freeze({
  name: "mupdf.js",
  version: "1.28.1",
  license: "AGPL-3.0-or-later",
  redaction: "pdf-redact-text-remove-image-none-line-art-none"
});
var COORDINATE_SPACE = "top-left-page";
var COORDINATES = Object.freeze({
  space: COORDINATE_SPACE,
  origin: "top-left",
  yAxis: "down",
  unit: "pt"
});
var LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxPages: 200,
  maxEdits: 24,
  maxChars: 4e3,
  maxWrapLines: 8
});
var SCHEMA = "falsify.browser-pdf.v1";
var BASE14 = [
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
  "Symbol",
  "ZapfDingbats"
];
var FACE_ALIAS = {
  ArialMT: "Helvetica",
  Arial: "Helvetica",
  "Arial-BoldMT": "Helvetica-Bold",
  TimesNewRomanPSMT: "Times-Roman",
  "TimesNewRomanPS-BoldMT": "Times-Bold",
  "TimesNewRomanPS-ItalicMT": "Times-Italic",
  CourierNewPSMT: "Courier"
};
var WINANSI_EXTRA = {
  8364: 128,
  8218: 130,
  402: 131,
  8222: 132,
  8230: 133,
  8224: 134,
  8225: 135,
  710: 136,
  8240: 137,
  352: 138,
  8249: 139,
  338: 140,
  381: 142,
  8216: 145,
  8217: 146,
  8220: 147,
  8221: 148,
  8226: 149,
  8211: 150,
  8212: 151,
  732: 152,
  8482: 153,
  353: 154,
  8250: 155,
  339: 156,
  382: 158,
  376: 159
};
var fonts = /* @__PURE__ */ new Map();
var queue = Promise.resolve();
var BrowserPdfError = class extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BrowserPdfError";
    this.code = code;
    this.details = details;
  }
};
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {
  }, () => {
  });
  return run;
}
function aborted() {
  return new BrowserPdfError("aborted", "\uD3B8\uC9D1\uC774 \uCDE8\uC18C\uB418\uC5C8\uC2B5\uB2C8\uB2E4. PDF\uB294 \uB9CC\uB4E4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
}
function checkAbort(signal) {
  if (signal?.aborted) throw aborted();
}
async function prepare(request) {
  request ||= {};
  const snapshot = captureFontSnapshot(request.fontSnapshot);
  return exclusive(() => prepareExclusive({ ...request, fontSnapshot: snapshot }));
}
async function prepareExclusive(request) {
  checkAbort(request.signal);
  const parsed = parseRequest(request);
  const snapshot = await validateFontSnapshot(request.fontSnapshot);
  checkAbort(request.signal);
  const bytes = await readBytes(parsed.file);
  checkAbort(request.signal);
  const sourceSha256 = await sha256(bytes);
  const enabled = validateSourceEdits(parsed, sourceSha256);
  let doc;
  try {
    doc = openPdf(bytes);
    checkAbort(request.signal);
    const pageCount = doc.countPages();
    if (pageCount < 1 || pageCount > LIMITS.maxPages) throw new BrowserPdfError("limit", `\uD398\uC774\uC9C0 \uC218\uB294 1..${LIMITS.maxPages}\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.`);
    const models = [];
    for (let i = 0; i < pageCount; i++) {
      checkAbort(request.signal);
      models.push(readPage(doc.loadPage(i)));
    }
    const { plans, failures } = locateEditPlans(enabled, models, pageCount, snapshot);
    checkAbort(request.signal);
    const warnings = [];
    const byPage = layoutEditPlans(plans, models, doc, failures, warnings);
    applyPageEdits(byPage, models, doc, request);
    checkAbort(request.signal);
    const saved = doc.saveToBuffer("garbage=compact");
    const out = new Uint8Array(saved.asUint8Array());
    doc.destroy();
    doc = null;
    checkAbort(request.signal);
    if (out.length < 5 || String.fromCharCode(...out.slice(0, 5)) !== "%PDF-") {
      throw new BrowserPdfError("verification-failed", "\uC800\uC7A5\uB41C \uCD9C\uB825\uC774 PDF\uAC00 \uC544\uB2D9\uB2C8\uB2E4. \uD30C\uC77C\uC744 \uBC18\uD658\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    }
    const outputSha256 = await sha256(out);
    const quality = verify(bytes, out, plans, models, outputSha256 === sourceSha256);
    warnings.push(...quality.warnings);
    const checks = quality.checks;
    const status = checks.length ? "failed" : warnings.some((item) => item.severity === "warning") ? "warning" : "applied";
    const file = new File([out], editedName(parsed.name), { type: "application/pdf" });
    const pageMap = models.map((model, index) => pageMapEntry(model, index));
    const verification = {
      schema: SCHEMA,
      engine: ENGINE.name,
      engineVersion: ENGINE.version,
      license: ENGINE.license,
      redaction: ENGINE.redaction,
      coordinateSpace: COORDINATE_SPACE,
      sourceSha256,
      outputSha256,
      status,
      layoutVerified: status === "applied",
      independent: false,
      pageCount: { source: pageCount, output: pageCount },
      pages: models.map((model, index) => verificationPage(model, index)),
      edits: plans.map((plan) => {
        const editChecks = checks.filter((item) => item.id === plan.edit.id);
        return {
          id: plan.edit.id,
          pageIndex: plan.pageIndex,
          status: editChecks.length ? "failed" : "applied",
          font: plan.layout.font,
          sourceFont: plan.sourceFont,
          fontSubstituted: plan.layout.substituted,
          encoding: plan.layout.encoding,
          size: plan.size,
          color: plan.color,
          wrappedLines: plan.layout.lines.length,
          checks: editChecks
        };
      }),
      checks,
      quality: {
        independent: false,
        method: "mupdf.js structured text, same engine",
        removedBefore: !checks.some((item) => item.code === "removed-before"),
        presentAfter: !checks.some((item) => item.code === "present-after"),
        untouchedText: !checks.some((item) => item.code === "untouched-text"),
        figures: !checks.some((item) => item.code === "figure-changed"),
        limitations: "Same-engine structural check only. A failed check still returns this readable candidate. Not typography, pixel identity, independent QA, or scientific verification."
      },
      warnings
    };
    return { file, sha256: outputSha256, verification, pageMap, warnings };
  } catch (error2) {
    if (error2 instanceof BrowserPdfError) throw error2;
    throw new BrowserPdfError("engine", "PDF \uD3B8\uC9D1 \uC911 \uC5D4\uC9C4 \uC624\uB958\uAC00 \uB0AC\uC2B5\uB2C8\uB2E4. \uCD9C\uB825 \uD30C\uC77C\uC740 \uB9CC\uB4E4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.", { reason: error2?.name || "Error" });
  } finally {
    try {
      doc?.destroy();
    } catch {
    }
    for (const face of snapshot || []) {
      try {
        face.font?.destroy();
      } catch {
      }
    }
  }
}
function validateSourceEdits(parsed, sourceSha256) {
  if (parsed.fileHash && parsed.fileHash !== sourceSha256) {
    throw new BrowserPdfError("stale-source", "\uC6D0\uBCF8 PDF \uD574\uC2DC\uAC00 \uD3B8\uC9D1 \uC138\uC158\uACFC \uB2E4\uB985\uB2C8\uB2E4. \uD30C\uC77C\uC744 \uB2E4\uC2DC \uC5F0 \uB4A4 \uC801\uC6A9\uD558\uC138\uC694. \uCD9C\uB825\uC740 \uB9CC\uB4E4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.", {
      sourceSha256,
      expectedSha256: parsed.fileHash
    });
  }
  const enabled = parsed.edits.filter((edit) => edit.enabled !== false);
  if (!enabled.length) throw new BrowserPdfError("no-edits", "\uC801\uC6A9\uD560 \uD3B8\uC9D1\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uC6D0\uBCF8\uC744 \uBCC0\uACBD\uB41C \uD30C\uC77C\uB85C \uBC18\uD658\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  if (enabled.length > LIMITS.maxEdits) throw new BrowserPdfError("limit", `\uD3B8\uC9D1\uC740 \uD55C \uBC88\uC5D0 ${LIMITS.maxEdits}\uAC1C\uAE4C\uC9C0\uC785\uB2C8\uB2E4.`);
  return enabled;
}
function locateEditPlans(enabled, models, pageCount, snapshot) {
  const plans = [];
  const failures = [];
  enabled.forEach((edit, index) => {
    const result = locate(edit, index, models, pageCount, snapshot);
    if (result.ok) plans.push(result.plan);
    else failures.push(result.failure);
  });
  const overlaps = overlapping(plans);
  if (overlaps.length) failures.push(...overlaps);
  if (failures.length) throw unsupported(failures, models);
  return { plans, failures };
}
function layoutEditPlans(plans, models, doc, failures, warnings) {
  const byPage = /* @__PURE__ */ new Map();
  for (const plan of plans) {
    const laid = layout(plan, models[plan.pageIndex], doc.loadPage(plan.pageIndex));
    if (laid.error) failures.push(failure(plan.edit, plan.pageIndex, laid.error));
    else {
      plan.layout = laid;
      if (plan.anchorApproximate) warnings.push(warn("selection-font-metrics", "warning", plan.pageIndex, plan.edit.id));
      if (laid.substituted) warnings.push(warn("font-substituted", "warning", plan.pageIndex, plan.edit.id));
      if (laid.lines.length > 1) warnings.push(warn("wrapped-after", "info", plan.pageIndex, plan.edit.id));
      if (plan.partialLine) warnings.push(warn("extraction-gap", "info", plan.pageIndex, plan.edit.id));
      const list = byPage.get(plan.pageIndex) || [];
      list.push(plan);
      byPage.set(plan.pageIndex, list);
    }
  }
  if (failures.length) throw unsupported(failures, models);
  return byPage;
}
function applyPageEdits(byPage, models, doc, request) {
  for (const [pageIndex, group] of byPage) {
    checkAbort(request.signal);
    const turned = group.filter((plan) => plan.rotation !== 0);
    if (turned.length) throw unsupported(turned.map((plan) => failure(plan.edit, plan.pageIndex, "rotated-page")), models);
    const page = doc.loadPage(pageIndex);
    const selected = new Set(group.flatMap((plan) => plan.chars));
    const protectedBoxes = removalBoxes(models[pageIndex].chars.filter((ch) => !selected.has(ch)));
    for (const plan of group) redact(page, plan.chars, protectedBoxes);
    page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    const piece = group.map((plan) => showText(doc, page, plan)).join("");
    if (piece) appendStream(doc, page, piece);
  }
}
function parseRequest(request) {
  const file = request.file;
  const signal = request.signal;
  let edits = request.edits;
  let fileHash = typeof request.fileHash === "string" ? request.fileHash : "";
  if (edits && !Array.isArray(edits)) {
    if (edits.schema && edits.schema !== "falsify.paper-edits.v1") {
      throw new BrowserPdfError("invalid", "\uD3B8\uC9D1 \uC2A4\uB0C5\uC0F7 \uC2A4\uD0A4\uB9C8\uB97C \uC54C \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    }
    if (typeof edits.fileHash === "string" && edits.fileHash) {
      if (fileHash && fileHash !== edits.fileHash) throw new BrowserPdfError("stale-source", "\uC694\uCCAD \uD574\uC2DC\uC640 \uC2A4\uB0C5\uC0F7 \uD574\uC2DC\uAC00 \uB2E4\uB985\uB2C8\uB2E4. \uCD9C\uB825\uC740 \uB9CC\uB4E4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
      fileHash = edits.fileHash;
    }
    edits = edits.edits;
  }
  if (!Array.isArray(edits)) throw new BrowserPdfError("invalid", "edits \uBC30\uC5F4 \uB610\uB294 falsify.paper-edits.v1 \uC2A4\uB0C5\uC0F7\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
  if (fileHash && !/^[a-f0-9]{64}$/i.test(fileHash)) throw new BrowserPdfError("invalid", "fileHash\uB294 SHA-256 16\uC9C4\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  return { file, signal, fileHash: fileHash.toLowerCase(), edits, name: file?.name || "document.pdf" };
}
async function readBytes(file) {
  let bytes;
  if (file instanceof Uint8Array) bytes = new Uint8Array(file);
  else if (file && typeof file.arrayBuffer === "function") bytes = new Uint8Array(await file.arrayBuffer());
  else if (file?.bytes instanceof Uint8Array) bytes = new Uint8Array(file.bytes);
  else throw new BrowserPdfError("invalid", "PDF File \uB610\uB294 bytes\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
  if (bytes.byteLength > LIMITS.maxFileBytes) throw new BrowserPdfError("limit", "PDF\uAC00 \uD06C\uAE30 \uC81C\uD55C\uC744 \uB118\uC2B5\uB2C8\uB2E4.");
  if (bytes.byteLength < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new BrowserPdfError("invalid", "PDF \uC11C\uBA85\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
  return bytes;
}
function openPdf(bytes) {
  let doc;
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  } catch {
    throw new BrowserPdfError("invalid", "PDF\uB97C \uC5F4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  }
  if (!doc) throw new BrowserPdfError("invalid", "PDF \uBB38\uC11C\uAC00 \uC544\uB2D9\uB2C8\uB2E4.");
  if (doc.needsPassword()) throw new BrowserPdfError("unsupported", "\uC554\uD638\uD654\uB41C PDF\uB294 \uC774 \uBE0C\uB77C\uC6B0\uC800 \uD3B8\uC9D1\uC5D0\uC11C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uD30C\uC77C\uC744 \uB9CC\uB4E4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
  return doc;
}
function readPage(page) {
  const transform = page.getTransform();
  const toPdf = mupdf.Matrix.invert(transform);
  const chars = [];
  const images = [];
  const text = page.toStructuredText("preserve-whitespace,preserve-images");
  let lineId = -1;
  let lastY = null;
  text.walk({
    onChar(ch, origin, font, size, quad, color) {
      const pdf = apply(toPdf, origin[0], origin[1]);
      if (lastY === null || Math.abs(pdf[1] - lastY) > 1.25) {
        lineId += 1;
        lastY = pdf[1];
      }
      chars.push({
        c: ch,
        origin: [origin[0], origin[1]],
        pdf,
        lineId,
        fontName: font.getName(),
        font,
        size: Number(size),
        quad: [...quad],
        color: rgb(color)
      });
    },
    onImageBlock(bbox) {
      images.push([...bbox]);
    }
  });
  return { chars, images, transform, toPdf, bounds: page.getBounds(), rotation: rotationOf(page) };
}
function validateEditText(edit, pageIndex, pageCount, fail) {
  if (!edit || typeof edit !== "object") return fail("invalid-edit");
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) return fail("invalid-page");
  if (typeof edit.before !== "string" || !edit.before.trim() || edit.before.length > LIMITS.maxChars) return fail("invalid-before");
  if (typeof edit.after !== "string" || edit.after.length > LIMITS.maxChars) return fail("invalid-after");
  return null;
}
function validAnchorRange(anchor) {
  if (anchor && (anchor.start !== void 0 || anchor.end !== void 0)) {
    if (!Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) || anchor.end <= anchor.start) return false;
  }
  return true;
}
function validateEditAnchor(edit, pageIndex, pageCount, fail) {
  const anchor = edit.anchor && typeof edit.anchor === "object" ? edit.anchor : null;
  if (anchorConvention(edit, anchor)) return fail("invalid-anchor");
  if (anchor?.bbox && !validBox(anchor.bbox)) return fail("invalid-anchor");
  if (anchor && anchor.occurrence !== void 0 && (!Number.isInteger(anchor.occurrence) || anchor.occurrence < 0)) return fail("invalid-anchor");
  if (!validAnchorRange(anchor)) return fail("invalid-anchor");
  return { anchor };
}
function findAnchoredQuotes(model, edit, anchor) {
  const { text, map } = normalized(model.chars);
  const needle = edit.before.replace(/\s+/g, " ").trim();
  const hits = [];
  let from = 0, ordinal = 0, foundQuote = false;
  const requestedOrdinal = anchor?.occurrence;
  while (true) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    const chars = [];
    for (let i = at; i < at + needle.length; i++) if (map[i] !== null && map[i] !== void 0) chars.push(model.chars[map[i]]);
    if (!chars.length) continue;
    foundQuote = true;
    const occurrence = ordinal++;
    if (requestedOrdinal !== void 0 && occurrence !== requestedOrdinal) continue;
    if (anchor?.bbox) {
      const box = union(chars);
      if (!contains(box, anchor.bbox, Math.max(4, Math.min(8, (box[3] - box[1]) / 2)))) continue;
    }
    hits.push({ at, chars });
    if (requestedOrdinal !== void 0 || hits.length > 1) break;
  }
  return { hits, foundQuote };
}
function buildLocatedPlan(edit, id, pageIndex, model, anchor, chars, snapshot, fail) {
  const drawn = chars.filter((ch) => ch.c.trim());
  if (!drawn.length) return fail("not-found");
  if (!drawn.every((ch) => horizontalLine(chars.filter((item) => item.lineId === ch.lineId)))) return fail("rotated-text");
  const fontsUsed = [...new Set(drawn.map((ch) => ch.fontName))];
  const sizes = [...new Set(drawn.map((ch) => Math.round(ch.size * 100) / 100))];
  const colors = [...new Set(drawn.map((ch) => ch.color ? ch.color.map((n) => Math.round(n * 1e3) / 1e3).join(",") : "none"))];
  if (fontsUsed.length !== 1 || sizes.length !== 1 || colors.length !== 1 || colors[0] === "none") return fail(colors[0] === "none" ? "unsupported-color" : "mixed-style");
  const face = base14(fontsUsed[0], drawn[0].font);
  if (!face) return fail("font-unavailable");
  const supplied = snapshot ? chooseSnapshotFont(snapshot, fontsUsed[0], drawn[0].font, edit.after) : null;
  if (snapshot && !supplied) return fail("font-unavailable");
  const encoded = supplied ? { encoding: "glyph-id", substituted: supplied.substituted } : textEncoding(face, edit.after);
  if (encoded.error) return fail(encoded.error);
  const box = pdfSpan(model.toPdf, chars.filter((ch) => ch.lineId === chars[0].lineId));
  const partialLine = model.chars.some((ch) => ch.lineId === chars[0].lineId && !chars.includes(ch) && ch.c.trim());
  return { ok: true, plan: {
    edit: { ...edit, id },
    pageIndex,
    chars,
    charIndex: new Set(chars.map((ch) => model.chars.indexOf(ch))),
    anchorApproximate: !!anchor?.bbox && !contains(union(chars), anchor.bbox, 4),
    sourceFont: fontsUsed[0],
    face,
    supplied,
    encoding: encoded.encoding,
    substituted: encoded.substituted,
    size: sizes[0],
    color: drawn[0].color,
    origin: chars[0].pdf,
    hole: box[1] - box[0],
    partialLine,
    rotation: model.rotation
  } };
}
function locate(edit, index, models, pageCount, snapshot) {
  const id = typeof edit?.id === "string" && edit.id ? edit.id : `edit-${index}`;
  const pageIndex = edit?.pageIndex;
  const fail = (code) => ({ ok: false, failure: { id, pageIndex: Number.isInteger(pageIndex) ? pageIndex : null, status: "unapplied", code } });
  const invalid = validateEditText(edit, pageIndex, pageCount, fail);
  if (invalid) return invalid;
  const validated = validateEditAnchor(edit, pageIndex, pageCount, fail);
  if (validated.ok === false) return validated;
  const { anchor } = validated;
  const model = models[pageIndex];
  if (model.rotation !== 0) return fail("rotated-page");
  const { hits, foundQuote } = findAnchoredQuotes(model, edit, anchor);
  const pool = hits;
  if (!pool.length) return fail(foundQuote ? "anchor-mismatch" : "not-found");
  if (pool.length > 1) return fail("ambiguous");
  const chars = pool[0].chars;
  return buildLocatedPlan(edit, id, pageIndex, model, anchor, chars, snapshot, fail);
}
function layout(plan, model, page) {
  const font = plan.supplied?.font || (plan.encoding === "uniks-utf16" ? cjkFont() : metrics(plan.face.name));
  const fontName = plan.supplied?.name || (plan.encoding === "uniks-utf16" ? "ko" : plan.face.name);
  const after = plan.edit.after;
  const placed = (lines2) => ({ lines: lines2, font: fontName, substituted: plan.substituted, encoding: plan.encoding });
  if (!after) return placed([]);
  const width = measure(font, plan.size, after);
  if (width === null) return { error: "missing-glyphs" };
  if (width <= plan.hole + 0.8) return placed([after]);
  if (plan.rotation !== 0) return { error: "long-after-no-room" };
  const room = roomRight(plan, model, page);
  if (width <= room + 0.8) return placed([after]);
  const wrapWidth = Math.max(36, Math.min(room, 468));
  const lines = wrap(font, plan.size, after, wrapWidth);
  if (!lines) return { error: "missing-glyphs" };
  if (lines.length > LIMITS.maxWrapLines) return { error: "long-after-no-room" };
  if (!clear(lines, plan, model, font)) return { error: "long-after-no-room" };
  return placed(lines);
}
var REDACTION_GAP = 0.05;
var GLYPH_ORIGIN = 0.01;
function quadBounds(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    x0 = Math.min(x0, points[i]);
    y0 = Math.min(y0, points[i + 1]);
    x1 = Math.max(x1, points[i]);
    y1 = Math.max(y1, points[i + 1]);
  }
  return [x0, y0, x1, y1];
}
function removalBox(ch) {
  const [x0, y0, x1, y1] = quadBounds(ch.quad);
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width > 0) || !(height > 0)) return null;
  return [x0 + width / 10, y0 + height / 10, x1 - width / 10, y1 - height / 10];
}
function removalBoxes(chars) {
  const boxes = [];
  for (const ch of chars) {
    const box = removalBox(ch);
    if (box) boxes.push(box);
  }
  return boxes;
}
function subtractRect(rect, obstacle) {
  const [x0, y0, x1, y1] = rect;
  const grown = [obstacle[0] - REDACTION_GAP, obstacle[1] - REDACTION_GAP, obstacle[2] + REDACTION_GAP, obstacle[3] + REDACTION_GAP];
  if (x1 <= grown[0] || x0 >= grown[2] || y1 <= grown[1] || y0 >= grown[3]) return rect;
  const candidates = [];
  if (grown[1] > y0) candidates.push([x0, y0, x1, Math.min(y1, grown[1])]);
  if (grown[3] < y1) candidates.push([x0, Math.max(y0, grown[3]), x1, y1]);
  if (grown[0] > x0) candidates.push([x0, y0, Math.min(x1, grown[0]), y1]);
  if (grown[2] < x1) candidates.push([Math.max(x0, grown[2]), y0, x1, y1]);
  let best = null;
  let area = 0;
  for (const candidate of candidates) {
    const width = candidate[2] - candidate[0];
    const height = candidate[3] - candidate[1];
    if (width > 0 && height > 0 && width * height > area) {
      best = candidate;
      area = width * height;
    }
  }
  return best;
}
function safeRedactionRect(ch, protectedBoxes) {
  let rect = removalBox(ch);
  if (!rect) return null;
  for (let guard = 0; guard < 12; guard++) {
    let next = rect;
    for (const box of protectedBoxes) {
      next = subtractRect(next, box);
      if (!next) return null;
    }
    if (next.every((value, index) => value === rect[index])) return next;
    rect = next;
  }
  if (rect[2] - rect[0] <= 0.02 || rect[3] - rect[1] <= 0.02) return null;
  return rect;
}
function redact(page, chars, protectedBoxes) {
  const quads = [];
  for (const ch of chars) {
    const rect = safeRedactionRect(ch, protectedBoxes);
    if (!rect) {
      if (!ch.c.trim()) continue;
      throw new BrowserPdfError("unsupported", "\uC120\uD0DD\uD55C \uAE00\uC790\uC758 \uAE00\uAF34 \uC0C1\uC790\uAC00 \uC778\uC811 \uAE00\uC790\uC640 \uACB9\uCCD0 \uADF8 \uAE00\uC790\uB9CC \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uBD80\uBD84 \uC801\uC6A9 \uD30C\uC77C\uC740 \uB9CC\uB4E4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.", {
        code: "glyph-overlap"
      });
    }
    const [x0, y0, x1, y1] = rect;
    quads.push([x0, y1, x1, y1, x0, y0, x1, y0]);
  }
  if (!quads.length) return;
  const annot = page.createAnnotation("Redact");
  const box = quadBounds(quads.flat());
  annot.setRect(box);
  annot.setQuadPoints(quads);
  annot.update();
}
function showText(doc, page, plan) {
  if (!plan.layout.lines.length) return "";
  const cjk = plan.layout.encoding === "uniks-utf16";
  const resource = plan.supplied ? ensureSnapshotFont(doc, page, plan) : cjk ? ensureCjkFont(doc, page) : ensureFont(doc, page, plan.layout.font);
  const [r, g, b] = plan.color;
  const leading = plan.size * 1.2;
  let body = `q BT /${resource} ${num(plan.size)} Tf ${num(r)} ${num(g)} ${num(b)} rg
`;
  plan.layout.lines.forEach((line, index) => {
    const literal = plan.supplied ? glyphHex(plan.supplied.font, line) : cjk ? utf16hex(line) : winAnsi(line);
    body += `1 0 0 1 ${num(plan.origin[0])} ${num(plan.origin[1] - index * leading)} Tm ${literal} Tj
`;
  });
  return body + "ET Q\n";
}
function appendStream(doc, page, text) {
  const stream = doc.addStream(new TextEncoder().encode(text), {});
  const obj = page.getObject();
  const contents = obj.get("Contents");
  if (contents.isArray()) {
    contents.push(stream);
    return;
  }
  const array = doc.newArray();
  if (!contents.isNull()) array.push(contents);
  array.push(stream);
  obj.put("Contents", array);
}
function verify(sourceBytes, outBytes, plans, models, unchanged) {
  const warnings = [];
  const checks = [];
  let check;
  try {
    check = mupdf.Document.openDocument(outBytes, "application/pdf").asPDF();
  } catch {
    throw new BrowserPdfError("engine", "\uC800\uC7A5 \uACB0\uACFC\uB97C \uB2E4\uC2DC \uC5F4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uD30C\uC77C\uC744 \uBC18\uD658\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  }
  try {
    if (check.countPages() !== models.length) checks.push({ pageIndex: null, status: "failed", code: "page-count" });
    verifyUneditedContent(check, plans, models, checks);
    verifyEditText(check, plans, models, warnings, checks);
    if (unchanged || outBytes.length === sourceBytes.length && outBytes.every((byte, index) => byte === sourceBytes[index])) {
      checks.push({ status: "failed", code: "unchanged-output" });
    }
  } finally {
    try {
      check.destroy();
    } catch {
    }
  }
  return { warnings, checks };
}
function verifyUneditedContent(check, plans, models, checks) {
  const edited = new Set(plans.map((plan) => plan.pageIndex));
  for (let i = 0; i < models.length; i++) {
    const page = check.loadPage(i);
    const again = readPage(page);
    if (!sameImages(models[i].images, again.images)) checks.push({ pageIndex: i, status: "failed", code: "figure-changed" });
    if (!edited.has(i)) {
      if (normalizeText(again.chars) !== normalizeText(models[i].chars)) checks.push({ pageIndex: i, status: "failed", code: "untouched-text" });
    } else if (!keptOutsideSelection(models[i].chars, again.chars, selectedCharIndexes(plans, i))) {
      checks.push({ pageIndex: i, status: "failed", code: "untouched-text" });
    }
  }
}
function verifyEditText(check, plans, models, warnings, checks) {
  for (const plan of plans) {
    const text = normalizeText(readPage(check.loadPage(plan.pageIndex)).chars);
    const before = plan.edit.before.replace(/\s+/g, " ").trim();
    const after = plan.edit.after.replace(/\s+/g, " ").trim();
    const sourceText = normalizeText(models[plan.pageIndex].chars);
    if (after && !text.includes(after)) {
      const words = after.split(" ").filter(Boolean);
      if (words.length && words.every((word) => text.includes(word))) warnings.push(warn("after-extraction-order", "warning", plan.pageIndex, plan.edit.id));
      else checks.push({ id: plan.edit.id, pageIndex: plan.pageIndex, status: "failed", code: "present-after" });
    }
    const expected = Math.max(0, count(sourceText, before) - 1 + count(after, before));
    if (count(text, before) > expected) checks.push({ id: plan.edit.id, pageIndex: plan.pageIndex, status: "failed", code: "removed-before" });
  }
}
function selectedCharIndexes(plans, pageIndex) {
  const selected = /* @__PURE__ */ new Set();
  for (const plan of plans) {
    if (plan.pageIndex !== pageIndex) continue;
    for (const index of plan.charIndex) selected.add(index);
  }
  return selected;
}
function keptOutsideSelection(sourceChars, outputChars, selected) {
  const pool = outputChars.map((ch) => ({ c: ch.c, x: ch.pdf[0], y: ch.pdf[1], used: false }));
  for (let index = 0; index < sourceChars.length; index++) {
    if (selected.has(index)) continue;
    const ch = sourceChars[index];
    if (!ch.c.trim()) continue;
    let found = -1;
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      if (item.used || item.c !== ch.c) continue;
      if (Math.abs(item.x - ch.pdf[0]) <= GLYPH_ORIGIN && Math.abs(item.y - ch.pdf[1]) <= GLYPH_ORIGIN) {
        found = i;
        break;
      }
    }
    if (found < 0) return false;
    pool[found].used = true;
  }
  return true;
}
function unsupported(failures, models) {
  const indexes = [...new Set(failures.map((item) => item.pageIndex).filter((index) => Number.isInteger(index)))];
  return new BrowserPdfError("unsupported", `\uC801\uC6A9\uD558\uC9C0 \uC54A\uC740 \uD3B8\uC9D1\uC774 \uC788\uC2B5\uB2C8\uB2E4 (${failures.map((item) => item.code).join(", ")}). \uD398\uC774\uC9C0 ${indexes.map((index) => index + 1).join(", ") || "-"}. \uBD80\uBD84 \uC801\uC6A9 \uD30C\uC77C\uC740 \uB9CC\uB4E4\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.`, {
    coordinateSpace: COORDINATE_SPACE,
    pages: models.map((model, index) => verificationPage(model, index)),
    edits: failures
  });
}
function anchorConvention(edit, anchor) {
  const spaces = [edit?.coordinateSpace, anchor?.coordinateSpace].filter((value) => value !== void 0);
  if (spaces.some((value) => value !== COORDINATE_SPACE)) return "invalid-anchor";
  if (anchor?.origin !== void 0 && anchor.origin !== COORDINATES.origin) return "invalid-anchor";
  const axes = [edit?.yAxis, anchor?.yAxis].filter((value) => value !== void 0);
  if (axes.some((value) => value !== COORDINATES.yAxis)) return "invalid-anchor";
  const units = [edit?.unit, anchor?.unit].filter((value) => value !== void 0);
  if (units.some((value) => value !== COORDINATES.unit)) return "invalid-anchor";
  return null;
}
function pageMapEntry(model, index) {
  const view = pageView(model);
  return {
    sourcePageIndex: index,
    outputPageIndex: index,
    continuationPageIndices: [],
    coordinateSpace: COORDINATE_SPACE,
    origin: COORDINATES.origin,
    yAxis: COORDINATES.yAxis,
    unit: COORDINATES.unit,
    width: view.width,
    height: view.height,
    rotation: model.rotation
  };
}
function verificationPage(model, index) {
  const entry = pageMapEntry(model, index);
  return {
    pageIndex: index,
    coordinateSpace: entry.coordinateSpace,
    origin: entry.origin,
    yAxis: entry.yAxis,
    unit: entry.unit,
    width: entry.width,
    height: entry.height,
    rotation: entry.rotation,
    editable: entry.rotation === 0
  };
}
function pageView(model) {
  const bounds = model.bounds;
  return {
    width: Math.round((bounds[2] - bounds[0]) * 1e3) / 1e3,
    height: Math.round((bounds[3] - bounds[1]) * 1e3) / 1e3
  };
}
function failure(edit, pageIndex, code) {
  return { id: edit.id, pageIndex, status: "unapplied", code };
}
function warn(code, severity, pageIndex, editId) {
  return { code, severity, pageIndex, editId };
}
function overlapping(plans) {
  const failures = [];
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      if (plans[i].pageIndex !== plans[j].pageIndex) continue;
      for (const index of plans[i].charIndex) if (plans[j].charIndex.has(index)) {
        failures.push(failure(plans[j].edit, plans[j].pageIndex, "overlap"));
        break;
      }
    }
  }
  return failures;
}
function normalized(chars) {
  let text = "";
  const map = [];
  let gap = false;
  let line = null;
  for (let index = 0; index < chars.length; index++) {
    const ch = chars[index];
    if (line !== null && ch.lineId !== line) gap = true;
    line = ch.lineId;
    if (!ch.c.trim()) {
      gap = true;
      continue;
    }
    if (gap && text) {
      text += " ";
      map.push(null);
    }
    gap = false;
    text += ch.c;
    map.push(index);
  }
  return { text, map };
}
function normalizeText(chars) {
  return normalized(chars).text;
}
function horizontalLine(chars) {
  if (chars.length < 2) return true;
  const ys = chars.map((ch) => ch.pdf[1]);
  if (Math.max(...ys) - Math.min(...ys) > 1.5) return false;
  for (let i = 1; i < chars.length; i++) if (chars[i].pdf[0] + 0.4 < chars[i - 1].pdf[0]) return false;
  return true;
}
function captureFontSnapshot(snapshot) {
  if (snapshot == null) return null;
  if (!Array.isArray(snapshot.fonts) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || typeof snapshot.digest !== "string")
    throw new BrowserPdfError("invalid", "Invalid font snapshot.");
  return { ...snapshot, fonts: snapshot.fonts.map((face) => {
    if (!face || !(face.bytes instanceof Uint8Array)) throw new BrowserPdfError("invalid", "Invalid font snapshot bytes.");
    return { ...face, bytes: face.bytes.slice() };
  }) };
}
async function validateFontSnapshot(snapshot) {
  if (snapshot == null) return null;
  if (!Array.isArray(snapshot.fonts) || !Number.isInteger(snapshot.revision) || typeof snapshot.digest !== "string")
    throw new BrowserPdfError("invalid", "Invalid font snapshot.");
  const faces = [];
  for (const face of snapshot.fonts) {
    if (!(face.bytes instanceof Uint8Array) || typeof face.sha256 !== "string")
      throw new BrowserPdfError("invalid", "Invalid font snapshot bytes.");
    const bytes = face.bytes.slice();
    if (await sha256(bytes) !== face.sha256.toLowerCase())
      throw new BrowserPdfError("invalid", "Font snapshot bytes do not match their SHA-256.");
    let parsed;
    try {
      parsed = parseFont(bytes);
    } catch {
      throw new BrowserPdfError("unsupported", "Font is invalid or embedding is restricted.");
    }
    if (typeof face.id !== "string" || !["local", "file", "bundled"].includes(face.source) || ["family", "postscriptName", "weight", "italic", "fsType"].some((field) => face[field] !== parsed[field]))
      throw new BrowserPdfError("invalid", "Font snapshot metadata does not match its bytes.");
    faces.push({ ...face, bytes });
  }
  const metadata = snapshot.fonts.map(({ bytes, ...rest }) => rest);
  if (await sha256(new TextEncoder().encode(JSON.stringify(metadata))) !== snapshot.digest.toLowerCase())
    throw new BrowserPdfError("invalid", "Font snapshot metadata digest does not match.");
  return faces;
}
function chooseSnapshotFont(faces, sourceName, sourceFont, text) {
  const source = familyKey(sourceName);
  const matches = (face) => source && (source === familyKey(face.postscriptName) || source === familyKey(face.family));
  const ranked = faces.filter((face) => matches(face) || face.source === "bundled").sort((a, b) => (matches(a) ? 0 : 1e4) - (matches(b) ? 0 : 1e4) + (a.italic === sourceFont.isItalic() ? 0 : 1e3) - (b.italic === sourceFont.isItalic() ? 0 : 1e3) + Math.abs(a.weight - (sourceFont.isBold() ? 700 : 400)) - Math.abs(b.weight - (sourceFont.isBold() ? 700 : 400)));
  for (const face of ranked) {
    let font;
    try {
      font = face.font || new mupdf.Font(face.postscriptName || face.family, face.bytes);
    } catch {
      continue;
    }
    if ([...text].every((ch) => font.encodeCharacter(ch.codePointAt(0)))) {
      face.font = font;
      return { font, name: font.getName(), substituted: !matches(face), face };
    }
    if (!face.font) font.destroy();
  }
  return null;
}
function glyphHex(font, text) {
  return "<" + [...text].map((ch) => font.encodeCharacter(ch.codePointAt(0)).toString(16).padStart(4, "0")).join("") + ">";
}
function ensureSnapshotFont(doc, page, plan) {
  const resources = ownResources(doc, page);
  let dict = resources.get("Font");
  if (dict.isNull()) {
    dict = doc.newDictionary();
    resources.put("Font", dict);
  } else dict = dict.resolve();
  const taken = /* @__PURE__ */ new Set();
  dict.forEach((_value, key2) => taken.add(String(key2)));
  let name = "FwEmbedded";
  while (taken.has(name)) name += "x";
  const pdfFont = doc.addFont(plan.supplied.font);
  const mappings = /* @__PURE__ */ new Map();
  for (const line of plan.layout.lines) for (const ch of line) {
    const gid = plan.supplied.font.encodeCharacter(ch.codePointAt(0));
    if (mappings.has(gid) && mappings.get(gid) !== ch) throw new BrowserPdfError("unsupported", "Font maps multiple Unicode characters to one glyph.");
    mappings.set(gid, ch);
  }
  const entries = [...mappings].map(([gid, ch]) => `<${gid.toString(16).padStart(4, "0")}> ${utf16hex(ch)}`);
  let cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /FwUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    cmap += `${chunk.length} beginbfchar
${chunk.join("\n")}
endbfchar
`;
  }
  cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  pdfFont.put("ToUnicode", doc.addStream(new TextEncoder().encode(cmap), {}));
  dict.put(name, pdfFont);
  return name;
}
function base14(fontName, font) {
  const bare = String(fontName || "").replace(/^[A-Z]{6}\+/, "");
  if (BASE14.includes(bare)) return { name: bare, substituted: false };
  if (FACE_ALIAS[bare]) return { name: FACE_ALIAS[bare], substituted: true };
  if (!font) return null;
  const bold = font.isBold();
  const italic = font.isItalic();
  const family = font.isMono() ? "Courier" : font.isSerif() ? "Times" : "Helvetica";
  const name = base14Style(family, bold, italic);
  return { name, substituted: true };
}
function base14Style(family, bold, italic) {
  const name = family === "Times" ? bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman" : family === "Courier" ? bold && italic ? "Courier-BoldOblique" : bold ? "Courier-Bold" : italic ? "Courier-Oblique" : "Courier" : bold && italic ? "Helvetica-BoldOblique" : bold ? "Helvetica-Bold" : italic ? "Helvetica-Oblique" : "Helvetica";
  return name;
}
function metrics(name) {
  if (!fonts.has(name)) fonts.set(name, new mupdf.Font(name));
  return fonts.get(name);
}
function cjkFont() {
  return metrics("ko");
}
function textEncoding(face, after) {
  if (!after) return { encoding: "winansi", substituted: face.substituted };
  const latin = metrics(face.name);
  const latinOk = [...after].every((ch) => latin.encodeCharacter(ch)) && winAnsi(after) !== null;
  if (latinOk) return { encoding: "winansi", substituted: face.substituted };
  const ko = cjkFont();
  if ([...after].every((ch) => ko.encodeCharacter(ch))) return { encoding: "uniks-utf16", substituted: true };
  return { error: "missing-glyphs" };
}
function utf16hex(text) {
  let hex = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 65535) {
      const unit = code - 65536;
      hex += (55296 + (unit >> 10)).toString(16).padStart(4, "0");
      hex += (56320 + (unit & 1023)).toString(16).padStart(4, "0");
    } else hex += code.toString(16).padStart(4, "0");
  }
  return "<" + hex + ">";
}
function measure(font, size, text) {
  let width = 0;
  for (const ch of text) {
    const gid = font.encodeCharacter(ch.codePointAt(0));
    if (!gid) return null;
    width += font.advanceGlyph(gid) * size;
  }
  return width;
}
function roomRight(plan, model, page) {
  const end = plan.origin[0] + plan.hole;
  let limit = apply(model.toPdf, model.bounds[2], model.bounds[3])[0] - 36;
  for (const ch of model.chars) {
    if (plan.charIndex.has(model.chars.indexOf(ch))) continue;
    if (ch.lineId !== plan.chars[0].lineId || !ch.c.trim()) continue;
    if (ch.pdf[0] > end - 0.5) limit = Math.min(limit, ch.pdf[0] - 1);
  }
  return Math.max(0, limit - plan.origin[0]);
}
function wrap(font, size, text, maxWidth) {
  const lines = [];
  let current = "";
  const flush = () => {
    if (current.trim()) lines.push(current.trimEnd());
    current = "";
  };
  for (const part of text.split(/(\s+)/)) {
    if (!part || /^\s+$/.test(part)) {
      if (current && measure(font, size, (current + " ").trimEnd()) <= maxWidth) current += " ";
      continue;
    }
    const trial = current ? current + part : part;
    const width = measure(font, size, trial.trimEnd());
    if (width === null) return null;
    if (width <= maxWidth) {
      current = trial;
      continue;
    }
    flush();
    if (measure(font, size, part) <= maxWidth) {
      current = part;
      continue;
    }
    let buffer = "";
    for (const ch of part) {
      const next = buffer + ch;
      const piece = measure(font, size, next);
      if (piece === null) return null;
      if (piece > maxWidth && buffer) {
        lines.push(buffer);
        buffer = ch;
      } else buffer = next;
    }
    current = buffer;
  }
  flush();
  return lines.length ? lines : null;
}
function clear(lines, plan, model, font) {
  const leading = plan.size * 1.2;
  for (let index = 1; index < lines.length; index++) {
    const width = measure(font, plan.size, lines[index]);
    const x = plan.origin[0];
    const y = plan.origin[1] - index * leading;
    const corners = [[x, y - plan.size * 0.25], [x + width, y - plan.size * 0.25], [x, y + plan.size * 0.85], [x + width, y + plan.size * 0.85]];
    const pageBox = corners.map((point) => apply(model.transform, point[0], point[1]));
    const box = [Math.min(...pageBox.map((point) => point[0])), Math.min(...pageBox.map((point) => point[1])), Math.max(...pageBox.map((point) => point[0])), Math.max(...pageBox.map((point) => point[1]))];
    const bounds = model.bounds;
    if (box[0] < -2 || box[1] < -2 || box[2] > bounds[2] + 2 || box[3] > bounds[3] + 2) return false;
    for (const image of model.images) if (intersects(box, image, 1)) return false;
    for (let charIndex = 0; charIndex < model.chars.length; charIndex++) {
      if (plan.charIndex.has(charIndex)) continue;
      if (intersects(box, union([model.chars[charIndex]]), 0.8)) return false;
    }
  }
  return true;
}
function ensureCjkFont(doc, page) {
  const resources = ownResources(doc, page);
  let fontsDict = resources.get("Font");
  if (fontsDict.isNull()) {
    fontsDict = doc.newDictionary();
    resources.put("Font", fontsDict);
  } else fontsDict = fontsDict.resolve();
  let existing = null;
  fontsDict.forEach((value, key2) => {
    if (existing) return;
    const item = value.resolve();
    const encoding = item.get("Encoding");
    if (!encoding.isNull() && encoding.asName() === "UniKS-UTF16-H") existing = String(key2);
  });
  if (existing) return existing;
  let name = "FwKorea";
  const taken = /* @__PURE__ */ new Set();
  fontsDict.forEach((_value, key2) => taken.add(String(key2)));
  while (taken.has(name)) name += "x";
  fontsDict.put(name, doc.addCJKFont(cjkFont(), "ko", 0, false));
  return name;
}
function ensureFont(doc, page, baseName) {
  const resources = ownResources(doc, page);
  let fontsDict = resources.get("Font");
  if (fontsDict.isNull()) {
    fontsDict = doc.newDictionary();
    resources.put("Font", fontsDict);
  } else fontsDict = fontsDict.resolve();
  let existing = null;
  fontsDict.forEach((value, key2) => {
    if (existing) return;
    const item = value.resolve();
    const base = item.get("BaseFont");
    const encoding = item.get("Encoding");
    if (!base.isNull() && base.asName() === baseName && !encoding.isNull() && encoding.asName() === "WinAnsiEncoding") existing = String(key2);
  });
  if (existing) return existing;
  let name = "Fw" + baseName.replace(/[^A-Za-z0-9]/g, "");
  const taken = /* @__PURE__ */ new Set();
  fontsDict.forEach((_value, key2) => taken.add(String(key2)));
  while (taken.has(name)) name += "x";
  fontsDict.put(name, doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: baseName, Encoding: "WinAnsiEncoding" }));
  return name;
}
function ownResources(doc, page) {
  const obj = page.getObject();
  const own = obj.get("Resources");
  if (!own.isNull()) return own.resolve();
  const copy = doc.newDictionary();
  const inherited = obj.getInheritable("Resources");
  if (!inherited.isNull()) inherited.resolve().forEach((value, key2) => copy.put(key2, value));
  obj.put("Resources", copy);
  return copy;
}
function winAnsi(text) {
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    let byte = null;
    if (code <= 127) byte = code;
    else if (code >= 160 && code <= 255) byte = code;
    else if (WINANSI_EXTRA[code] !== void 0) byte = WINANSI_EXTRA[code];
    if (byte === null) return null;
    bytes.push(byte);
  }
  let out = "(";
  for (const byte of bytes) {
    if (byte === 40 || byte === 41 || byte === 92) out += "\\" + String.fromCharCode(byte);
    else if (byte < 32 || byte > 126) out += "\\" + byte.toString(8).padStart(3, "0");
    else out += String.fromCharCode(byte);
  }
  return out + ")";
}
function rgb(color) {
  if (!Array.isArray(color) || color.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  if (color.length === 1) return [color[0], color[0], color[0]];
  if (color.length === 3) return [color[0], color[1], color[2]];
  return null;
}
function rotationOf(page) {
  const value = page.getObject().get("Rotate");
  if (value.isNull()) return 0;
  return (value.asNumber() % 360 + 360) % 360;
}
function apply(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}
function union(chars) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ch of chars) for (let i = 0; i < 8; i += 2) {
    x0 = Math.min(x0, ch.quad[i]);
    y0 = Math.min(y0, ch.quad[i + 1]);
    x1 = Math.max(x1, ch.quad[i]);
    y1 = Math.max(y1, ch.quad[i + 1]);
  }
  return [x0, y0, x1, y1];
}
function pdfSpan(transform, chars) {
  let x0 = Infinity, x1 = -Infinity;
  for (const ch of chars) for (let i = 0; i < 8; i += 2) {
    const x = apply(transform, ch.quad[i], ch.quad[i + 1])[0];
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
  }
  return [x0, x1];
}
function contains(box, bbox, tol) {
  return box[0] >= bbox[0] - tol && box[1] >= bbox[1] - tol && box[2] <= bbox[2] + tol && box[3] <= bbox[3] + tol;
}
function intersects(a, b, pad) {
  return a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad;
}
function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every((value) => typeof value === "number" && Number.isFinite(value)) && box[0] < box[2] && box[1] < box[3];
}
function count(text, needle) {
  if (!needle) return 0;
  let found = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    found += 1;
    from = at + needle.length;
  }
  return found;
}
function num(value) {
  const rounded = Math.round(value * 1e3) / 1e3;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}
function sameImages(a, b) {
  if (a.length !== b.length) return false;
  const key2 = (box) => box.map((value) => Math.round(value * 10) / 10).join(",");
  const left = a.map(key2).sort();
  const right = b.map(key2).sort();
  return left.every((value, index) => value === right[index]);
}
function editedName(name) {
  const base = String(name || "document.pdf");
  return /\.pdf$/i.test(base) ? base.replace(/\.pdf$/i, ".edited.pdf") : base + ".edited.pdf";
}
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function warm() {
  return true;
}
function unavailableError(cause) {
  const error2 = new BrowserPdfError(
    "engine_unavailable",
    "PDF \uC5D4\uC9C4\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
    cause ? { reason: String(cause.message || cause.name || cause) } : {}
  );
  return error2;
}
var SYMBOL_FALLBACK = {
  160: " ",
  8201: " ",
  8202: " ",
  8239: " ",
  8208: "-",
  8209: "-",
  8210: "-",
  8725: "/",
  8727: "*",
  9826: "<>",
  8594: "->",
  8592: "<-",
  8596: "<->",
  8658: "=>",
  8712: "in",
  8713: "not in",
  8810: "<<",
  8811: ">>"
};
var CJK_RANGES = [
  [4352, 4607],
  [11904, 40959],
  [43360, 43391],
  [44032, 55215],
  [55216, 55295],
  [63744, 64255],
  [65072, 65103],
  [65280, 65519],
  [131072, 195103]
];
function isCjkCodePoint(cp) {
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}
function winAnsiByte(cp) {
  if (cp <= 127) return cp;
  if (cp >= 160 && cp <= 255) return cp;
  if (WINANSI_EXTRA[cp] !== void 0) return WINANSI_EXTRA[cp];
  return null;
}
function base14FromStyle(style) {
  const bare = String(style?.fontName || "").replace(/^[A-Z]{6}\+/, "");
  if (BASE14.includes(bare)) return bare;
  if (FACE_ALIAS[bare]) return FACE_ALIAS[bare];
  const bold = !!style?.isBold;
  const italic = !!style?.isItalic;
  const family = style?.isMono ? "Courier" : style?.isSerif !== false ? "Times" : "Helvetica";
  return base14Style(family, bold, italic);
}
function readRewritePage(page) {
  const transform = page.getTransform();
  const toPdf = mupdf.Matrix.invert(transform);
  const bounds = page.getBounds();
  const chars = [];
  const st = page.toStructuredText("preserve-whitespace");
  let lineId = -1;
  let lineDir = [1, 0];
  try {
    st.walk({
      beginLine(_bbox, _wmode, dir) {
        lineId += 1;
        lineDir = [Number(dir?.[0]) || 0, Number(dir?.[1]) || 0];
        if (!lineDir[0] && !lineDir[1]) lineDir = [1, 0];
      },
      onChar(c, origin, font, size, quad, color) {
        try {
          const pdfOrigin = apply(toPdf, origin[0], origin[1]);
          chars.push({
            c,
            origin: [origin[0], origin[1]],
            pdfOrigin,
            lineId,
            lineDir,
            fontName: font.getName(),
            isBold: font.isBold(),
            isItalic: font.isItalic(),
            isSerif: font.isSerif(),
            isMono: font.isMono(),
            size: Number(size) > 0 ? Number(size) : 10,
            quad: [...quad],
            color: rgb(color) || [0, 0, 0]
          });
        } finally {
          try {
            font.destroy();
          } catch {
          }
        }
      }
    });
  } finally {
    try {
      st.destroy();
    } catch {
    }
  }
  return { chars, bounds, transform, toPdf };
}
function rectsToDisplay(rects, bounds) {
  const bx0 = bounds[0];
  const by0 = bounds[1];
  const bw = bounds[2] - bx0;
  const bh = bounds[3] - by0;
  const out = [];
  for (const r of Array.isArray(rects) ? rects : []) {
    if (!r || typeof r !== "object") continue;
    const x = Number(r.x);
    const y = Number(r.y);
    const w = Number(r.w);
    const h = Number(r.h);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (!(w > 0) || !(h > 0)) continue;
    out.push([
      bx0 + x * bw,
      by0 + y * bh,
      bx0 + (x + w) * bw,
      by0 + (y + h) * bh
    ]);
  }
  return out;
}
function selectGlyphsByRects(chars, displayRects) {
  const selected = [];
  for (const ch of chars) {
    const [gx0, gy0, gx1, gy1] = quadBounds(ch.quad);
    const cx = (gx0 + gx1) / 2;
    const cy = (gy0 + gy1) / 2;
    for (const [rx0, ry0, rx1, ry1] of displayRects) {
      const rw = rx1 - rx0;
      const rh = ry1 - ry0;
      const tolX = rw < rh && rw < 8 ? Math.min(0.5, rw * 0.08) : 0.5;
      const tolY = Math.min(1.5, Math.max(0.5, rh * 0.15));
      if (cx >= rx0 - tolX && cx <= rx1 + tolX && cy >= ry0 - tolY && cy <= ry1 + tolY) {
        selected.push(ch);
        break;
      }
    }
  }
  return selected;
}
var ALIGN_HYPHEN_RE = /[\u00ad\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
function normalizeAlignText(text) {
  return String(text == null ? "" : text).normalize("NFKC").replace(ALIGN_HYPHEN_RE, "-").replace(/\s+/g, "");
}
function rectCenterOf(displayRects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [rx0, ry0, rx1, ry1] of displayRects) {
    if (rx0 < x0) x0 = rx0;
    if (ry0 < y0) y0 = ry0;
    if (rx1 > x1) x1 = rx1;
    if (ry1 > y1) y1 = ry1;
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
var ALIGN_WORD_CHAR_RE = /[\p{L}\p{N}]/u;
function lineBoxesByLineId(allChars) {
  const lines = /* @__PURE__ */ new Map();
  for (const ch of allChars) {
    if (!ch.c.trim()) continue;
    const box = quadBounds(ch.quad);
    let entry = lines.get(ch.lineId);
    if (!entry) {
      entry = { box: [...box], dir: ch.lineDir || [1, 0] };
      lines.set(ch.lineId, entry);
    } else {
      if (box[0] < entry.box[0]) entry.box[0] = box[0];
      if (box[1] < entry.box[1]) entry.box[1] = box[1];
      if (box[2] > entry.box[2]) entry.box[2] = box[2];
      if (box[3] > entry.box[3]) entry.box[3] = box[3];
    }
  }
  return lines;
}
function lineNearRect(entry, rect) {
  const [lx0, ly0, lx1, ly1] = entry.box;
  const [rx0, ry0, rx1, ry1] = rect;
  const vertical = Math.abs(entry.dir[1]) > Math.abs(entry.dir[0]);
  if (vertical) {
    const tol2 = Math.min(1.5, Math.max(0.5, (rx1 - rx0) * 0.15));
    return lx0 <= rx1 + tol2 && lx1 >= rx0 - tol2 && ly0 <= ry1 + 20 && ly1 >= ry0 - 20;
  }
  const tol = Math.min(1.5, Math.max(0.5, (ry1 - ry0) * 0.15));
  return ly0 <= ry1 + tol && ly1 >= ry0 - tol && lx0 <= rx1 + 20 && lx1 >= rx0 - 20;
}
function candidateAlignLineIds(allChars, rectSelected, displayRects) {
  const ids = new Set(rectSelected.map((ch) => ch.lineId));
  const lines = lineBoxesByLineId(allChars);
  for (const [lineId, entry] of lines) {
    if (displayRects.some((r) => lineNearRect(entry, r))) ids.add(lineId);
  }
  return ids;
}
function buildAlignCorpus(lineChars) {
  let norm = "";
  const charMap = [];
  const indexMap = [];
  for (let idx = 0; idx < lineChars.length; idx++) {
    const ch = lineChars[idx];
    if (!ch.c.trim()) continue;
    const piece = normalizeAlignText(ch.c);
    for (let i = 0; i < piece.length; i++) {
      norm += piece[i];
      charMap.push(ch);
      indexMap.push(idx);
    }
  }
  return { norm, charMap, indexMap };
}
function isWordBoundaryAt(lineChars, firstIdx, lastIdx, needLeft, needRight) {
  if (needLeft && firstIdx > 0) {
    const prev = lineChars[firstIdx - 1];
    if (prev.lineId === lineChars[firstIdx].lineId && ALIGN_WORD_CHAR_RE.test(normalizeAlignText(prev.c))) return false;
  }
  if (needRight && lastIdx + 1 < lineChars.length) {
    const next = lineChars[lastIdx + 1];
    if (next.lineId === lineChars[lastIdx].lineId && ALIGN_WORD_CHAR_RE.test(normalizeAlignText(next.c))) return false;
  }
  return true;
}
function betterAlignCandidate(cand, best) {
  return !best || cand.overlap > best.overlap || cand.overlap === best.overlap && cand.dist < best.dist;
}
function scoreAlignOccurrence(charMap, at, len, selectedSet, rectCenter) {
  const occSet = /* @__PURE__ */ new Set();
  for (let i = at; i < at + len; i++) occSet.add(charMap[i]);
  let overlap = 0;
  for (const ch of occSet) if (selectedSet.has(ch)) overlap += 1;
  const box = union([...occSet]);
  const dist = Math.hypot((box[0] + box[2]) / 2 - rectCenter[0], (box[1] + box[3]) / 2 - rectCenter[1]);
  return { at, occSet, overlap, dist };
}
function pickBestAlignOccurrence(lineChars, corpus, needle, selectedSet, rectCenter) {
  const chars = [...needle];
  const needLeft = ALIGN_WORD_CHAR_RE.test(chars[0]);
  const needRight = ALIGN_WORD_CHAR_RE.test(chars[chars.length - 1]);
  let bestWhole = null;
  let bestSub = null;
  for (let from = 0; from <= corpus.norm.length - needle.length; ) {
    const at = corpus.norm.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    const cand = scoreAlignOccurrence(corpus.charMap, at, needle.length, selectedSet, rectCenter);
    const firstIdx = corpus.indexMap[at];
    const lastIdx = corpus.indexMap[at + needle.length - 1];
    if (isWordBoundaryAt(lineChars, firstIdx, lastIdx, needLeft, needRight)) {
      if (betterAlignCandidate(cand, bestWhole)) bestWhole = cand;
    }
    if (betterAlignCandidate(cand, bestSub)) bestSub = cand;
  }
  return bestWhole || bestSub;
}
function alignGlyphsToOriginalText(allChars, rectSelected, displayRects, originalText) {
  const needle = normalizeAlignText(originalText);
  if (!needle) return { chars: rectSelected, aligned: false };
  const lineIds = candidateAlignLineIds(allChars, rectSelected, displayRects);
  if (!lineIds.size) return { chars: rectSelected, aligned: false };
  const lineChars = allChars.filter((ch) => lineIds.has(ch.lineId));
  const corpus = buildAlignCorpus(lineChars);
  if (corpus.norm.length < needle.length) return { chars: rectSelected, aligned: false };
  const best = pickBestAlignOccurrence(lineChars, corpus, needle, new Set(rectSelected), rectCenterOf(displayRects));
  if (!best) return { chars: rectSelected, aligned: false };
  const firstIdx = corpus.indexMap[best.at];
  const lastIdx = corpus.indexMap[best.at + needle.length - 1];
  const aligned = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    const ch = lineChars[i];
    if (best.occSet.has(ch) || !ch.c.trim()) aligned.push(ch);
  }
  return { chars: aligned, aligned: aligned.length > 0 };
}
function trimUnchangedSymbolEdges(selectedChars, newText) {
  const raw = String(newText == null ? "" : newText);
  if (!raw) return { chars: selectedChars, text: raw };
  const drawn = selectedChars.filter((ch) => ch.c.trim());
  const next = [...raw];
  let start = 0;
  let end = drawn.length;
  let nStart = 0;
  let nEnd = next.length;
  const isSymbol = (c) => winAnsiByte(c.codePointAt(0)) === null && !isCjkCodePoint(c.codePointAt(0));
  while (end - start > 1 && nEnd - nStart > 1 && isSymbol(drawn[start].c) && drawn[start].c === next[nStart]) {
    start += 1;
    nStart += 1;
  }
  while (end - start > 1 && nEnd - nStart > 1 && isSymbol(drawn[end - 1].c) && drawn[end - 1].c === next[nEnd - 1]) {
    end -= 1;
    nEnd -= 1;
  }
  if (start === 0 && end === drawn.length) return { chars: selectedChars, text: raw };
  const firstIdx = selectedChars.indexOf(drawn[start]);
  const lastIdx = selectedChars.lastIndexOf(drawn[end - 1]);
  return { chars: selectedChars.slice(firstIdx, lastIdx + 1), text: next.slice(nStart, nEnd).join("") };
}
function alignedDisplayRects(selectedChars) {
  const byLine = /* @__PURE__ */ new Map();
  for (const ch of selectedChars) {
    if (!ch.c.trim()) continue;
    let arr = byLine.get(ch.lineId);
    if (!arr) {
      arr = [];
      byLine.set(ch.lineId, arr);
    }
    arr.push(ch);
  }
  return [...byLine.values()].map((arr) => union(arr));
}
function fallbackRedactionRect(ch, protectedBoxes) {
  const box = removalBox(ch) || quadBounds(ch.quad);
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const fracs = [0.5, 0.25, 0.75, 0.15, 0.85];
  if (w > 0.1 && h > 0.1) {
    for (const fy of fracs) {
      for (const fx of fracs) {
        const px = x0 + w * fx;
        const py = y0 + h * fy;
        const cand = [px - 0.05, py - 0.05, px + 0.05, py + 0.05];
        if (!protectedBoxes.some((obs) => intersects(cand, obs, 0))) return cand;
      }
    }
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return [cx - 0.1, cy - 0.1, cx + 0.1, cy + 0.1];
}
function redactRewritePage(page, pagePlans, allChars) {
  const selectedSet = /* @__PURE__ */ new Set();
  for (const plan of pagePlans) {
    for (const ch of plan.selectedChars) selectedSet.add(ch);
  }
  if (!selectedSet.size) return;
  const protectedBoxes = [];
  for (const ch of allChars) {
    if (selectedSet.has(ch) || !ch.c.trim()) continue;
    const box = removalBox(ch);
    if (box) protectedBoxes.push(box);
  }
  const quads = [];
  for (const ch of selectedSet) {
    if (!ch.c.trim()) continue;
    const rect = safeRedactionRect(ch, protectedBoxes) || fallbackRedactionRect(ch, protectedBoxes);
    const [x0, y0, x1, y1] = rect;
    quads.push([x0, y1, x1, y1, x0, y0, x1, y0]);
  }
  if (!quads.length) return;
  const annot = page.createAnnotation("Redact");
  try {
    annot.setRect(quadBounds(quads.flat()));
    annot.setQuadPoints(quads);
    annot.update();
    page.applyRedactions(
      false,
      mupdf.PDFPage.REDACT_IMAGE_NONE,
      mupdf.PDFPage.REDACT_LINE_ART_NONE,
      mupdf.PDFPage.REDACT_TEXT_REMOVE
    );
  } finally {
    try {
      annot.destroy();
    } catch {
    }
  }
}
function pdfDirection(toPdf, dx, dy) {
  const p0 = apply(toPdf, 0, 0);
  const p1 = apply(toPdf, dx, dy);
  let ux = p1[0] - p0[0];
  let uy = p1[1] - p0[1];
  const len = Math.hypot(ux, uy) || 1;
  return [ux / len, uy / len];
}
var REWRITE_PAGE_MARGIN = 2;
var REWRITE_MIN_SCALE = 65;
function maxDistanceInBounds(ox, oy, dxPdf, dyPdf, transform, bounds, margin = REWRITE_PAGE_MARGIN) {
  const [sx, sy] = apply(transform, ox, oy);
  const [ex, ey] = apply(transform, ox + dxPdf, oy + dyPdf);
  const vx = ex - sx;
  const vy = ey - sy;
  const minX = bounds[0] + margin;
  const minY = bounds[1] + margin;
  const maxX = bounds[2] - margin;
  const maxY = bounds[3] - margin;
  let tMax = Infinity;
  if (vx > 1e-6) tMax = Math.min(tMax, (maxX - sx) / vx);
  else if (vx < -1e-6) tMax = Math.min(tMax, (minX - sx) / vx);
  if (vy > 1e-6) tMax = Math.min(tMax, (maxY - sy) / vy);
  else if (vy < -1e-6) tMax = Math.min(tMax, (minY - sy) / vy);
  return Math.max(0, Number.isFinite(tMax) ? tMax : 0);
}
function unitDisplayDir(dir) {
  const dx = Number(dir?.[0]) || 0;
  const dy = Number(dir?.[1]) || 0;
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? [dx / len, dy / len] : [1, 0];
}
function rectNormalThickness(rect, dir) {
  const [dx, dy] = unitDisplayDir(dir);
  return Math.abs(-dy) * (rect[2] - rect[0]) + Math.abs(dx) * (rect[3] - rect[1]);
}
function rectsMergeOnBand(line, r, vertical) {
  if (vertical) {
    const minW = Math.min(line[2] - line[0], r[2] - r[0]);
    const overlapX = Math.min(line[2], r[2]) - Math.max(line[0], r[0]);
    const gapY = Math.max(0, r[1] - line[3], line[1] - r[3]);
    return minW > 0 && overlapX >= minW * 0.5 && gapY <= minW * 2.5;
  }
  const minH = Math.min(line[3] - line[1], r[3] - r[1]);
  const overlapY = Math.min(line[3], r[3]) - Math.max(line[1], r[1]);
  const gapX = Math.max(0, r[0] - line[2], line[0] - r[2]);
  return minH > 0 && overlapY >= minH * 0.5 && gapX <= minH * 2.5;
}
function mergeDisplayLineRects(displayRects, dir = [1, 0]) {
  const [dx, dy] = unitDisplayDir(dir);
  const vertical = Math.abs(dy) > Math.abs(dx);
  const sorted = [...displayRects].sort((a, b) => vertical ? a[0] - b[0] || a[1] - b[1] : a[1] - b[1] || a[0] - b[0]);
  const lines = [];
  for (const r of sorted) {
    let merged = false;
    for (const line of lines) {
      if (rectsMergeOnBand(line, r, vertical)) {
        line[0] = Math.min(line[0], r[0]);
        line[1] = Math.min(line[1], r[1]);
        line[2] = Math.max(line[2], r[2]);
        line[3] = Math.max(line[3], r[3]);
        merged = true;
        break;
      }
    }
    if (!merged) lines.push([...r]);
  }
  const nxD = -dy;
  const nyD = dx;
  lines.sort((a, b) => {
    const na = (a[0] + a[2]) / 2 * nxD + (a[1] + a[3]) / 2 * nyD;
    const nb = (b[0] + b[2]) / 2 * nxD + (b[1] + b[3]) / 2 * nyD;
    if (Math.abs(na - nb) > 1) return na - nb;
    const ua = (a[0] + a[2]) / 2 * dx + (a[1] + a[3]) / 2 * dy;
    const ub = (b[0] + b[2]) / 2 * dx + (b[1] + b[3]) / 2 * dy;
    return ua - ub;
  });
  return lines;
}
function rightClearWidth(lineRect, sx, pageAvailW, lineDir, model, selectedSet) {
  if (Math.abs(lineDir[0] - 1) > 0.01 || Math.abs(lineDir[1]) > 0.01) return pageAvailW;
  const [, ry0, rx1, ry1] = lineRect;
  let maxRightX = model.bounds[2] - REWRITE_PAGE_MARGIN;
  for (const ch of model.chars) {
    if (selectedSet.has(ch) || !ch.c.trim()) continue;
    const [gx0, gy0, , gy1] = quadBounds(ch.quad);
    if (gy0 < ry1 && gy1 > ry0 && gx0 >= rx1 - 1) {
      maxRightX = Math.min(maxRightX, gx0 - 1);
    }
  }
  return Math.min(pageAvailW, Math.max(0, maxRightX - sx));
}
function splitCharsIntoLineBands(lineChars, dir = [1, 0]) {
  const [dx, dy] = unitDisplayDir(dir);
  const nxD = -dy;
  const nyD = dx;
  const items = lineChars.map((ch) => {
    const box = quadBounds(ch.quad);
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    const thick = Math.max(1, Math.abs(nxD) * (box[2] - box[0]) + Math.abs(nyD) * (box[3] - box[1]));
    return { ch, box, nPos: cx * nxD + cy * nyD, uPos: cx * dx + cy * dy, thick };
  });
  items.sort((a, b) => a.nPos - b.nPos || a.uPos - b.uPos);
  const bands = [];
  for (const item of items) {
    let target = null;
    for (const band of bands) {
      const minT = Math.min(band.thick, item.thick);
      if (Math.abs(item.nPos - band.nPos) <= minT * 0.6) {
        target = band;
        break;
      }
    }
    if (!target) {
      bands.push({ nPos: item.nPos, uPos: item.uPos, thick: item.thick, box: [...item.box], chars: [item.ch] });
    } else {
      target.chars.push(item.ch);
      target.box[0] = Math.min(target.box[0], item.box[0]);
      target.box[1] = Math.min(target.box[1], item.box[1]);
      target.box[2] = Math.max(target.box[2], item.box[2]);
      target.box[3] = Math.max(target.box[3], item.box[3]);
      const cx = (target.box[0] + target.box[2]) / 2;
      const cy = (target.box[1] + target.box[3]) / 2;
      target.nPos = cx * nxD + cy * nyD;
      target.thick = Math.max(target.thick, item.thick);
    }
  }
  bands.sort((a, b) => a.nPos - b.nPos || a.uPos - b.uPos);
  return bands;
}
function summarizeDrawnStyle(drawn) {
  const defaultStyle = { fontName: "Times-Roman", isBold: false, isItalic: false, isSerif: true, isMono: false };
  if (!drawn.length) return { medianSize: 10, style: defaultStyle, color: [0, 0, 0] };
  const sizes = drawn.map((c) => c.size).filter((s) => s > 0).sort((a, b) => a - b);
  const medianSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
  const styleCounts = /* @__PURE__ */ new Map();
  let style = drawn[0];
  let bestCount = 0;
  for (const ch of drawn) {
    const key2 = `${ch.fontName}|${ch.isBold}|${ch.isItalic}|${ch.isSerif}|${ch.isMono}`;
    const next = (styleCounts.get(key2) || 0) + 1;
    styleCounts.set(key2, next);
    if (next > bestCount) {
      bestCount = next;
      style = ch;
    }
  }
  return { medianSize, style, color: style.color || [0, 0, 0] };
}
function charsInDisplayRect(drawn, lineRect) {
  const [rx0, ry0, rx1, ry1] = lineRect;
  const tolX = 0.5;
  const tolY = Math.min(1.5, Math.max(0.5, (ry1 - ry0) * 0.15));
  const out = [];
  for (const ch of drawn) {
    const [gx0, gy0, gx1, gy1] = quadBounds(ch.quad);
    const cx = (gx0 + gx1) / 2;
    const cy = (gy0 + gy1) / 2;
    if (cx >= rx0 - tolX && cx <= rx1 + tolX && cy >= ry0 - tolY && cy <= ry1 + tolY) out.push(ch);
  }
  return out;
}
function maxSpanProjection(points, ox, oy, ux, uy, toPdf) {
  let maxProj = 0;
  for (const [px, py] of points) {
    const pt = apply(toPdf, px, py);
    const proj = (pt[0] - ox) * ux + (pt[1] - oy) * uy;
    if (proj > maxProj) maxProj = proj;
  }
  return maxProj;
}
function buildGlyphBandSlot(band, refRect, summary, model, selectedSet) {
  const arr = band.chars;
  const dir = arr[0].lineDir || [1, 0];
  const [ux, uy] = pdfDirection(model.toPdf, dir[0], dir[1]);
  const [nx, ny] = pdfDirection(model.toPdf, -dir[1], dir[0]);
  arr.sort((a, b) => a.pdfOrigin[0] * ux + a.pdfOrigin[1] * uy - (b.pdfOrigin[0] * ux + b.pdfOrigin[1] * uy));
  const [ox, oy] = arr[0].pdfOrigin;
  const glyphPts = [];
  for (const ch of arr) {
    for (let i = 0; i < 8; i += 2) glyphPts.push([ch.quad[i], ch.quad[i + 1]]);
  }
  const maxGlyphProj = maxSpanProjection(glyphPts, ox, oy, ux, uy, model.toPdf);
  const rectPts = [[refRect[0], refRect[1]], [refRect[2], refRect[1]], [refRect[0], refRect[3]], [refRect[2], refRect[3]]];
  const maxRectProj = maxSpanProjection(rectPts, ox, oy, ux, uy, model.toPdf);
  const pageAvailW = maxDistanceInBounds(ox, oy, ux, uy, model.transform, model.bounds);
  const pageAvailH = maxDistanceInBounds(ox, oy, nx, ny, model.transform, model.bounds);
  const [sx] = apply(model.transform, ox, oy);
  const rightClearW = rightClearWidth(refRect, sx, pageAvailW, dir, model, selectedSet);
  const rawW = Math.max(summary.medianSize, maxGlyphProj, maxRectProj);
  const slotWidth = pageAvailW > 0 ? Math.min(pageAvailW, rawW) : rawW;
  return {
    ox,
    oy,
    ux,
    uy,
    nx,
    ny,
    size: summary.medianSize,
    slotWidth,
    pageAvailW,
    pageAvailH,
    rightClearW,
    color: summary.color,
    style: summary.style
  };
}
function buildEmptyRectSlot(lineRect, hasDrawn, summary, model, selectedSet) {
  const [rx0, ry0, rx1, ry1] = lineRect;
  const [ux, uy] = pdfDirection(model.toPdf, 1, 0);
  const [nx, ny] = pdfDirection(model.toPdf, 0, 1);
  const rh = Math.max(4, ry1 - ry0);
  const size = hasDrawn ? summary.medianSize : Math.max(6, Math.min(24, rh * 0.8));
  const baseY = ry0 + rh * 0.8;
  const [ox, oy] = apply(model.toPdf, rx0, baseY);
  const [ex, ey] = apply(model.toPdf, rx1, baseY);
  const pageAvailW = maxDistanceInBounds(ox, oy, ux, uy, model.transform, model.bounds);
  const pageAvailH = maxDistanceInBounds(ox, oy, nx, ny, model.transform, model.bounds);
  const rightClearW = rightClearWidth(lineRect, rx0, pageAvailW, [1, 0], model, selectedSet);
  const rawW = Math.max(size, Math.hypot(ex - ox, ey - oy));
  const slotWidth = pageAvailW > 0 ? Math.min(pageAvailW, rawW) : rawW;
  return {
    ox,
    oy,
    ux,
    uy,
    nx,
    ny,
    size,
    slotWidth,
    pageAvailW,
    pageAvailH,
    rightClearW,
    color: summary.color,
    style: summary.style
  };
}
function sortSlotsAlongNormal(slots, dir, transform) {
  if (slots.length < 2) return slots;
  const [dx, dy] = unitDisplayDir(dir);
  const nxD = -dy;
  const nyD = dx;
  const tol = Math.max(1, slots[0].size * 0.4);
  return slots.sort((a, b) => {
    const [ax, ay] = apply(transform, a.ox, a.oy);
    const [bx, by] = apply(transform, b.ox, b.oy);
    const na = ax * nxD + ay * nyD;
    const nb = bx * nxD + by * nyD;
    if (Math.abs(na - nb) > tol) return na - nb;
    return ax * dx + ay * dy - (bx * dx + by * dy);
  });
}
function buildRewriteSlots(selectedChars, displayRects, model) {
  const drawn = selectedChars.filter((ch) => ch.c.trim());
  const selectedSet = new Set(selectedChars);
  const summary = summarizeDrawnStyle(drawn);
  const domDir = drawn.length ? unitDisplayDir(drawn[0].lineDir) : [1, 0];
  const lineRects = mergeDisplayLineRects(displayRects, domDir);
  const slots = [];
  for (const lineRect of lineRects) {
    const lineChars = charsInDisplayRect(drawn, lineRect);
    if (!lineChars.length) {
      slots.push(buildEmptyRectSlot(lineRect, drawn.length > 0, summary, model, selectedSet));
      continue;
    }
    const lineDir = unitDisplayDir(lineChars[0].lineDir);
    const thick = rectNormalThickness(lineRect, lineDir);
    const bands = thick > summary.medianSize * 1.8 ? splitCharsIntoLineBands(lineChars, lineDir) : [{ box: lineRect, chars: lineChars }];
    const vertical = Math.abs(lineDir[1]) > Math.abs(lineDir[0]);
    for (const band of bands) {
      const refRect = bands.length === 1 ? lineRect : vertical ? [band.box[0], lineRect[1], band.box[2], lineRect[3]] : [lineRect[0], band.box[1], lineRect[2], band.box[3]];
      slots.push(buildGlyphBandSlot(band, refRect, summary, model, selectedSet));
    }
  }
  return sortSlotsAlongNormal(slots, domDir, model.transform);
}
function sanitizeRewriteText(raw) {
  let text = String(raw == null ? "" : raw);
  text = text.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  text = text.normalize("NFC");
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (SYMBOL_FALLBACK[cp] !== void 0 && cp !== 8727 && cp !== 9826 && cp !== 8594 && cp !== 8592 && cp !== 8596 && cp !== 8658 && cp !== 8712 && cp !== 8713 && cp !== 8810 && cp !== 8811) {
      out += SYMBOL_FALLBACK[cp];
    } else {
      out += ch;
    }
  }
  return out;
}
function normalizeCharForFont(ch, nimbusFont) {
  const cp = ch.codePointAt(0);
  if (isCjkCodePoint(cp)) return { kind: "cjk", text: ch };
  if (winAnsiByte(cp) !== null && nimbusFont.encodeCharacter(cp)) return { kind: "winansi", text: ch };
  if (nimbusFont.encodeCharacter(cp)) return { kind: "cid", text: ch };
  if (SYMBOL_FALLBACK[cp] !== void 0) return { kind: "winansi", text: SYMBOL_FALLBACK[cp] };
  const folded = ch.normalize("NFKD");
  let kept = "";
  for (const part of folded) {
    const pcp = part.codePointAt(0);
    if (pcp >= 768 && pcp <= 879) continue;
    if (nimbusFont.encodeCharacter(pcp)) kept += part;
  }
  if (kept) {
    const allWin = [...kept].every((c) => winAnsiByte(c.codePointAt(0)) !== null);
    return { kind: allWin ? "winansi" : "cid", text: kept };
  }
  return { kind: "winansi", text: "?" };
}
function splitRewriteRuns(lineText, baseName) {
  const nimbusFont = metrics(baseName);
  const koFont = cjkFont();
  const pieces = [];
  let needsCid = false;
  for (const ch of lineText) {
    const item = normalizeCharForFont(ch, nimbusFont);
    if (item.kind === "cid") needsCid = true;
    pieces.push(item);
  }
  const runs = [];
  for (const item of pieces) {
    const kind = item.kind === "cjk" ? "cjk" : needsCid ? "cid" : "winansi";
    const prev = runs[runs.length - 1];
    if (prev && prev.kind === kind) prev.text += item.text;
    else runs.push({ kind, text: item.text, font: kind === "cjk" ? koFont : nimbusFont, baseName });
  }
  return runs;
}
function measureRewriteRun(run, size) {
  let w = 0;
  for (const ch of run.text) {
    const cp = ch.codePointAt(0);
    const gid = run.font.encodeCharacter(cp);
    const adv = gid ? run.font.advanceGlyph(gid, 0) : run.kind === "cjk" ? 1 : 0.5;
    w += (adv > 0 ? adv : run.kind === "cjk" ? 1 : 0.5) * size;
  }
  return w;
}
function measureRewriteLine(lineText, baseName, size) {
  if (!lineText) return 0;
  const runs = splitRewriteRuns(lineText, baseName);
  let total = 0;
  for (const run of runs) total += measureRewriteRun(run, size);
  return total;
}
function wrapRewriteText(text, baseName, size, slotWidths, scaleFactor = 1, overflowWidth = null) {
  const effWidth = (idx) => {
    const raw = idx < slotWidths.length ? slotWidths[idx] : overflowWidth || slotWidths[slotWidths.length - 1] || size * 10;
    return Math.max(size * 0.5, raw / scaleFactor);
  };
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = "";
  for (const word of words) {
    const limit = effWidth(lines.length);
    const trial = current ? `${current} ${word}` : word;
    if (measureRewriteLine(trial, baseName, size) <= limit) {
      current = trial;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    const nextLimit = effWidth(lines.length);
    if (measureRewriteLine(word, baseName, size) <= nextLimit) {
      current = word;
      continue;
    }
    let buf = "";
    for (const ch of word) {
      const next = buf + ch;
      if (buf && measureRewriteLine(next, baseName, size) > effWidth(lines.length)) {
        lines.push(buf);
        buf = ch;
      } else {
        buf = next;
      }
    }
    current = buf;
  }
  if (current) lines.push(current);
  return lines;
}
function ensureNimbusCidFont(doc, page, baseName, cidState) {
  let entry = cidState.get(baseName);
  if (!entry) {
    const font = metrics(baseName);
    const pdfFont = doc.addFont(font);
    entry = { font, pdfFont, mappings: /* @__PURE__ */ new Map() };
    cidState.set(baseName, entry);
  }
  const resources = ownResources(doc, page);
  let fontsDict = resources.get("Font");
  if (fontsDict.isNull()) {
    fontsDict = doc.newDictionary();
    resources.put("Font", fontsDict);
  } else fontsDict = fontsDict.resolve();
  const resKey = "FwCid" + baseName.replace(/[^A-Za-z0-9]/g, "");
  let existing = null;
  fontsDict.forEach((value, key2) => {
    if (existing) return;
    if (String(key2).startsWith(resKey) && value.asIndirect() === entry.pdfFont.asIndirect()) existing = String(key2);
  });
  if (existing) return { resName: existing, entry };
  let name = resKey;
  const taken = /* @__PURE__ */ new Set();
  fontsDict.forEach((_value, key2) => taken.add(String(key2)));
  while (taken.has(name)) name += "x";
  fontsDict.put(name, entry.pdfFont);
  return { resName: name, entry };
}
function finalizeCidFonts(doc, cidState) {
  for (const entry of cidState.values()) {
    if (!entry.mappings.size) continue;
    const entries = [...entry.mappings].map(([gid, ch]) => `<${gid.toString(16).padStart(4, "0")}> ${utf16hex(ch)}`);
    let cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /FwUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      cmap += `${chunk.length} beginbfchar
${chunk.join("\n")}
endbfchar
`;
    }
    cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
    entry.pdfFont.put("ToUnicode", doc.addStream(new TextEncoder().encode(cmap), {}));
  }
}
function emitRewriteLinesOps(doc, page, items, baseName, cidState) {
  const nonEmpty = items.filter((item) => item && item.lineText);
  if (!nonEmpty.length) return "";
  let out = "q BT\n";
  for (const item of nonEmpty) {
    const runs = splitRewriteRuns(item.lineText, baseName);
    const [r, g, b] = item.color || [0, 0, 0];
    let lineFontSize = item.fontSize;
    let lineScale = item.hScale;
    const rawW = measureRewriteLine(item.lineText, baseName, lineFontSize);
    const maxW = item.pageAvailW;
    if (maxW > 0 && rawW * (lineScale / 100) > maxW) {
      const neededScale = Math.floor(maxW / rawW * 1e3) / 10;
      if (neededScale >= 30) {
        lineScale = Math.min(lineScale, neededScale);
      } else {
        lineScale = Math.min(lineScale, 30);
        lineFontSize = Math.max(1, maxW / (rawW * (lineScale / 100)) * lineFontSize);
      }
    }
    out += `${num(r)} ${num(g)} ${num(b)} rg ${num(lineScale)} Tz `;
    out += `${num(item.ux)} ${num(item.uy)} ${num(-item.uy)} ${num(item.ux)} ${num(item.ox)} ${num(item.oy)} Tm `;
    for (const run of runs) {
      if (run.kind === "winansi") {
        const resName = ensureFont(doc, page, baseName);
        const lit = winAnsi(run.text) || winAnsi("?");
        out += `/${resName} ${num(lineFontSize)} Tf ${lit} Tj `;
      } else if (run.kind === "cjk") {
        const resName = ensureCjkFont(doc, page);
        out += `/${resName} ${num(lineFontSize)} Tf ${utf16hex(run.text)} Tj `;
      } else {
        const { resName, entry } = ensureNimbusCidFont(doc, page, baseName, cidState);
        let hex = "";
        for (const ch of run.text) {
          const gid = entry.font.encodeCharacter(ch.codePointAt(0)) || entry.font.encodeCharacter(63);
          if (!entry.mappings.has(gid)) entry.mappings.set(gid, ch);
          hex += gid.toString(16).padStart(4, "0");
        }
        out += `/${resName} ${num(lineFontSize)} Tf <${hex}> Tj `;
      }
    }
    out += "\n";
  }
  return out + "ET Q\n";
}
function buildOverflowItems(lastSlot, extraLines, baseName, fontSize, hScale, leading, overflowWidth) {
  if (!extraLines.length) return [];
  const availH = lastSlot.pageAvailH;
  if (availH > 0 && extraLines.length * leading <= availH) {
    return extraLines.map((lineText, idx) => {
      const step = leading * (idx + 1);
      const ox = lastSlot.ox + lastSlot.nx * step;
      const oy = lastSlot.oy + lastSlot.ny * step;
      let lineScale = hScale;
      const rawW = measureRewriteLine(lineText, baseName, fontSize);
      if (rawW * (lineScale / 100) > overflowWidth && overflowWidth > 0) {
        const needed = overflowWidth / rawW * 100;
        lineScale = Math.max(REWRITE_MIN_SCALE, Math.min(lineScale, Math.round(needed * 10) / 10));
      }
      return {
        ox,
        oy,
        ux: lastSlot.ux,
        uy: lastSlot.uy,
        color: lastSlot.color,
        pageAvailW: lastSlot.pageAvailW,
        lineText,
        fontSize,
        hScale: lineScale
      };
    });
  }
  const safeAvailH = Math.max(0, availH);
  const restText = extraLines.join(" ");
  const restW = Math.max(overflowWidth, lastSlot.pageAvailW);
  let restFontSize = fontSize;
  let restScale = Math.min(hScale, REWRITE_MIN_SCALE);
  let restLeading = Math.min(leading, restFontSize * 1.15);
  let restLines = wrapRewriteText(restText, baseName, restFontSize, [restW], restScale / 100, restW);
  while (restLines.length * restLeading > safeAvailH && restFontSize > 1.5) {
    restFontSize = Math.max(1.5, Math.round(restFontSize * 0.85 * 100) / 100);
    restLeading = Math.min(leading, restFontSize * 1.15);
    restLines = wrapRewriteText(restText, baseName, restFontSize, [restW], restScale / 100, restW);
  }
  if (restLines.length * restLeading > safeAvailH && restLines.length > 0) {
    restLeading = safeAvailH / restLines.length;
    restFontSize = Math.min(restFontSize, Math.max(1, restLeading > 0 ? restLeading * 0.9 : 1.5));
  }
  return restLines.map((lineText, idx) => {
    const step = restLeading * (idx + 1);
    return {
      ox: lastSlot.ox + lastSlot.nx * step,
      oy: lastSlot.oy + lastSlot.ny * step,
      ux: lastSlot.ux,
      uy: lastSlot.uy,
      color: lastSlot.color,
      pageAvailW: lastSlot.pageAvailW,
      lineText,
      fontSize: restFontSize,
      hScale: restScale
    };
  });
}
function singleLineItem(slot, lineText, fontSize, hScale) {
  return {
    ox: slot.ox,
    oy: slot.oy,
    ux: slot.ux,
    uy: slot.uy,
    color: slot.color,
    pageAvailW: slot.pageAvailW,
    lineText,
    fontSize,
    hScale
  };
}
function fitUnbrokenSingleToken(baseSlot, naturalW, baseSize) {
  for (const scale of [65, 50]) {
    const needed = baseSlot.pageAvailW / (naturalW * (scale / 100)) * baseSize;
    if (needed >= 4) return { fontSize: needed, hScale: scale };
  }
  return null;
}
var ADJACENT_PUNCT_RE = /^[,.;:)\]}!?'"”’»›]$/;
function centerNarrowSingleSlot(baseSlot, naturalW, rightSibling) {
  if (!rightSibling || !rightSibling.adjacent || !ADJACENT_PUNCT_RE.test(rightSibling.char)) return baseSlot;
  if (Math.abs(baseSlot.ux - 1) > 0.01 || Math.abs(baseSlot.uy) > 0.01) return baseSlot;
  const totalSpan = rightSibling.origin[0] - baseSlot.ox;
  if (!(totalSpan > naturalW && totalSpan <= baseSlot.slotWidth + baseSlot.size * 0.25)) return baseSlot;
  const slack = totalSpan - naturalW;
  if (!(slack > baseSlot.size * 0.2 && slack < baseSlot.size)) return baseSlot;
  const shift = slack / 2;
  return { ...baseSlot, ox: baseSlot.ox + baseSlot.ux * shift, oy: baseSlot.oy + baseSlot.uy * shift };
}
function emitSingleSlotRewrite(doc, page, baseSlot, text, baseName, cidState, rightSibling = null) {
  const baseSize = baseSlot.size;
  const minSize = Math.max(Math.min(baseSize, 5), baseSize * 0.72);
  const naturalW = measureRewriteLine(text, baseName, baseSize);
  let fontSize = baseSize;
  let hScale = 100;
  let targetSlot = baseSlot;
  if (naturalW > baseSlot.slotWidth && baseSlot.slotWidth > 0) {
    const ratio = baseSlot.slotWidth / naturalW;
    if (ratio >= REWRITE_MIN_SCALE / 100) {
      hScale = Math.round(ratio * 1e3) / 10;
    } else {
      hScale = REWRITE_MIN_SCALE;
      fontSize = Math.max(minSize, baseSlot.slotWidth / (naturalW * (REWRITE_MIN_SCALE / 100)) * baseSize);
    }
  } else {
    targetSlot = centerNarrowSingleSlot(baseSlot, naturalW, rightSibling);
  }
  const renderedW = measureRewriteLine(text, baseName, fontSize) * (hScale / 100);
  if (!(targetSlot.pageAvailW > 0) || renderedW <= targetSlot.pageAvailW) {
    return emitRewriteLinesOps(doc, page, [singleLineItem(targetSlot, text, fontSize, hScale)], baseName, cidState);
  }
  if (!/\s/.test(text.trim())) {
    const fitted = fitUnbrokenSingleToken(baseSlot, naturalW, baseSize);
    if (fitted) {
      return emitRewriteLinesOps(doc, page, [singleLineItem(baseSlot, text, fitted.fontSize, fitted.hScale)], baseName, cidState);
    }
  }
  const wrapW = Math.max(minSize * 2, baseSlot.pageAvailW);
  const wrapped = wrapRewriteText(text, baseName, minSize, [wrapW], REWRITE_MIN_SCALE / 100, wrapW);
  const items = [singleLineItem(baseSlot, wrapped[0], minSize, REWRITE_MIN_SCALE)];
  if (wrapped.length > 1) {
    items.push(...buildOverflowItems(baseSlot, wrapped.slice(1), baseName, minSize, REWRITE_MIN_SCALE, baseSize * 1.2, wrapW));
  }
  return emitRewriteLinesOps(doc, page, items, baseName, cidState);
}
function chooseMultiSlotWrap(text, baseName, baseSize, minSize, slotCount, wrapWidths, overflowWidth) {
  let fontSize = baseSize;
  let hScale = 100;
  let wrapped = wrapRewriteText(text, baseName, fontSize, wrapWidths, 1, overflowWidth);
  if (wrapped.length <= slotCount) return { fontSize, hScale, wrapped };
  const candidates = [
    { size: baseSize, scale: 85 },
    { size: baseSize, scale: 75 },
    { size: baseSize, scale: REWRITE_MIN_SCALE },
    { size: Math.max(Math.min(baseSize, 5), baseSize * 0.85), scale: REWRITE_MIN_SCALE },
    { size: minSize, scale: REWRITE_MIN_SCALE }
  ];
  for (const cand of candidates) {
    const trial = wrapRewriteText(text, baseName, cand.size, wrapWidths, cand.scale / 100, overflowWidth);
    if (trial.length < wrapped.length) {
      fontSize = cand.size;
      hScale = cand.scale;
      wrapped = trial;
    }
    if (wrapped.length <= slotCount) break;
  }
  return { fontSize, hScale, wrapped };
}
function measureSlotLeading(slots, baseSize) {
  const baseSlot = slots[0];
  const steps = [];
  for (let i = 1; i < slots.length; i++) {
    const step = (slots[i].ox - slots[i - 1].ox) * baseSlot.nx + (slots[i].oy - slots[i - 1].oy) * baseSlot.ny;
    if (step > baseSize * 0.5) steps.push(step);
  }
  if (!steps.length) return baseSize * 1.2;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}
function buildInSlotItems(slots, wrapped, wrapWidths, baseName, fontSize, hScale) {
  const items = [];
  const count2 = Math.min(wrapped.length, slots.length);
  for (let i = 0; i < count2; i++) {
    const lineText = wrapped[i];
    if (!lineText) continue;
    const targetW = wrapWidths[i];
    let lineScale = hScale;
    const rawW = measureRewriteLine(lineText, baseName, fontSize);
    if (rawW * (lineScale / 100) > targetW && targetW > 0) {
      const needed = targetW / rawW * 100;
      lineScale = Math.max(REWRITE_MIN_SCALE, Math.min(lineScale, Math.round(needed * 10) / 10));
    }
    items.push(singleLineItem(slots[i], lineText, fontSize, lineScale));
  }
  return items;
}
function emitMultiSlotRewrite(doc, page, slots, text, baseName, cidState) {
  const baseSize = slots[0].size;
  const minSize = Math.max(Math.min(baseSize, 5), baseSize * 0.72);
  const baseWidths = slots.map((s) => Math.max(baseSize, s.slotWidth));
  const lastSlot = slots[slots.length - 1];
  const blockW = Math.max(...baseWidths);
  const overflowWidth = Math.max(baseSize, lastSlot.pageAvailW > 0 ? Math.min(lastSlot.pageAvailW, blockW) : blockW);
  const wrapWidths = [...baseWidths];
  if (lastSlot.rightClearW > wrapWidths[wrapWidths.length - 1]) {
    wrapWidths[wrapWidths.length - 1] = Math.min(lastSlot.rightClearW, overflowWidth);
  }
  const { fontSize, hScale, wrapped } = chooseMultiSlotWrap(text, baseName, baseSize, minSize, slots.length, wrapWidths, overflowWidth);
  const leading = measureSlotLeading(slots, baseSize);
  const items = buildInSlotItems(slots, wrapped, wrapWidths, baseName, fontSize, hScale);
  if (wrapped.length > slots.length) {
    items.push(...buildOverflowItems(lastSlot, wrapped.slice(slots.length), baseName, fontSize, hScale, leading, overflowWidth));
  }
  return emitRewriteLinesOps(doc, page, items, baseName, cidState);
}
function emitRewriteEdit(doc, page, slots, rawNewText, cidState, rightOrigin = null) {
  const sanitized = sanitizeRewriteText(rawNewText);
  const text = sanitized.replace(/^\n+|\n+$/g, "").replace(/[ ]*\n+[ ]*/g, " ");
  if (!text.trim() || !slots.length) return "";
  const baseName = base14FromStyle(slots[0].style);
  if (slots.length === 1) return emitSingleSlotRewrite(doc, page, slots[0], text, baseName, cidState, rightOrigin);
  return emitMultiSlotRewrite(doc, page, slots, text, baseName, cidState);
}
function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input?.bytes instanceof Uint8Array) return input.bytes;
  throw unavailableError(new TypeError("sourceBytes must be a Uint8Array"));
}
function openRewriteDoc(bytes) {
  const head = String.fromCharCode(...bytes.slice(0, Math.min(1024, bytes.byteLength)));
  if (bytes.byteLength < 5 || !head.includes("%PDF-")) throw unavailableError(new Error("not a PDF"));
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  if (!doc) throw unavailableError(new Error("not a PDF"));
  if (doc.needsPassword()) {
    try {
      doc.authenticatePassword("");
    } catch {
    }
  }
  return doc;
}
function groupRewriteEditsByPage(edits, pageCount) {
  const byPage = /* @__PURE__ */ new Map();
  for (const edit of Array.isArray(edits) ? edits : []) {
    if (!edit || typeof edit !== "object") continue;
    const pageIndex = edit.pageIndex;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) continue;
    if (!Array.isArray(edit.rects) || !edit.rects.length) continue;
    let group = byPage.get(pageIndex);
    if (!group) {
      group = [];
      byPage.set(pageIndex, group);
    }
    group.push(edit);
  }
  return byPage;
}
function isIdentityMatrix(m) {
  const id = [1, 0, 0, 1, 0, 0];
  return Array.isArray(m) && m.length === 6 && m.every((v, i) => Math.abs(v - id[i]) < 1e-3);
}
function restoreTextStateOps(show, matrix = show.lineMatrix) {
  const tm = matrix.map(num).join(" ");
  return `BT /${show.fontName} ${num(show.fontSize)} Tf ${num(show.hScale)} Tz ${num(show.charSpace)} Tc ${num(show.wordSpace)} Tw ${num(show.rise)} Ts ${show.renderMode} Tr ${num(show.leading)} TL ${tm} Tm `;
}
var SPLICE_SAFE_NEXT_OPS = /* @__PURE__ */ new Set(["Tm", "Td", "TD", "T*", "ET"]);
var SPLICE_SKIP_OPS = /* @__PURE__ */ new Set(["g", "G", "rg", "RG", "k", "K", "sc", "SC", "scn", "SCN", "cs", "CS", "Tf", "Tc", "Tw", "Tz", "Ts", "Tr", "TL"]);
function nextOpAllowsSplice(latin1, offset) {
  const tail = latin1.slice(offset, offset + 256).replace(/%[^\r\n]*/g, " ");
  const tokens = tail.match(/\/[^\s()<>[\]{}/%]+|[+-]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*'"]+|[\[\]()<>]/g) || [];
  for (const tok of tokens) {
    if (tok[0] === "/" || /^[+-]?(?:\d|\.)/.test(tok)) continue;
    if (SPLICE_SKIP_OPS.has(tok)) continue;
    return SPLICE_SAFE_NEXT_OPS.has(tok);
  }
  return false;
}
function readMissingWidth(fontObj) {
  const desc = fontObj.get("FontDescriptor");
  if (desc.isNull()) return NaN;
  const missObj = desc.resolve().get("MissingWidth");
  return !missObj.isNull() && missObj.isNumber() ? missObj.asNumber() : NaN;
}
function readSimpleFontWidths(fontObj) {
  const widthsObj = fontObj.get("Widths");
  const firstObj = fontObj.get("FirstChar");
  if (widthsObj.isNull() || !widthsObj.isArray() || firstObj.isNull() || !firstObj.isNumber()) return null;
  const widths = [];
  for (let i = 0; i < widthsObj.length; i++) {
    const item = widthsObj.get(i);
    widths.push(item.isNumber() ? item.asNumber() : NaN);
  }
  return { kind: "widths", firstChar: firstObj.asNumber(), widths, missingWidth: readMissingWidth(fontObj) };
}
function loadFontWidthEntry(fontDict, fontName) {
  const raw = fontDict.get(fontName);
  if (!raw || raw.isNull()) return null;
  const fontObj = raw.resolve();
  const simple = readSimpleFontWidths(fontObj);
  if (simple) return simple;
  const baseObj = fontObj.get("BaseFont");
  const bare = baseObj.isNull() ? "" : String(baseObj.asName() || "").replace(/^[A-Z]{6}\+/, "");
  return BASE14.includes(bare) ? { kind: "base14", font: metrics(bare) } : null;
}
function makePageFontMeasurer(page) {
  const resources = page.getObject().getInheritable("Resources");
  const fontDict = !resources.isNull() ? resources.resolve().get("Font") : null;
  const resolvedDict = fontDict && !fontDict.isNull() ? fontDict.resolve() : null;
  const cache = /* @__PURE__ */ new Map();
  return (fontName, bytes, state) => {
    if (!resolvedDict || !fontName) return NaN;
    if (!cache.has(fontName)) cache.set(fontName, loadFontWidthEntry(resolvedDict, fontName));
    const info = cache.get(fontName);
    if (!info) return NaN;
    let adv = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      let w;
      if (info.kind === "widths") {
        const idx = b - info.firstChar;
        const rawW = idx >= 0 && idx < info.widths.length ? info.widths[idx] : info.missingWidth;
        w = rawW / 1e3 * state.fontSize;
      } else {
        const gid = info.font.encodeCharacter(b);
        w = gid ? info.font.advanceGlyph(gid, 0) * state.fontSize : NaN;
      }
      if (!Number.isFinite(w)) return NaN;
      adv += w + state.charSpace + (b === 32 ? state.wordSpace : 0);
    }
    return adv;
  };
}
function showXSpan(show, measure2) {
  let x = show.textMatrix[4];
  let firstInk = null;
  const scaleX = show.textMatrix[0] * (show.hScale / 100);
  for (const part of show.parts || []) {
    if (part.type === "adjustment") {
      x -= part.value / 1e3 * show.fontSize * scaleX;
      continue;
    }
    if (firstInk === null) firstInk = x;
    const w = measure2(show.fontName, part.bytes, show);
    if (!Number.isFinite(w)) return { startX: firstInk, endX: NaN };
    x += w * scaleX;
  }
  return { startX: firstInk === null ? show.textMatrix[4] : firstInk, endX: x };
}
function findInlineSpliceTarget(shows, latin1, slot, leftSibling, measure2) {
  if (!leftSibling || Math.abs(slot.ux - 1) > 0.01 || Math.abs(slot.uy) > 0.01) return null;
  const leftX = leftSibling.pdfOrigin[0];
  const leftY = leftSibling.pdfOrigin[1];
  let best = null;
  for (const show of shows) {
    if (!show.fontName || !isIdentityMatrix(show.ctm)) continue;
    const sy = show.textMatrix[5] + show.rise * show.textMatrix[3];
    if (Math.abs(sy - leftY) > 1.5) continue;
    const { startX, endX } = showXSpan(show, measure2);
    if (startX > leftX + 1.5) continue;
    if (Number.isFinite(endX) && endX < leftX - 1.5) continue;
    if (!nextOpAllowsSplice(latin1, show.end)) continue;
    if (!best || startX >= best.startX) best = { show, startX };
  }
  return best ? best.show : null;
}
function pageContentStreams(page) {
  const contents = page.getObject().get("Contents");
  if (contents.isNull()) return [];
  const out = [];
  const count2 = contents.isArray() ? contents.length : 1;
  for (let i = 0; i < count2; i++) {
    const ref = contents.isArray() ? contents.get(i) : contents;
    if (ref.isStream()) out.push(ref);
  }
  return out;
}
function readStreamLatin1(streamObj) {
  const buf = streamObj.readStream();
  try {
    const u8 = buf.asUint8Array();
    let out = "";
    for (let i = 0; i < u8.length; i += 8192) {
      out += String.fromCharCode(...u8.subarray(i, i + 8192));
    }
    return { bytes: u8.slice(), latin1: out };
  } finally {
    buf.destroy();
  }
}
function writeStreamLatin1(streamObj, latin1) {
  const out = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) out[i] = latin1.charCodeAt(i) & 255;
  streamObj.writeStream(out);
}
function horizontalEditDrawn(selectedChars, slot) {
  if (!slot || Math.abs(slot.ux - 1) > 0.01 || Math.abs(slot.uy) > 0.01) return null;
  const drawn = selectedChars.filter((ch) => ch.c.trim());
  return drawn.length ? drawn : null;
}
function survivingCharsOnLine(allChars, lineId, allSelectedSet) {
  return allChars.filter((ch) => ch.lineId === lineId && !allSelectedSet.has(ch) && ch.c.trim());
}
function rightmostBeforeX(chars, maxX) {
  let best = null;
  for (const ch of chars) {
    if (ch.pdfOrigin[0] < maxX && (!best || ch.pdfOrigin[0] > best.pdfOrigin[0])) best = ch;
  }
  return best;
}
function leftmostAfterX(chars, minX) {
  let best = null;
  for (const ch of chars) {
    if (ch.pdfOrigin[0] > minX && (!best || ch.pdfOrigin[0] < best.pdfOrigin[0])) best = ch;
  }
  return best;
}
function isAdjacentChars(allChars, firstCh, nextCh) {
  const firstIdx = allChars.indexOf(firstCh);
  const nextIdx = allChars.indexOf(nextCh);
  if (firstIdx < 0 || nextIdx <= firstIdx) return false;
  for (let i = firstIdx + 1; i < nextIdx; i++) {
    if (!allChars[i].c.trim()) return false;
  }
  return true;
}
function findLeftSibling(selectedChars, allChars, allSelectedSet, slot) {
  const drawn = horizontalEditDrawn(selectedChars, slot);
  if (!drawn) return null;
  const lineId = drawn[0].lineId;
  const sameLine = survivingCharsOnLine(allChars, lineId, allSelectedSet);
  if (sameLine.length) return rightmostBeforeX(sameLine, slot.ox - 0.5);
  const prevLine = survivingCharsOnLine(allChars, lineId - 1, allSelectedSet).filter((ch) => Math.abs(ch.pdfOrigin[1] - slot.oy) <= 1.5);
  return rightmostBeforeX(prevLine, slot.ox - 0.5);
}
function findRightSibling(selectedChars, allChars, allSelectedSet, slot) {
  const drawn = horizontalEditDrawn(selectedChars, slot);
  if (!drawn) return null;
  const lineId = drawn[0].lineId;
  if (drawn.some((ch) => ch.lineId !== lineId)) return null;
  const lastDrawn = drawn.reduce((a, b) => b.pdfOrigin[0] > a.pdfOrigin[0] ? b : a);
  const best = leftmostAfterX(survivingCharsOnLine(allChars, lineId, allSelectedSet), lastDrawn.pdfOrigin[0] + 0.5);
  if (!best) return null;
  return { origin: best.pdfOrigin, char: best.c, adjacent: isAdjacentChars(allChars, lastDrawn, best) };
}
function tjHoleMatches(part, idx, len, x, nextX, slot, rightOrigin) {
  if (idx <= 0 || idx >= len - 1 || part.value >= 0) return false;
  return x <= slot.ox + 2 && nextX >= slot.ox - 2 && Math.abs(nextX - rightOrigin[0]) <= 2.5;
}
function findTjHolePart(show, slot, rightOrigin, measure2) {
  if (show.kind !== "TJ" || !rightOrigin || Math.abs(show.rise) > 0.01) return null;
  if (!Array.isArray(show.parts) || show.parts.length < 3) return null;
  const scaleX = show.textMatrix[0] * (show.hScale / 100);
  let x = show.textMatrix[4];
  const matches = [];
  for (let i = 0; i < show.parts.length; i++) {
    const part = show.parts[i];
    if (part.type === "string") {
      const w = measure2(show.fontName, part.bytes, show);
      if (!Number.isFinite(w)) return null;
      x += w * scaleX;
      continue;
    }
    const nextX = x - part.value / 1e3 * show.fontSize * scaleX;
    if (tjHoleMatches(part, i, show.parts.length, x, nextX, slot, rightOrigin)) matches.push(part);
    x = nextX;
  }
  return matches.length === 1 ? matches[0] : null;
}
function buildShowSplicePiece(latin1, show, holeEdits, postEdits) {
  const lm = show.lineMatrix.map(num).join(" ");
  if (!holeEdits.length) {
    const ops = postEdits.map((it) => it.ops).join("");
    return { start: show.end, end: show.end, piece: ` ET
${ops}${restoreTextStateOps(show)}` };
  }
  holeEdits.sort((a, b) => a.holePart.start - b.holePart.start);
  let piece = latin1.slice(show.start, holeEdits[0].holePart.start) + "]TJ";
  for (let i = 0; i < holeEdits.length; i++) {
    const cur = holeEdits[i];
    const rightOrigin = cur.item.rightSibling.origin;
    const rightTm = [show.textMatrix[0], show.textMatrix[1], show.textMatrix[2], show.textMatrix[3], rightOrigin[0], rightOrigin[1]];
    const nextEnd = i + 1 < holeEdits.length ? holeEdits[i + 1].holePart.start : show.end;
    const seg = "[" + latin1.slice(cur.holePart.end, nextEnd) + (i + 1 < holeEdits.length ? "]TJ" : "");
    piece += ` ET
${cur.item.ops}${restoreTextStateOps(show, rightTm)}${seg}`;
  }
  piece += ` ${lm} Tm `;
  if (postEdits.length) {
    piece += `ET
${postEdits.map((it) => it.ops).join("")}${restoreTextStateOps(show)}`;
  }
  return { start: show.start, end: show.end, piece };
}
function assignItemToShow(scanned, item, measure2) {
  const firstSlot = item.slots[0];
  if (!firstSlot || !item.leftSibling) return null;
  for (const entry of scanned) {
    if (entry.parsed.diagnostics.length) continue;
    const show = findInlineSpliceTarget(entry.parsed.shows, entry.latin1, firstSlot, item.leftSibling, measure2);
    if (show) return { entry, show };
  }
  return null;
}
function spliceRewriteOpsInline(page, emittedPlans) {
  const streams = pageContentStreams(page);
  if (!streams.length) return emittedPlans.map((p) => p.ops).join("");
  const measure2 = makePageFontMeasurer(page);
  const scanned = streams.map((streamObj) => {
    const { bytes, latin1 } = readStreamLatin1(streamObj);
    const parsed = scanTextShows(bytes, { measure: measure2 });
    return { streamObj, latin1, parsed, byShow: /* @__PURE__ */ new Map() };
  });
  let fallbackOps = "";
  for (const item of emittedPlans) {
    const match = assignItemToShow(scanned, item, measure2);
    if (!match) {
      fallbackOps += item.ops;
      continue;
    }
    let bucket = match.entry.byShow.get(match.show);
    if (!bucket) {
      bucket = { holes: [], usedParts: /* @__PURE__ */ new Set(), post: [] };
      match.entry.byShow.set(match.show, bucket);
    }
    const rightOrigin = item.rightSibling ? item.rightSibling.origin : null;
    const holePart = findTjHolePart(match.show, item.slots[0], rightOrigin, measure2);
    if (holePart && !bucket.usedParts.has(holePart)) {
      bucket.usedParts.add(holePart);
      bucket.holes.push({ holePart, item });
    } else {
      bucket.post.push(item);
    }
  }
  for (const entry of scanned) {
    if (!entry.byShow.size) continue;
    const splices = [];
    for (const [show, bucket] of entry.byShow) {
      splices.push(buildShowSplicePiece(entry.latin1, show, bucket.holes, bucket.post));
    }
    splices.sort((a, b) => b.start - a.start);
    let next = entry.latin1;
    for (const sp of splices) {
      next = next.slice(0, sp.start) + sp.piece + next.slice(sp.end);
    }
    writeStreamLatin1(entry.streamObj, next);
  }
  return fallbackOps;
}
function dedupeRewritePlans(pagePlans, model) {
  const claimed = /* @__PURE__ */ new Set();
  const kept = [];
  for (let i = pagePlans.length - 1; i >= 0; i--) {
    const plan = pagePlans[i];
    const hadDrawn = plan.selectedChars.some((ch) => ch.c.trim());
    const remaining = plan.selectedChars.filter((ch) => !claimed.has(ch));
    const hasDrawn = remaining.some((ch) => ch.c.trim());
    if (hadDrawn && !hasDrawn) continue;
    for (const ch of remaining) claimed.add(ch);
    if (remaining.length !== plan.selectedChars.length) {
      const slotRects = plan.aligned ? alignedDisplayRects(remaining) : plan.displayRects;
      plan.selectedChars = remaining;
      plan.slots = buildRewriteSlots(remaining, slotRects.length ? slotRects : plan.displayRects, model);
    }
    kept.push(plan);
  }
  return kept.reverse();
}
function applyRewritePage(doc, pageIndex, pageEdits, cidState) {
  const page = doc.loadPage(pageIndex);
  try {
    const model = readRewritePage(page);
    const rawPlans = [];
    for (const edit of pageEdits) {
      const displayRects = rectsToDisplay(edit.rects, model.bounds);
      if (!displayRects.length) continue;
      const rectSelected = selectGlyphsByRects(model.chars, displayRects);
      const alignedRes = alignGlyphsToOriginalText(model.chars, rectSelected, displayRects, edit.originalText);
      const trimmed = alignedRes.aligned ? trimUnchangedSymbolEdges(alignedRes.chars, edit.newText) : { chars: alignedRes.chars, text: edit.newText };
      const slotRects = alignedRes.aligned ? alignedDisplayRects(trimmed.chars) : displayRects;
      const slots = buildRewriteSlots(trimmed.chars, slotRects.length ? slotRects : displayRects, model);
      rawPlans.push({ edit, displayRects, selectedChars: trimmed.chars, newText: trimmed.text, slots, aligned: alignedRes.aligned });
    }
    const pagePlans = dedupeRewritePlans(rawPlans, model);
    if (!pagePlans.length) return;
    redactRewritePage(page, pagePlans, model.chars);
    const allSelectedSet = /* @__PURE__ */ new Set();
    for (const plan of pagePlans) {
      for (const ch of plan.selectedChars) allSelectedSet.add(ch);
    }
    const emitted = [];
    for (const plan of pagePlans) {
      const leftSibling = findLeftSibling(plan.selectedChars, model.chars, allSelectedSet, plan.slots[0]);
      const rightSibling = findRightSibling(plan.selectedChars, model.chars, allSelectedSet, plan.slots[0]);
      const ops = emitRewriteEdit(doc, page, plan.slots, plan.newText, cidState, rightSibling);
      if (ops) emitted.push({ slots: plan.slots, ops, leftSibling, rightSibling });
    }
    if (!emitted.length) return;
    const fallbackOps = spliceRewriteOpsInline(page, emitted);
    if (fallbackOps) appendStream(doc, page, fallbackOps);
  } finally {
    try {
      page.destroy();
    } catch {
    }
  }
}
function saveRewriteDoc(doc) {
  const saved = doc.saveToBuffer("garbage=compact");
  try {
    return saved.asUint8Array().slice();
  } finally {
    try {
      saved.destroy();
    } catch {
    }
  }
}
async function rewriteExclusive(sourceBytes, edits) {
  let doc = null;
  try {
    const bytes = toUint8Array(sourceBytes);
    doc = openRewriteDoc(bytes);
    const byPage = groupRewriteEditsByPage(edits, doc.countPages());
    if (!byPage.size) return bytes.slice();
    const cidState = /* @__PURE__ */ new Map();
    for (const [pageIndex, pageEdits] of byPage) {
      applyRewritePage(doc, pageIndex, pageEdits, cidState);
    }
    finalizeCidFonts(doc, cidState);
    return saveRewriteDoc(doc);
  } catch (error2) {
    if (error2 instanceof BrowserPdfError && error2.code === "engine_unavailable") throw error2;
    throw unavailableError(error2);
  } finally {
    try {
      doc?.destroy();
    } catch {
    }
  }
}
async function rewrite(sourceBytes, edits) {
  return exclusive(() => rewriteExclusive(sourceBytes, edits));
}
globalThis.FalsifyBrowserPdf = { prepare, rewrite, warm, ENGINE, LIMITS, COORDINATE_SPACE, COORDINATES, BrowserPdfError };
export {
  BrowserPdfError,
  COORDINATES,
  COORDINATE_SPACE,
  ENGINE,
  LIMITS,
  prepare,
  rewrite,
  warm
};
