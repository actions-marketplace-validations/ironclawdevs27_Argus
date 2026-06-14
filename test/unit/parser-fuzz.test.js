/**
 * HARNESS_MAX_PLAN Phase 4.2 — parser fuzzing (Vitest + fast-check, Chrome-free).
 *
 * Property-based tests for the eight markdown/text parsers that sit on the
 * chrome-devtools-mcp wire boundary and the git-log/finding key helpers. These
 * are the functions that turn untrusted, possibly-truncated upstream text into
 * the structured shapes the rest of the pipeline trusts — exactly the surface
 * the 2026-06-12 audit found could silently degrade.
 *
 * Each property encodes the function's REAL contract (read from source, not
 * memory), so the assertions are honest rather than aspirational:
 *   - the three list-parsers + normalizeArray + unwrapEval never throw and
 *     return their contracted type for ANY input;
 *   - extractResponseBody throws ONLY SyntaxError (by design, on a malformed
 *     JSON body section) — never a TypeError/ReferenceError;
 *   - getRecentChanges never throws for arbitrary dir/commits and always
 *     returns an array (the git call is wrapped in try/catch → []);
 *   - findingKey is total + idempotent over its createFinding string-message
 *     invariant (it intentionally throws on a non-string message — that is not
 *     fuzzed because production findings always carry a string message).
 *
 * Round-trip properties feed well-formed synthetic input through the parser and
 * assert the structured output reconstructs the inputs. Chrome-free by design:
 * runs in seconds, on every change.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  parseConsoleMsgResponse,
  parseNetworkReqResponse,
  parseListPagesResponse,
} from '../../src/utils/mcp-parsers.js';
import { normalizeArray } from '../../src/utils/flow-runner.js';
import { unwrapEval } from '../../src/utils/mcp-client.js';
import { extractResponseBody } from '../../src/utils/contract-validator.js';
import { getRecentChanges } from '../../src/utils/root-cause-linker.js';
import { findingKey } from '../../src/utils/flakiness-detector.js';

const RUNS = { numRuns: 300 };

// ── Synthetic generators for well-formed wire text ──────────────────────────
// URL token: any run of non-whitespace chars the regexes treat as \S+ (no '[').
const URL_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/.?=&-_~%';
const urlToken = fc
  .array(fc.constantFrom(...URL_CHARS.split('')), { minLength: 1, maxLength: 40 })
  .map((a) => a.join(''));

// Console message text: printable, no newlines and no '[]()' so the
// "(N args)" suffix and the "[level]" delimiter can't be forged inside it.
const TEXT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?-_/@#';
const lineText = fc
  .array(fc.constantFrom(...TEXT_CHARS.split('')), { minLength: 1, maxLength: 40 })
  .map((a) => a.join('').replace(/\s+/g, ' ').trim())
  .filter((t) => t.length > 0);

// ─────────────────────────────────────────────────────────────────────────────
describe('parser fuzzing — parseConsoleMsgResponse', () => {
  it('always returns an array and never throws (fc.anything)', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(Array.isArray(parseConsoleMsgResponse(raw))).toBe(true);
      }),
      RUNS,
    );
  });

  it('round-trips well-formed "msgid=N [level] text" lines', () => {
    const entry = fc.record({
      id: fc.nat({ max: 1e6 }),
      level: fc.constantFrom('error', 'warn', 'warning', 'info', 'log', 'debug', 'ERROR', 'Warn', 'INFO'),
      text: lineText,
    });
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 8 }), (entries) => {
        const raw = entries.map((e) => `msgid=${e.id} [${e.level}] ${e.text}`).join('\n');
        const parsed = parseConsoleMsgResponse(raw);
        expect(parsed).toHaveLength(entries.length);
        parsed.forEach((p, i) => {
          const e = entries[i];
          const expectedLevel = e.level === 'warn' ? 'warning' : e.level.toLowerCase();
          expect(p._msgid).toBe(e.id);
          expect(p.level).toBe(expectedLevel);
          expect(p.text).toBe(e.text);
          expect(p.message).toBe(e.text);
        });
      }),
      RUNS,
    );
  });

  it('returns [] for falsy and non-string scalars', () => {
    for (const v of [undefined, null, 0, '', false, 42, true]) {
      expect(parseConsoleMsgResponse(v)).toEqual([]);
    }
  });
});

describe('parser fuzzing — parseNetworkReqResponse', () => {
  it('always returns an array and never throws (fc.anything)', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(Array.isArray(parseNetworkReqResponse(raw))).toBe(true);
      }),
      RUNS,
    );
  });

  it('round-trips well-formed "reqid=N METHOD URL [STATUS]" lines', () => {
    const entry = fc.record({
      id: fc.nat({ max: 1e6 }),
      method: fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'),
      url: urlToken,
      status: fc.integer({ min: 100, max: 599 }),
    });
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 8 }), (entries) => {
        const raw = entries.map((e) => `reqid=${e.id} ${e.method} ${e.url} [${e.status}]`).join('\n');
        const parsed = parseNetworkReqResponse(raw);
        expect(parsed).toHaveLength(entries.length);
        parsed.forEach((p, i) => {
          const e = entries[i];
          expect(p._reqid).toBe(e.id);
          expect(p.requestId).toBe(e.id);
          expect(p.method).toBe(e.method);
          expect(p.url).toBe(e.url);
          expect(p.status).toBe(e.status);
          expect(p.statusCode).toBe(e.status);
        });
      }),
      RUNS,
    );
  });
});

describe('parser fuzzing — parseListPagesResponse', () => {
  it('always returns an array and never throws (fc.anything)', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(Array.isArray(parseListPagesResponse(raw))).toBe(true);
      }),
      RUNS,
    );
  });

  it('round-trips "N: url [selected]" lines with numeric ids', () => {
    const entry = fc.record({
      id: fc.nat({ max: 1e6 }),
      url: urlToken,
      selected: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 8 }), (entries) => {
        const raw = entries
          .map((e) => `${e.id}: ${e.url}${e.selected ? ' [selected]' : ''}`)
          .join('\n');
        const parsed = parseListPagesResponse(raw);
        expect(parsed).toHaveLength(entries.length);
        parsed.forEach((p, i) => {
          expect(typeof p.id).toBe('number');
          expect(p.id).toBe(entries[i].id);
          expect(p.url).toBe(entries[i].url);
          expect(p.selected).toBe(entries[i].selected);
        });
      }),
      RUNS,
    );
  });
});

describe('parser fuzzing — normalizeArray', () => {
  it('always returns an array and never throws (fc.anything)', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(Array.isArray(normalizeArray(raw))).toBe(true);
      }),
      RUNS,
    );
  });

  it('extracts .messages / .requests / .result arrays by precedence', () => {
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 5 }), (arr) => {
        expect(normalizeArray({ messages: arr })).toBe(arr);
        expect(normalizeArray({ requests: arr })).toBe(arr);
        expect(normalizeArray({ result: arr })).toBe(arr);
        expect(normalizeArray(arr)).toBe(arr);
        // .messages wins over .requests/.result (declaration order in source)
        expect(normalizeArray({ messages: arr, requests: [], result: [] })).toBe(arr);
      }),
      RUNS,
    );
  });
});

describe('parser fuzzing — unwrapEval', () => {
  it('never throws (fc.anything)', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        unwrapEval(raw); // must not throw for any input
      }),
      RUNS,
    );
  });

  it('null/undefined → null; primitives + arrays are identity', () => {
    expect(unwrapEval(null)).toBe(null);
    expect(unwrapEval(undefined)).toBe(null);
    const prim = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.double({ noNaN: true }));
    fc.assert(
      fc.property(prim, (p) => {
        expect(unwrapEval(p)).toBe(p);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 5 }), (arr) => {
        expect(unwrapEval(arr)).toBe(arr); // same reference — arrays are not unwrapped
      }),
      RUNS,
    );
  });

  it('unwraps { result } when result is defined, else returns the object', () => {
    const defined = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.array(fc.integer(), { maxLength: 3 }));
    fc.assert(
      fc.property(defined, (v) => {
        expect(unwrapEval({ result: v })).toBe(v);
      }),
      RUNS,
    );
    // result null/undefined falls through to the object itself (?? raw)
    const obj1 = { result: null, extra: 1 };
    expect(unwrapEval(obj1)).toBe(obj1);
    const obj2 = { noResultKey: 7 };
    expect(unwrapEval(obj2)).toBe(obj2);
  });
});

describe('parser fuzzing — extractResponseBody', () => {
  it('throws ONLY SyntaxError, never a Type/ReferenceError (fc.anything)', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        try {
          extractResponseBody(raw);
        } catch (e) {
          // By contract it may throw on a malformed-JSON body section — but the
          // thrown error must always be a SyntaxError (JSON.parse), never the
          // masked-error class the audit cared about.
          expect(e).toBeInstanceOf(SyntaxError);
        }
      }),
      RUNS,
    );
  });

  it('returns null for any string without a "### Response Body" section', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!s.includes('### Response Body'));
        expect(extractResponseBody(s)).toBe(null);
      }),
      RUNS,
    );
  });

  it('round-trips a valid JSON body embedded in markdown', () => {
    const jsonish = fc.oneof(
      fc.integer(),
      fc.boolean(),
      fc.array(fc.integer(), { maxLength: 5 }),
      fc.record({ a: fc.integer(), b: fc.string({ maxLength: 10 }), c: fc.boolean() }),
    );
    fc.assert(
      fc.property(jsonish, (value) => {
        const md = `### Request\nGET /x\n\n### Response Body\n${JSON.stringify(value)}\n\n### Response Headers\nx: y\n`;
        expect(extractResponseBody(md)).toEqual(value);
      }),
      RUNS,
    );
  });

  it('reads responseBody / body off structured objects', () => {
    expect(extractResponseBody({ responseBody: '{"ok":true}' })).toEqual({ ok: true });
    expect(extractResponseBody({ body: '[1,2,3]' })).toEqual([1, 2, 3]);
    expect(extractResponseBody({})).toBe(null);
    expect(extractResponseBody(null)).toBe(null);
  });
});

describe('parser fuzzing — getRecentChanges', () => {
  it('never throws and always returns an array for arbitrary dir/commits', () => {
    const commitsArb = fc.oneof(
      fc.integer(),
      fc.string(),
      fc.constant(undefined),
      fc.constant(null),
      fc.double({ noNaN: false }),
    );
    fc.assert(
      fc.property(fc.string(), commitsArb, (dir, commits) => {
        const r = getRecentChanges(dir, { commits });
        expect(Array.isArray(r)).toBe(true);
      }),
      // git spawns are slow; keep the run count modest for this one.
      { numRuns: 40 },
    );
  });

  it('round-trips the real repo: ≥1 change with { hash, subject, files } shape', () => {
    const changes = getRecentChanges(process.cwd(), { commits: 5 });
    expect(Array.isArray(changes)).toBe(true);
    expect(changes.length).toBeGreaterThanOrEqual(1);
    for (const c of changes) {
      expect(typeof c.hash).toBe('string');
      expect(c.hash.length).toBeGreaterThan(0);
      expect(c.hash.includes('\t')).toBe(false); // hash is split off the tab-delimited line
      expect(typeof c.subject).toBe('string');
      expect(Array.isArray(c.files)).toBe(true);
      for (const f of c.files) expect(typeof f).toBe('string');
    }
  });
});

describe('parser fuzzing — findingKey', () => {
  // Fuzzed within the createFinding invariant: message is always a string.
  const findingArb = fc.record({
    type: fc.string(),
    message: fc.string(),
    status: fc.option(fc.oneof(fc.integer(), fc.string()), { nil: undefined }),
  });

  it('always returns a string beginning with "type::"', () => {
    fc.assert(
      fc.property(findingArb, (f) => {
        const key = findingKey(f);
        expect(typeof key).toBe('string');
        expect(key.startsWith(`${f.type}::`)).toBe(true);
      }),
      RUNS,
    );
  });

  it('message normalization (trim + collapse whitespace) is idempotent', () => {
    fc.assert(
      fc.property(findingArb, (f) => {
        const normalized = { ...f, message: f.message.replace(/\s+/g, ' ').trim() };
        expect(findingKey(f)).toBe(findingKey(normalized));
        // leading/trailing whitespace never changes the key
        const padded = { ...f, message: `  \t${f.message}\n  ` };
        expect(findingKey(f)).toBe(findingKey(padded));
      }),
      RUNS,
    );
  });

  it('caps the message segment at 100 characters', () => {
    fc.assert(
      fc.property(fc.nat({ max: 400 }), (n) => {
        const key = findingKey({ type: '', message: 'x'.repeat(n) });
        expect(key).toBe('::' + 'x'.repeat(Math.min(n, 100)));
      }),
      RUNS,
    );
  });

  it('appends ::status only when status is non-null', () => {
    expect(findingKey({ type: 't', message: 'm', status: 404 })).toBe('t::m::404');
    expect(findingKey({ type: 't', message: 'm', status: null })).toBe('t::m');
    expect(findingKey({ type: 't', message: 'm' })).toBe('t::m');
  });
});
