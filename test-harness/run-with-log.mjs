#!/usr/bin/env node
/**
 * Tee wrapper: runs test-harness/validate.js, streams output live to the terminal
 * AND saves the full output to harness-results.txt at the repo root.
 *
 * Usage: npm run test:harness:log
 */
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const logPath = resolve(root, 'harness-results.txt');
const logFile = createWriteStream(logPath);

const child = spawn(
  process.execPath,
  ['--env-file=test-harness/.env.harness', 'test-harness/validate.js'],
  { stdio: ['inherit', 'pipe', 'pipe'], cwd: root, env: process.env }
);

child.stdout.on('data', (chunk) => { process.stdout.write(chunk); logFile.write(chunk); });
child.stderr.on('data', (chunk) => { process.stderr.write(chunk); logFile.write(chunk); });

child.on('close', (code) => {
  logFile.end(() => {
    process.stderr.write(`\nFull output saved → harness-results.txt\n`);
    process.exit(code ?? 0);
  });
});
