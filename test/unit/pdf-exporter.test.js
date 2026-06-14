import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exportReportToPdf, exportPageToPdf } from '../../src/utils/pdf-exporter.js';

// puppeteer is an optional peer dependency (not in package.json). Detect it so the
// puppeteer-missing tests stay correct if someone installs puppeteer locally.
async function canResolve(spec) {
  try { await import(spec); return true; } catch { return false; }
}
const PUPPETEER_PRESENT = await canResolve('puppeteer');

const TMP_DIR = path.join(os.tmpdir(), `argus-pdf-${process.pid}`);

afterEach(() => {
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('exportReportToPdf', () => {
  it('rejects with a clear "not found" error when the source HTML does not exist', async () => {
    const missing = path.join(TMP_DIR, 'does-not-exist.html');
    const out     = path.join(TMP_DIR, 'out.pdf');
    await expect(exportReportToPdf(missing, out)).rejects.toThrow(/not found/i);
  });

  it.skipIf(PUPPETEER_PRESENT)(
    'rejects with puppeteer install instructions once the HTML exists but puppeteer is absent',
    async () => {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const html = path.join(TMP_DIR, 'report.html');
      fs.writeFileSync(html, '<html><body>Argus report</body></html>');
      const out = path.join(TMP_DIR, 'nested', 'out.pdf');

      await expect(exportReportToPdf(html, out)).rejects.toThrow(/puppeteer/i);
      // It got past existsSync and created the output directory before failing on puppeteer.
      expect(fs.existsSync(path.dirname(path.resolve(out)))).toBe(true);
    },
  );
});

describe('exportPageToPdf', () => {
  it.skipIf(PUPPETEER_PRESENT)(
    'rejects with puppeteer install instructions when puppeteer is absent',
    async () => {
      const out = path.join(TMP_DIR, 'page', 'out.pdf');
      await expect(exportPageToPdf('http://127.0.0.1:9/never', out)).rejects.toThrow(/puppeteer/i);
      expect(fs.existsSync(path.dirname(path.resolve(out)))).toBe(true);
    },
  );
});
