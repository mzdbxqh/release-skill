import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import {
  ActionStatus,
  ActionType,
  assertWritesAuthorized,
  createResult,
  matchObservation,
} from './contract.mjs';
import { verifyFrozenGitRepository, verifyFrozenSnapshot } from '../snapshot/frozen.mjs';

const execFile = promisify(execFileCb);
const NAME = 'push-snapshot';

async function run(command, args, options = {}) {
  return execFile(command, args, {
    shell: false,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
}

export function githubRepositoryUrl(repo, host = 'github.com') {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error('repo must use owner/name format');
  }
  if (
    typeof host !== 'string' || !/^[A-Za-z0-9.-]+$/.test(host) ||
    host.startsWith('.') || host.endsWith('.') || host.includes('..')
  ) {
    throw new Error('githubHost must be a valid hostname');
  }
  return `https://${host}/${repo}.git`;
}

function validateOid(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) {
    throw new Error(`${label} must be a full hexadecimal git object id`);
  }
}

function validateAction(action) {
  const required = ['snapshotPath', 'manifestDigest', 'gitObjectDir', 'branch', 'repo', 'commit', 'tree'];
  for (const key of required) {
    if (!action[key] || typeof action[key] !== 'string') {
      throw new Error(`push-snapshot requires ${key}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(action.manifestDigest)) {
    throw new Error('manifestDigest must be a lowercase SHA-256 digest');
  }
  validateOid(action.commit, 'commit');
  validateOid(action.tree, 'tree');
  githubRepositoryUrl(action.repo, action.githubHost);

  const validStrategies = ['create-release-branch', 'advance-existing-branch', 'initialize-default-branch'];
  const strategy = action.branchStrategy ?? 'create-release-branch';
  if (typeof strategy !== 'string' || !validStrategies.includes(strategy)) {
    throw new Error(`branchStrategy must be one of: ${validStrategies.join(', ')}`);
  }
  if (strategy === 'advance-existing-branch' || strategy === 'initialize-default-branch') {
    if (!action.parentCommit || typeof action.parentCommit !== 'string') {
      throw new Error(`${strategy} requires parentCommit`);
    }
    validateOid(action.parentCommit, 'parentCommit');
  }
  if (strategy === 'advance-existing-branch') {
    if (!action.expectedBaselineCommit || typeof action.expectedBaselineCommit !== 'string') {
      throw new Error('advance-existing-branch requires expectedBaselineCommit');
    }
    validateOid(action.expectedBaselineCommit, 'expectedBaselineCommit');
    if (action.expectedBaselineCommit !== action.parentCommit) {
      throw new Error('advance-existing-branch expectedBaselineCommit must equal parentCommit');
    }
  }
  if (strategy === 'create-release-branch' && (action.parentCommit || action.expectedBaselineCommit)) {
    throw new Error('create-release-branch must not declare parentCommit or expectedBaselineCommit');
  }

  if (action.parentCommit != null && typeof action.parentCommit === 'string') {
    validateOid(action.parentCommit, 'parentCommit');
  }
  if (action.expectedBaselineCommit != null && typeof action.expectedBaselineCommit === 'string') {
    validateOid(action.expectedBaselineCommit, 'expectedBaselineCommit');
  }
}

async function inspectLocalObjects(action, context, exec) {
  const { gitDir } = await verifyFrozenGitRepository({
    root: context.root,
    gitObjectDir: action.gitObjectDir,
    commit: action.commit,
    tree: action.tree,
    parentCommit: action.parentCommit,
    exec,
  });
  await exec('git', ['check-ref-format', `refs/heads/${action.branch}`], { shell: false });
  return gitDir;
}

export function createPushSnapshotAdapter(deps = {}) {
  const exec = deps.exec ?? run;

  return Object.freeze({
    name: NAME,
    actionTypes: Object.freeze([ActionType.PUSH_SNAPSHOT]),

    async preflight(action, context) {
      try {
        if (action.actionType !== ActionType.PUSH_SNAPSHOT) throw new Error('unsupported action type');
        validateAction(action);
        await verifyFrozenSnapshot({
          root: context.root,
          snapshotPath: action.snapshotPath,
          expectedDigest: action.manifestDigest,
        });
        await inspectLocalObjects(action, context, exec);
        const remoteUrl = githubRepositoryUrl(action.repo, action.githubHost);
        const { stdout } = await exec(
          'git',
          ['ls-remote', '--heads', remoteUrl, `refs/heads/${action.branch}`],
          { shell: false },
        );
        const remoteTip = stdout.trim().split(/\s+/)[0] ?? '';
        const strategy = action.branchStrategy ?? 'create-release-branch';

        if (strategy === 'advance-existing-branch') {
          if (!remoteTip) {
            return createResult({
              actionType: action.actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `advance-existing-branch requires remote branch to exist: ${action.branch}`,
            });
          }
          if (remoteTip !== action.expectedBaselineCommit) {
            return createResult({
              actionType: action.actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `remote branch tip mismatch: expected ${action.expectedBaselineCommit} but found ${remoteTip}`,
            });
          }
        } else if (strategy === 'initialize-default-branch' || strategy === 'create-release-branch') {
          if (remoteTip) {
            return createResult({
              actionType: action.actionType,
              status: ActionStatus.PREFLIGHT_FAILED,
              error: `remote branch already exists: ${action.branch}; human intervention required`,
            });
          }
        }
        return createResult({ actionType: action.actionType, status: ActionStatus.PREFLIGHT_PASSED });
      } catch (err) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.PREFLIGHT_FAILED,
          error: err.message,
        });
      }
    },

    async execute(action, context) {
      assertWritesAuthorized(context, action.actionType);
      try {
        validateAction(action);
        await verifyFrozenSnapshot({
          root: context.root,
          snapshotPath: action.snapshotPath,
          expectedDigest: action.manifestDigest,
        });
        const gitDir = await inspectLocalObjects(action, context, exec);
        const remoteUrl = githubRepositoryUrl(action.repo, action.githubHost);
        const strategy = action.branchStrategy ?? 'create-release-branch';

        if (strategy === 'advance-existing-branch') {
          await exec(
            'git',
            [
              '--git-dir', gitDir,
              'push',
              remoteUrl,
              `${action.commit}:refs/heads/${action.branch}`,
            ],
            { shell: false },
          );
        } else {
          await exec(
            'git',
            [
              '--git-dir', gitDir,
              'push',
              `--force-with-lease=refs/heads/${action.branch}:`,
              remoteUrl,
              `${action.commit}:refs/heads/${action.branch}`,
            ],
            { shell: false },
          );
        }
        return createResult({ actionType: action.actionType, status: ActionStatus.EXECUTED });
      } catch (err) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.EXECUTE_FAILED,
          error: err.message,
        });
      }
    },

    async observe(action, context) {
      try {
        validateAction(action);
        const frozen = await verifyFrozenSnapshot({
          root: context.root,
          snapshotPath: action.snapshotPath,
          expectedDigest: action.manifestDigest,
        });
        const gitDir = await inspectLocalObjects(action, context, exec);
        const remoteUrl = githubRepositoryUrl(action.repo, action.githubHost);
        const { stdout } = await exec(
          'git',
          ['ls-remote', '--heads', remoteUrl, `refs/heads/${action.branch}`],
          { shell: false },
        );
        const commit = stdout.trim().split(/\s+/)[0] ?? '';
        if (!commit) {
          return createResult({
            actionType: action.actionType,
            status: ActionStatus.OBSERVED,
            observation: { branch: action.branch, exists: false },
          });
        }
        await exec(
          'git',
          ['--git-dir', gitDir, 'fetch', '--no-tags', remoteUrl, `refs/heads/${action.branch}`],
          { shell: false },
        );
        const { stdout: treeOut } = await exec(
          'git',
          ['--git-dir', gitDir, 'rev-parse', 'FETCH_HEAD^{tree}'],
          { shell: false },
        );
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.OBSERVED,
          observation: {
            branch: action.branch,
            commit,
            tree: treeOut.trim(),
            manifestDigest: frozen.digest,
            exists: true,
          },
        });
      } catch (err) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.OBSERVED,
          observation: {},
          error: err.message,
        });
      }
    },

    async verify(action, context) {
      const observed = await this.observe(action, context);
      if (observed.error) {
        return createResult({
          actionType: action.actionType,
          status: ActionStatus.VERIFY_FAILED,
          observation: observed.observation,
          error: observed.error,
        });
      }
      const comparison = matchObservation(action.expected ?? {}, observed.observation);
      return createResult({
        actionType: action.actionType,
        status: comparison.matches ? ActionStatus.VERIFIED : ActionStatus.VERIFY_FAILED,
        observation: observed.observation,
        error: comparison.matches ? null : comparison.mismatches.join('; '),
      });
    },
  });
}
