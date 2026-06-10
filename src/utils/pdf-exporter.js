/**
 * Argus PDF Exporter
 *
 * Exports the Argus HTML report as a branded A4 PDF using puppeteer.
 * puppeteer is an optional peer dependency — install when needed:
 *   npm install puppeteer
 *
 * Usage (programmatic):
 *   import { exportReportToPdf } from './pdf-exporter.js';
 *   const pdfPath = await exportReportToPdf('./reports/report.html', './reports/report.pdf');
 *
 * Usage (CLI):
 *   node src/utils/pdf-exporter.js ./reports/report.html ./reports/report.pdf
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);

/**
 * Load puppeteer dynamically so the import failure is a clear runtime error,
 * not a module load error on startup.
 *
 * @returns {Promise<object>} puppeteer default export
 * @throws {Error} with install instructions if not installed
 */
async function loadPuppeteer() {
  try {
    return (await import('puppeteer')).default;
  } catch {
    throw new Error(
      'PDF export requires puppeteer:\n' +
      '  npm install puppeteer\n' +
      'Then retry.'
    );
  }
}

/**
 * Export an Argus HTML report to a branded A4 PDF.
 *
 * @param {string} htmlPath   - Absolute or relative path to the source HTML report
 * @param {string} outputPath - Destination PDF file path (written to disk)
 * @param {{ format?: string, landscape?: boolean, scale?: number }} [options]
 * @returns {Promise<string>} Resolved outputPath
 */
export async function exportReportToPdf(htmlPath, outputPath, options = {}) {
  const {
    format    = 'A4',
    landscape = false,
    scale     = 1,
  } = options;

  const resolvedHtml = path.resolve(htmlPath);
  if (!fs.existsSync(resolvedHtml)) {
    throw new Error(`HTML report not found: ${resolvedHtml}`);
  }

  const resolvedOut = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

  const puppeteer = await loadPuppeteer();
  const browser   = await puppeteer.launch({ headless: 'new' });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(pathToFileURL(resolvedHtml).href, { waitUntil: 'networkidle0', timeout: 30_000 });

    await page.pdf({
      path:            resolvedOut,
      format,
      landscape,
      scale,
      printBackground: true,
      margin:          { top: '18mm', right: '14mm', bottom: '18mm', left: '14mm' },
    });
  } finally {
    await browser.close();
  }

  return resolvedOut;
}

/**
 * Navigate to a live URL and export to PDF.
 *
 * @param {string} pageUrl    - URL to navigate to before printing
 * @param {string} outputPath - Destination PDF file path
 * @param {{ format?: string, landscape?: boolean, scale?: number, waitUntil?: string }} [options]
 * @returns {Promise<string>}
 */
export async function exportPageToPdf(pageUrl, outputPath, options = {}) {
  const {
    format    = 'A4',
    landscape = false,
    scale     = 1,
    waitUntil = 'networkidle0',
  } = options;

  const resolvedOut = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });

  const puppeteer = await loadPuppeteer();
  const browser   = await puppeteer.launch({ headless: 'new' });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(pageUrl, { waitUntil, timeout: 30_000 });

    await page.pdf({
      path:            resolvedOut,
      format,
      landscape,
      scale,
      printBackground: true,
      margin:          { top: '18mm', right: '14mm', bottom: '18mm', left: '14mm' },
    });
  } finally {
    await browser.close();
  }

  return resolvedOut;
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

if (process.argv[1] === __filename) {
  const [,, htmlArg, outArg] = process.argv;

  if (!htmlArg || !outArg) {
    process.stderr.write('Usage: node src/utils/pdf-exporter.js <report.html> <output.pdf>\n');
    process.exit(1);
  }

  try {
    const out = await exportReportToPdf(htmlArg, outArg);
    process.stdout.write(`✓ PDF written: ${out}\n`);
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exit(1);
  }
}
