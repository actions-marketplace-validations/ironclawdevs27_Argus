/**
 * Argus Screen Recorder
 *
 * Records an audit session as a series of JPEG frames by periodically
 * calling browser.screenshot(). Frames are saved to reports/recordings/<id>/.
 *
 * For genuine CDP screencast (Page.startScreencast) instead of polling,
 * install the optional `ws` package:
 *   npm install ws
 * then use CdpScreenRecorder (exported below) which connects directly to
 * Chrome's WebSocket debugger URL.
 *
 * Usage (polling recorder — no extra deps):
 *   import { PollingRecorder } from './screen-recorder.js';
 *   const rec = new PollingRecorder(browser, { intervalMs: 500 });
 *   rec.start();
 *   // ... run audit ...
 *   const outputDir = await rec.stop('./reports/recordings/my-run');
 *
 * Usage (CDP screencast — requires ws):
 *   import { CdpScreenRecorder } from './screen-recorder.js';
 *   const rec = await CdpScreenRecorder.create(9222);
 *   await rec.start();
 *   // ...
 *   const outputDir = await rec.stop('./reports/recordings/my-run');
 */

import { spawn } from 'child_process';
import fs   from 'fs';
import path from 'path';
import http from 'http';

// ── Polling Recorder (no extra dependencies) ──────────────────────────────────

export class PollingRecorder {
  /**
   * @param {import('../adapters/browser.js').CdpBrowserAdapter} browser
   * @param {{ intervalMs?: number, quality?: number }} [options]
   */
  constructor(browser, options = {}) {
    this._browser   = browser;
    this._intervalMs = options.intervalMs ?? 500;
    this._quality    = options.quality    ?? 70;
    this._frames     = [];
    this._timer      = null;
    this._startedAt  = null;
  }

  /** Begin periodic screenshot capture. */
  start() {
    if (this._timer) return;
    this._startedAt = Date.now();
    this._frames    = [];
    this._timer     = setInterval(async () => {
      try {
        const raw = await this._browser.screenshot({ quality: this._quality });
        // screenshot() returns an MCP result — extract base64 data if wrapped
        const b64 = typeof raw === 'object' ? (raw.result ?? raw.data ?? raw) : raw;
        if (b64) this._frames.push({ ts: Date.now(), data: b64 });
      } catch { /* ignore individual capture errors */ }
    }, this._intervalMs);
  }

  /**
   * Stop recording and save frames to outputDir.
   *
   * @param {string} outputDir - Directory to write frame-NNN.jpg files into
   * @returns {Promise<{ outputDir: string, frameCount: number, durationMs: number }>}
   */
  async stop(outputDir) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    const durationMs = Date.now() - (this._startedAt ?? Date.now());
    const frames     = this._frames.slice();
    this._frames     = [];

    const resolved = path.resolve(outputDir);
    fs.mkdirSync(resolved, { recursive: true });

    for (let i = 0; i < frames.length; i++) {
      const name     = `frame-${String(i).padStart(4, '0')}.jpg`;
      const filePath = path.join(resolved, name);
      const b64      = frames[i].data;
      // b64 may be a data URL prefix — strip it
      const raw = typeof b64 === 'string'
        ? b64.replace(/^data:image\/\w+;base64,/, '')
        : b64;
      try {
        fs.writeFileSync(filePath, Buffer.from(raw, 'base64'));
      } catch { /* skip unwritable frames */ }
    }

    // Write metadata + ffmpeg hint
    const meta = {
      frameCount:  frames.length,
      durationMs,
      intervalMs:  this._intervalMs,
      capturedAt:  new Date(this._startedAt).toISOString(),
      ffmpegHint:  `ffmpeg -framerate ${Math.round(1000 / this._intervalMs)} -i frame-%04d.jpg -c:v libx264 -pix_fmt yuv420p recording.mp4`,
    };
    fs.writeFileSync(path.join(resolved, 'meta.json'), JSON.stringify(meta, null, 2));

    // Run ffmpeg automatically if available
    await _tryFfmpeg(resolved, meta.intervalMs).catch(() => {});

    return { outputDir: resolved, frameCount: frames.length, durationMs };
  }
}

// ── CDP Screencast Recorder (requires ws package) ─────────────────────────────

export class CdpScreenRecorder {
  constructor(ws, sessionId) {
    this._ws        = ws;
    this._sessionId = sessionId;
    this._frames    = [];
    this._startedAt = null;
    this._msgId     = 1;
  }

  /**
   * Create a CdpScreenRecorder connected to the first Chrome tab.
   * Requires the `ws` package: npm install ws
   *
   * @param {number} [port=9222]
   * @returns {Promise<CdpScreenRecorder>}
   */
  static async create(port = 9222) {
    let WebSocket;
    try {
      WebSocket = (await import('ws')).default;
    } catch {
      throw new Error(
        'CDP screencast requires the ws package:\n' +
        '  npm install ws\n' +
        'Or use PollingRecorder instead (no extra deps).'
      );
    }

    const debuggerUrl = await _fetchDebuggerUrl(port);
    const ws = new WebSocket(debuggerUrl);

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const rec = new CdpScreenRecorder(ws, null);
    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Page.screencastFrame') {
          rec._frames.push({ ts: Date.now(), data: msg.params.data });
          // Acknowledge the frame to keep Chrome sending
          rec._send('Page.screencastFrameAck', { sessionId: msg.params.metadata.sessionId });
        }
      } catch { /* ignore parse errors */ }
    });

    return rec;
  }

  _send(method, params = {}) {
    this._ws.send(JSON.stringify({ id: this._msgId++, method, params }));
  }

  /** Start CDP screencast. */
  async start() {
    this._startedAt = Date.now();
    this._frames    = [];
    this._send('Page.startScreencast', {
      format:        'jpeg',
      quality:       70,
      maxWidth:      1280,
      maxHeight:     900,
      everyNthFrame: 1,
    });
  }

  /**
   * Stop screencast and save frames to outputDir.
   *
   * @param {string} outputDir
   * @returns {Promise<{ outputDir: string, frameCount: number, durationMs: number }>}
   */
  async stop(outputDir) {
    this._send('Page.stopScreencast');
    await new Promise(r => setTimeout(r, 200)); // drain any buffered frames
    this._ws.close();

    const durationMs = Date.now() - (this._startedAt ?? Date.now());
    const frames     = this._frames.slice();
    const resolved   = path.resolve(outputDir);

    fs.mkdirSync(resolved, { recursive: true });

    for (let i = 0; i < frames.length; i++) {
      const name = `frame-${String(i).padStart(4, '0')}.jpg`;
      fs.writeFileSync(path.join(resolved, name), Buffer.from(frames[i].data, 'base64'));
    }

    const meta = {
      frameCount: frames.length,
      durationMs,
      capturedAt: new Date(this._startedAt).toISOString(),
      ffmpegHint: `ffmpeg -framerate 2 -i frame-%04d.jpg -c:v libx264 -pix_fmt yuv420p recording.mp4`,
    };
    fs.writeFileSync(path.join(resolved, 'meta.json'), JSON.stringify(meta, null, 2));

    await _tryFfmpeg(resolved, 500).catch(() => {});

    return { outputDir: resolved, frameCount: frames.length, durationMs };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _fetchDebuggerUrl(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}/json/list`, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          const pages = JSON.parse(body);
          const target = pages.find(p => p.type === 'page') ?? pages[0];
          if (!target?.webSocketDebuggerUrl) reject(new Error('No debuggable Chrome page found'));
          else resolve(target.webSocketDebuggerUrl);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function _tryFfmpeg(outputDir, intervalMs) {
  return new Promise((resolve, reject) => {
    const fps  = Math.max(1, Math.round(1000 / intervalMs));
    const proc = spawn('ffmpeg', [
      '-y', '-framerate', String(fps),
      '-i', 'frame-%04d.jpg',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      'recording.mp4',
    ], { cwd: outputDir, stdio: 'ignore' });
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    proc.on('error', reject);
  });
}
