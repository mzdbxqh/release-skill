import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, open, readlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const execFile = promisify(execFileCb);

/**
 * Narrow, centrally-defined list of release-skill control-plane paths that
 * the tool itself creates or deletes during the release lifecycle. These
 * paths must be excluded from workspaceDigest and statusEntries so that the
 * prepare→approve→publish happy path does not trigger a false BASELINE_CHANGED.
 *
 * Only paths **within** `.release-skill/` are listed here. Runtime directories
 * use reserved prefixes; immutable plans and approvals use exact digest-shaped
 * paths so arbitrary files under similarly named directories remain visible.
 *
 * `project.yaml` is intentionally **not** listed — changes to project
 * configuration must always cause a baseline drift.
 */
export const WORKSPACE_DIGEST_ALGORITHM = 'git-workspace-v2';

const CONTROL_PLANE_PREFIXES = [
  '.release-skill/lock',
  '.release-skill/lock-audit',
  '.release-skill/runs',
  '.release-skill/transactions',
];
const RESERVED_CONTROL_PREFIXES = [
  ...CONTROL_PLANE_PREFIXES,
  '.release-skill/plans',
  '.release-skill/approvals',
];
const CONTROL_PLANE_EXACT = new Set([
  '.release-skill/release-plan.json',
  '.release-skill/approval-record.json',
]);
const DIGEST = '[a-f0-9]{64}';
const IMMUTABLE_PLAN = new RegExp(`^\\.release-skill/plans/${DIGEST}\\.json$`);
const IMMUTABLE_APPROVAL = new RegExp(
  `^\\.release-skill/approvals/${DIGEST}/${DIGEST}\\.json$`,
);

/**
 * Check whether a path (relative to repo root, using `/` separators) is a
 * release-skill control-plane file that should be excluded from the digest.
 *
 * @param {string} p - Repo-relative path.
 * @returns {boolean}
 */
function isControlPlanePath(p) {
  // Git's -z output preserves path bytes and uses `/` as the repository
  // separator. Do not rewrite literal backslashes: on POSIX they are valid
  // filename bytes, not separators.
  const normalized = p;
  if (CONTROL_PLANE_EXACT.has(normalized)) return true;
  if (IMMUTABLE_PLAN.test(normalized) || IMMUTABLE_APPROVAL.test(normalized)) return true;
  return CONTROL_PLANE_PREFIXES.some(
    (cp) => normalized === cp || normalized.startsWith(`${cp}/`),
  );
}

export function isReservedReleaseControlPath(p) {
  return RESERVED_CONTROL_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(`${prefix}/`),
  ) || CONTROL_PLANE_EXACT.has(p);
}

function splitNul(value) {
  const records = value.split('\0');
  if (records.at(-1) === '') records.pop();
  return records;
}

function parseStatusPorcelainZ(statusOut) {
  const records = splitNul(statusOut);
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 3) throw new Error('Malformed git status --porcelain=v1 -z record');
    const xy = record.slice(0, 2);
    const destination = record.slice(3);
    const renamed = xy.includes('R') || xy.includes('C');
    const source = renamed ? records[++index] : null;
    if (renamed && source === undefined) {
      throw new Error('Malformed git status rename record: missing source path');
    }
    const paths = source === null ? [destination] : [source, destination];
    // A rename crossing the control-plane boundary is user-visible. Exclude
    // only when every path participating in the status record is control data.
    if (paths.every(isControlPlanePath)) continue;
    entries.push(source === null
      ? `${xy} ${destination}`
      : `${xy} ${source} -> ${destination}`);
  }
  return entries;
}

/**
 * Compute a deterministic workspace digest covering staged, unstaged, and
 * untracked (non-ignored) content.
 *
 * Sources:
 * - `git ls-files -s` -- staged index entries (mode, object hash, path)
 * - `git diff` -- unstaged modifications to tracked files (patch text)
 * - `git ls-files -o --exclude-standard` -- untracked files respecting .gitignore
 *
 * All lines are sorted lexicographically to ensure determinism. The combined
 * string is hashed with SHA-256.
 *
 * Control-plane paths (lock, runs, approval-record, etc.) are filtered out
 * so that release-skill's own lifecycle files do not cause baseline drift.
 *
 * @param {string} root - Absolute path to a valid git repository directory.
 * @returns {Promise<string>} Hex-encoded SHA-256 digest.
 */
async function computeWorkspaceDigest(root) {
  const opts = { cwd: root, shell: false, encoding: 'utf8' };

  const [
    { stdout: stagedOut },
    { stdout: changedOut },
    { stdout: untrackedOut },
  ] = await Promise.all([
    execFile('git', ['ls-files', '-s', '-z'], opts),
    execFile('git', ['diff', '--name-only', '-z'], opts),
    execFile('git', ['ls-files', '-o', '--exclude-standard', '-z'], opts),
  ]);

  // Collect all meaningful lines
  const parts = [];

  // Staged entries: one line per file like "100644 <hash> 0\tpath"
  // Filter out control-plane paths.
  for (const record of splitNul(stagedOut)) {
    const tabIdx = record.indexOf('\t');
    const filePath = tabIdx >= 0 ? record.slice(tabIdx + 1) : null;
    if (filePath && isControlPlanePath(filePath)) continue;
    parts.push(record);
  }

  // Ask Git for unambiguous NUL-delimited names, then request the patch for
  // each exact argv path. This avoids parsing C-quoted `diff --git` headers.
  const changedPaths = splitNul(changedOut).filter((p) => !isControlPlanePath(p));
  for (const changedPath of changedPaths) {
    const { stdout: patch } = await execFile(
      'git',
      ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', '--', changedPath],
      opts,
    );
    parts.push(`UNSTAGED:${changedPath}\0${patch}`);
  }

  // Untracked (non-ignored) entries: filter control-plane paths, then produce a
  // safe content digest binding path + Git-visible type + file bytes.
  const untrackedPaths = splitNul(untrackedOut)
    .filter((p) => p.length > 0 && !isControlPlanePath(p));

  const untrackedParts = await Promise.all(
    untrackedPaths.map(async (relPath) => {
      const absPath = path.resolve(root, relPath);

      // Defense-in-depth: resolved path must remain within the repo root.
      // Normalise both sides to handle trailing-separator differences.
      const normalisedRoot = path.resolve(root) + path.sep;
      if (!absPath.startsWith(normalisedRoot) && absPath !== path.resolve(root)) {
        throw new Error(
          `Refusing to read path outside repository root: ${relPath} resolves to ${absPath}`,
        );
      }

      const stat = await lstat(absPath);
      // Git-visible type marker (do NOT follow symlinks)
      let type;
      if (stat.isSymbolicLink()) {
        type = 'symlink';
      } else if (stat.isDirectory()) {
        type = 'dir';
      } else if (stat.isFile()) {
        type = 'file';
      } else {
        type = 'other';
      }
      const typeMarker = `TYPE:${type}`;

      let content;
      if (stat.isFile()) {
        // TOCTOU-safe read: open with O_NOFOLLOW so a symlink replacing the
        // file between lstat and open causes ELOOP, then verify the inode
        // still matches to catch same-type replacement races.
        const handle = await open(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const fdStat = await handle.stat();
          if (fdStat.ino !== stat.ino) {
            throw new Error(
              `Race detected: inode changed for ${relPath} between lstat and read`,
            );
          }
          const { buffer, bytesRead } = await handle.read(
            Buffer.alloc(fdStat.size || 4096),
            0,
            fdStat.size || 4096,
            0,
          );
          content = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      } else if (stat.isSymbolicLink()) {
        // Bind the link target itself — do NOT follow.
        content = Buffer.from(await readlink(absPath), 'utf8');
      } else {
        content = Buffer.alloc(0);
      }

      return [
        relPath,
        typeMarker,
        createHash('sha256').update(content).digest('hex'),
      ].join('\t');
    }),
  );

  // Sort for determinism
  parts.sort();
  untrackedParts.sort();

  const combined = parts.join('\n')
    + (parts.length && untrackedParts.length ? '\n' : '')
    + untrackedParts.join('\n');

  return createHash('sha256').update(combined).digest('hex');
}

/**
 * Capture the Git baseline state for a repository.
 *
 * Returns a `workspaceDigest` that deterministically covers HEAD/tree AND
 * staged, unstaged, and untracked (non-ignored) content. Changes to
 * git-ignored paths (e.g. `.release-skill/`, `node_modules/`) do not affect
 * the digest.
 *
 * @param {string} root - Absolute path to a valid git repository directory.
 * @returns {Promise<{ gitHead: string, gitTreeHash: string, workspaceDigest: string, statusEntries: string[], capturedAt: string }>}
 */
export async function captureBaseline(root) {
  const opts = { cwd: root, shell: false, encoding: 'utf8' };

  const [{ stdout: headOut }, { stdout: treeOut }, { stdout: statusOut }] =
    await Promise.all([
      execFile('git', ['rev-parse', 'HEAD'], opts),
      execFile('git', ['rev-parse', 'HEAD^{tree}'], opts),
      execFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], opts),
    ]);

  const gitHead = headOut.trim();
  const gitTreeHash = treeOut.trim();
  const statusEntries = parseStatusPorcelainZ(statusOut);

  const workspaceDigest = await computeWorkspaceDigest(root);

  return {
    gitHead,
    gitTreeHash,
    workspaceDigestAlgorithm: WORKSPACE_DIGEST_ALGORITHM,
    workspaceDigest,
    statusEntries,
    capturedAt: new Date().toISOString(),
  };
}
