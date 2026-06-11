/**
 * Root Cause Linking — recent git changes → suspect files per finding.
 *
 * Pure git-diff heuristic: no external API, no AI call. Reads the last N
 * commits from the local repo (`git log --name-only`), maps changed files to
 * route paths with the same slug heuristic as pr-diff-analyzer, and annotates
 * each NEW finding (isNew: true) with the files/commits most likely to have
 * caused it:
 *
 *   finding.rootCause = {
 *     files:   ['src/pages/checkout/Form.jsx', ...],   // ≤ MAX_FILES
 *     commits: [{ hash: 'abc1234', subject: '...' }],  // ≤ MAX_COMMITS
 *     global:  false,  // true when only infra-level files matched
 *   }
 *
 * Only new findings are annotated — a finding that predates the recent commits
 * cannot have been caused by them. Source repo defaults to ARGUS_SOURCE_DIR or
 * the current working directory. Disable with ARGUS_ROOT_CAUSE=0.
 */

import { execSync } from 'child_process';
import { INFRA_PATTERNS } from './pr-diff-analyzer.js';
import { childLogger }    from './logger.js';

const logger = childLogger('root-cause-linker');

/** Commits inspected by default. */
export const DEFAULT_COMMITS = 10;
/** Max suspect files attached to one finding. */
const MAX_FILES = 5;
/** Max commits attached to one finding. */
const MAX_COMMITS = 3;

/**
 * Read the last N commits with their changed files from a local git repo.
 * Returns [] when the directory is not a repo, git is unavailable, or the
 * command fails — root cause linking is always best-effort.
 *
 * @param {string} [repoDir]  - Defaults to ARGUS_SOURCE_DIR, then cwd
 * @param {object} [opts]
 * @param {number} [opts.commits]
 * @returns {Array<{ hash: string, subject: string, files: string[] }>}
 */
export function getRecentChanges(repoDir = process.env.ARGUS_SOURCE_DIR || process.cwd(), { commits = DEFAULT_COMMITS } = {}) {
  let out;
  try {
    out = execSync(`git log --name-only --pretty=format:%h%x09%s -n ${Math.max(1, commits | 0)}`, {
      cwd: repoDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).toString();
  } catch {
    return [];
  }

  const changes = [];
  let current = null;
  for (const line of out.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (trimmed.includes('\t')) {
      const [hash, ...subjectParts] = trimmed.split('\t');
      current = { hash, subject: subjectParts.join('\t'), files: [] };
      changes.push(current);
    } else if (current) {
      // Git emits paths with forward slashes on every platform
      current.files.push(trimmed);
    }
  }
  return changes;
}

/**
 * Match changed file paths against one route path using the slug heuristic
 * from pr-diff-analyzer: a file matches when any of its path/name slugs equals
 * a route path segment. Infra-level files (configs, root layouts, global CSS)
 * match every route and are reported via `global`.
 *
 * @param {string[]} files
 * @param {string}   routePath  - e.g. "/checkout/review"
 * @returns {{ files: string[], global: boolean }}
 */
export function matchFilesToRoutePath(files, routePath) {
  const segments = String(routePath ?? '')
    .toLowerCase()
    .split('/')
    .map(s => s.replace(/[^a-z0-9]/g, ''))
    .filter(s => s.length > 1);

  const matched = [];
  let global = false;

  for (const file of (files ?? [])) {
    if (INFRA_PATTERNS.some(re => re.test(file))) {
      global = true;
      continue;
    }
    if (segments.length === 0) continue; // home route "/" — only infra files apply
    const slugs = file
      .toLowerCase()
      .replace(/\.[^./\\]+$/, '')
      .split(/[/\\._-]+/)
      .filter(s => s.length > 1);
    if (segments.some(seg => slugs.includes(seg))) matched.push(file);
  }

  return { files: matched, global };
}

/**
 * Annotate NEW findings in the report with `rootCause` (mutates in place).
 *
 * For each route, slug-matches every recent commit's files against the route's
 * URL pathname. Direct file matches win; when only infra-level files changed,
 * the annotation carries `global: true` with those files as suspects.
 *
 * @param {object} report   - { routes: [{ url, errors }] }; findings need isNew
 * @param {Array}  changes  - From getRecentChanges()
 * @returns {{ linkedCount: number }}
 */
export function linkRootCauses(report, changes) {
  let linkedCount = 0;
  if (!Array.isArray(changes) || changes.length === 0) return { linkedCount };

  for (const routeResult of (report.routes ?? [])) {
    let routePath;
    try {
      routePath = new URL(routeResult.url).pathname;
    } catch {
      continue;
    }

    // Collect suspect files + commits for this route across the recent commits
    const directFiles = [];
    const infraFiles  = [];
    const directCommits = [];
    const infraCommits  = [];
    for (const commit of changes) {
      const { files, global } = matchFilesToRoutePath(commit.files, routePath);
      if (files.length > 0) {
        directFiles.push(...files);
        directCommits.push({ hash: commit.hash, subject: commit.subject });
      } else if (global) {
        infraFiles.push(...commit.files.filter(f => INFRA_PATTERNS.some(re => re.test(f))));
        infraCommits.push({ hash: commit.hash, subject: commit.subject });
      }
    }

    const useDirect = directFiles.length > 0;
    const suspectFiles   = [...new Set(useDirect ? directFiles : infraFiles)].slice(0, MAX_FILES);
    const suspectCommits = (useDirect ? directCommits : infraCommits).slice(0, MAX_COMMITS);
    if (suspectFiles.length === 0) continue;

    for (const finding of (routeResult.errors ?? [])) {
      if (!finding.isNew) continue; // pre-existing findings predate these commits
      finding.rootCause = {
        files:   suspectFiles,
        commits: suspectCommits,
        global:  !useDirect,
      };
      linkedCount++;
    }
  }

  if (linkedCount > 0) {
    logger.info(`[ARGUS] Root cause linking: ${linkedCount} new finding(s) linked to recent commits`);
  }
  return { linkedCount };
}
