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
 * Only paths **within** `.release-skill/` are listed here. The check is
 * path-prefix based: `.release-skill/lock` matches `.release-skill/lock`,
 * `.release-skill/lock/.owner`, `.release-skill/lock-audit/…`, etc.
 *
 * `project.yaml` is intentionally **not** listed — changes to project
 * configuration must always cause a baseline drift.
 */
const CONTROL_PLANE_PATHS = [
  '.release-skill/lock',
  '.release-skill/lock-audit',
  '.release-skill/runs',
  '.release-skill/transactions',
  '.release-skill/release-plan.json',
  '.release-skill/approval-record.json',
];

/**
 * Check whether a path (relative to repo root, using `/` separators) is a
 * release-skill control-plane file that should be excluded from the digest.
 *
 * @param {string} p - Repo-relative path.
 * @returns {boolean}
 */
function isControlPlanePath(p) {
  const normalized = p.replace(/\\/g, '/');
  return CONTROL_PLANE_PATHS.some(
    (cp) => normalized === cp || normalized.startsWith(`${cp}/`),
  );
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
    { stdout: diffOut },
    { stdout: untrackedOut },
  ] = await Promise.all([
    execFile('git', ['ls-files', '-s'], opts),
    execFile('git', ['diff'], opts),
    execFile('git', ['ls-files', '-o', '--exclude-standard'], opts),
  ]);

  // Collect all meaningful lines
  const parts = [];

  // Staged entries: one line per file like "100644 <hash> 0\tpath"
  // Filter out control-plane paths.
  for (const line of stagedOut.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const tabIdx = trimmed.indexOf('\t');
    const filePath = tabIdx >= 0 ? trimmed.slice(tabIdx + 1) : null;
    if (filePath && isControlPlanePath(filePath)) continue;
    parts.push(trimmed);
  }

  // Unstaged diff: include the full patch text so content changes are captured.
  // Track which file the current hunk belongs to; skip lines belonging to
  // control-plane files (detected from diff headers).
  let currentDiffFile = '';
  let skipDiffFile = false;
  for (const line of diffOut.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;

    // Detect file header lines: "diff --git a/path b/path"
    if (trimmed.startsWith('diff --git ')) {
      const match = trimmed.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match) {
        currentDiffFile = match[2];
        skipDiffFile = isControlPlanePath(currentDiffFile);
      } else {
        skipDiffFile = false;
      }
    }

    // Skip "--- a/..." and "+++ b/..." header lines for control-plane files
    // as an extra guard (the file itself was already detected above).
    if (trimmed.startsWith('--- ') || trimmed.startsWith('+++ ')) {
      const prefix = trimmed.slice(4);
      if (prefix !== '/dev/null' && isControlPlanePath(prefix.replace(/^[ab]\//, ''))) {
        continue;
      }
    }

    if (skipDiffFile) continue;
    parts.push(trimmed);
  }

  // Untracked (non-ignored) entries: filter control-plane paths, then produce a
  // safe content digest binding path + Git-visible type + file bytes.
  const untrackedPaths = untrackedOut
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isControlPlanePath(l));

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
      execFile('git', ['status', '--porcelain', '-uall'], opts),
    ]);

  const gitHead = headOut.trim();
  const gitTreeHash = treeOut.trim();
  const statusEntries = statusOut
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => {
      // "XY path" or "XY orig -> path": extract the path portion
      const afterXY = line.slice(3);
      const pathPart = afterXY.includes(' -> ') ? afterXY.split(' -> ').pop() : afterXY;
      return !isControlPlanePath(pathPart);
    });

  const workspaceDigest = await computeWorkspaceDigest(root);

  return {
    gitHead,
    gitTreeHash,
    workspaceDigest,
    statusEntries,
    capturedAt: new Date().toISOString(),
  };
}
