import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PollingRecorder, CdpScreenRecorder } from '../../src/utils/screen-recorder.js';

// ws is an optional peer dependency (not in package.json). Detect it so the
// ws-missing test stays correct if someone installs ws locally.
async function canResolve(spec) {
  try { await import(spec); return true; } catch { return false; }
}
const WS_PRESENT = await canResolve('ws');

const TMP_DIR = path.join(os.tmpdir(), `argus-screenrec-${process.pid}`);

afterEach(() => {
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// A mock CdpBrowserAdapter that returns a data-URL JPEG frame from screenshot().
function mockBrowser(payload) {
  return { screenshot: async () => payload };
}
const FRAME_B64 = Buffer.from('fakeframe').toString('base64');
const DATA_URL  = `data:image/jpeg;base64,${FRAME_B64}`;

describe('PollingRecorder', () => {
  it('captures frames via browser.screenshot() and writes them decoded to disk', async () => {
    const out = path.join(TMP_DIR, 'capture');
    const rec = new PollingRecorder(mockBrowser(DATA_URL), { intervalMs: 10, quality: 60 });
    rec.start();
    await new Promise(r => setTimeout(r, 55));      // ~5 intervals
    const result = await rec.stop(out);

    expect(result.frameCount).toBeGreaterThanOrEqual(1);
    expect(result.outputDir).toBe(path.resolve(out));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // The data-URL prefix is stripped and the base64 body decoded to raw bytes.
    const frame0 = path.join(out, 'frame-0000.jpg');
    expect(fs.existsSync(frame0)).toBe(true);
    expect(fs.readFileSync(frame0).toString('utf8')).toBe('fakeframe');
  });

  it('writes a meta.json whose frameCount matches the result and records intervalMs', async () => {
    const out = path.join(TMP_DIR, 'meta');
    const rec = new PollingRecorder(mockBrowser(DATA_URL), { intervalMs: 10 });
    rec.start();
    await new Promise(r => setTimeout(r, 35));
    const result = await rec.stop(out);

    const metaPath = path.join(out, 'meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.frameCount).toBe(result.frameCount);
    expect(meta.intervalMs).toBe(10);
    expect(typeof meta.ffmpegHint).toBe('string');
    expect(meta.ffmpegHint).toContain('ffmpeg');
  });

  it('unwraps an object-shaped screenshot return ({ result: <b64> })', async () => {
    const out = path.join(TMP_DIR, 'object-return');
    const rec = new PollingRecorder(mockBrowser({ result: FRAME_B64 }), { intervalMs: 10 });
    rec.start();
    await new Promise(r => setTimeout(r, 35));
    const result = await rec.stop(out);

    expect(result.frameCount).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(path.join(out, 'frame-0000.jpg')).toString('utf8')).toBe('fakeframe');
  });

  it('swallows individual screenshot errors without throwing or capturing a frame', async () => {
    const out = path.join(TMP_DIR, 'errors');
    const rec = new PollingRecorder({ screenshot: async () => { throw new Error('CDP down'); } }, { intervalMs: 10 });
    rec.start();
    await new Promise(r => setTimeout(r, 35));
    const result = await rec.stop(out);   // must not reject despite capture errors

    expect(result.frameCount).toBe(0);
  });

  it('start() is idempotent — a second call does not start a second timer', async () => {
    const out = path.join(TMP_DIR, 'idempotent');
    let calls = 0;
    const rec = new PollingRecorder({ screenshot: async () => { calls++; return DATA_URL; } }, { intervalMs: 10 });
    rec.start();
    rec.start();                          // no-op
    await new Promise(r => setTimeout(r, 45));
    const result = await rec.stop(out);
    // ~4 captures at 10ms over 45ms; a doubled timer would roughly double this.
    expect(calls).toBeLessThanOrEqual(8);
    expect(result.frameCount).toBe(calls);
  });

  it('stop() without start() resolves with zero frames and still writes meta.json', async () => {
    const out = path.join(TMP_DIR, 'no-start');
    const rec = new PollingRecorder(mockBrowser(DATA_URL), { intervalMs: 10 });
    const result = await rec.stop(out);

    expect(result.frameCount).toBe(0);
    expect(fs.existsSync(path.join(out, 'meta.json'))).toBe(true);
  });

  it('defaults intervalMs to 500 and quality to 70 when options are omitted', () => {
    const rec = new PollingRecorder(mockBrowser(DATA_URL));
    expect(rec._intervalMs).toBe(500);
    expect(rec._quality).toBe(70);
  });
});

describe('CdpScreenRecorder', () => {
  it.skipIf(WS_PRESENT)('create() throws an actionable error when the ws package is not installed', async () => {
    // ws is imported before the debugger URL is fetched, so the bogus port is never contacted.
    await expect(CdpScreenRecorder.create(9)).rejects.toThrow(/ws package/);
  });
});
