import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import {
  ActionStatus,
  ActionType,
  assertWritesAuthorized,
  createResult,
  matchObservation,
} from './contract.mjs';
import { resolveFrozenPath, verifyFrozenDirectoryStructure } from '../snapshot/frozen.mjs';
import { githubRepositoryUrl } from './push-snapshot.mjs';

const execFile = promisify(execFileCb);
const NAME = 'git-github';

async function run(command, args, options = {}) {
  return execFile(command, args, {
    shell: false,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
}

function isNotFound(error) {
  const text = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  return /(?:HTTP\s+404|\bstatus(?: code)?\s*[:=]?\s*404\b|(?:^|\n)\s*release not found\s*(?:\n|$))/i.test(text);
}

function ghRepo(action) {
  const host = action.githubHost ?? 'github.com';
  githubRepositoryUrl(action.repo, host);
  return host === 'github.com' ? action.repo : `${host}/${action.repo}`;
}

function validateOid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) {
    throw new Error('commit must be a full hexadecimal git object id');
  }
}

async function validateTagAction(action, context, exec) {
  if (!action.tag || !action.repo || !action.gitObjectDir) {
    throw new Error('git-tag requires tag, repo, gitObjectDir, and commit');
  }
  validateOid(action.commit);
  const gitDir = await resolveFrozenPath(context.root, action.gitObjectDir, 'frozen git object directory');
  await verifyFrozenDirectoryStructure(gitDir, 'frozen git object directory');
  await exec('git', ['check-ref-format', `refs/tags/${action.tag}`], { shell: false });
  const { stdout: commitOut } = await exec('git', ['--git-dir', gitDir, 'rev-parse', action.commit], { shell: false });
  if (commitOut.trim() !== action.commit) throw new Error('planned commit is missing from frozen git objects');
  return { gitDir, remoteUrl: githubRepositoryUrl(action.repo, action.githubHost) };
}

async function readRemoteTag(action, remoteUrl, exec) {
  const { stdout } = await exec(
    'git',
    ['ls-remote', '--tags', remoteUrl, `refs/tags/${action.tag}`],
    { shell: false },
  );
  return stdout.trim().split(/\s+/)[0] ?? '';
}

function validateDefaultBranchAction(action) {
  if (!action.repo || !action.oldBranch || !action.newBranch || !action.expectedNewBranchCommit) {
    throw new Error('set-default-branch requires repo, oldBranch, newBranch, and expectedNewBranchCommit');
  }
  validateOid(action.expectedNewBranchCommit);
  githubRepositoryUrl(action.repo, action.githubHost);
  for (const [label, branch] of [['oldBranch', action.oldBranch], ['newBranch', action.newBranch]]) {
    if (
      typeof branch !== 'string' || branch.length === 0 || branch.startsWith('/') ||
      branch.endsWith('/') || branch.includes('..') || branch.includes('\\') || /[\s~^:?*[\]]/.test(branch)
    ) {
      throw new Error(`${label} is not a safe Git branch name`);
    }
  }
  if (action.oldBranch === action.newBranch) {
    throw new Error('set-default-branch oldBranch and newBranch must differ');
  }
}

async function readRemoteBranchCommit(action, exec) {
  const remoteUrl = githubRepositoryUrl(action.repo, action.githubHost);
  const { stdout } = await exec(
    'git',
    ['ls-remote', '--heads', remoteUrl, `refs/heads/${action.newBranch}`],
    { shell: false },
  );
  return stdout.trim().split(/\s+/)[0] ?? '';
}

export function createGitGithubAdapter(deps = {}) {
  const exec = deps.exec ?? run;
  return Object.freeze({
    name: NAME,
    actionTypes: Object.freeze([ActionType.GIT_PUSH, ActionType.GIT_TAG, ActionType.GITHUB_RELEASE, ActionType.SET_DEFAULT_BRANCH]),

    async preflight(action, context) {
      try {
        if (action.actionType === ActionType.GIT_PUSH) {
          const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: context.root, shell: false });
          const expected = action.branch ?? context.plan?.baseline?.defaultBranch ?? 'main';
          if (stdout.trim() !== expected) throw new Error(`current branch does not match ${expected}`);
        } else if (action.actionType === ActionType.GIT_TAG) {
          const { remoteUrl } = await validateTagAction(action, context, exec);
          const existing = await readRemoteTag(action, remoteUrl, exec);
          if (existing) throw new Error(`remote tag already exists: ${action.tag}; human intervention required`);
        } else if (action.actionType === ActionType.GITHUB_RELEASE) {
          if (!action.repo || !action.tag) throw new Error('github-release requires repo, tag, and commit');
          validateOid(action.commit);
          await exec('gh', ['auth', 'status'], {
            cwd: context.root,
            shell: false,
            env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' },
          });
          await exec('gh', ['api', `repos/${action.repo}`, '--jq', '.id'], {
            cwd: context.root,
            shell: false,
            env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' },
          }).catch((err) => {
            throw new Error(`cannot access GitHub repository ${action.repo}: ${err.message}`);
          });
          try {
            await exec('gh', ['api', `repos/${action.repo}/releases/tags/${action.tag}`], {
              cwd: context.root,
              shell: false,
              env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' },
            });
            throw new Error(`GitHub Release already exists for ${action.tag}; human intervention required`);
          } catch (err) {
            if (err.message?.includes('already exists')) throw err;
            if (!isNotFound(err)) throw new Error(`cannot determine GitHub Release uniqueness: ${err.message}`);
          }
        } else if (action.actionType === ActionType.SET_DEFAULT_BRANCH) {
          validateDefaultBranchAction(action);
          await exec('gh', ['auth', 'status'], {
            cwd: context.root,
            shell: false,
            env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' },
          });
          const { stdout: current } = await exec('gh', ['api', `repos/${action.repo}`, '--jq', '.default_branch'], {
            cwd: context.root,
            shell: false,
            env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' },
          });
          if (current.trim() !== action.oldBranch) {
            throw new Error(`default branch drift: expected ${action.oldBranch} but observed ${current.trim()}`);
          }
          const newBranchCommit = await readRemoteBranchCommit(action, exec);
          if (newBranchCommit && newBranchCommit !== action.expectedNewBranchCommit) {
            throw new Error(
              `new default branch commit drift: expected ${action.expectedNewBranchCommit} but observed ${newBranchCommit}`,
            );
          }
        } else {
          throw new Error(`unsupported action type: ${action.actionType}`);
        }
        return createResult({ actionType: action.actionType, status: ActionStatus.PREFLIGHT_PASSED });
      } catch (err) {
        return createResult({ actionType: action.actionType, status: ActionStatus.PREFLIGHT_FAILED, error: err.message });
      }
    },

    async execute(action, context) {
      assertWritesAuthorized(context, action.actionType);
      try {
        if (action.actionType === ActionType.GIT_PUSH) {
          await exec('git', ['push', action.remote ?? 'origin', action.branch ?? 'main'], {
            cwd: context.root,
            shell: false,
          });
        } else if (action.actionType === ActionType.GIT_TAG) {
          const { gitDir, remoteUrl } = await validateTagAction(action, context, exec);
          let localTag = '';
          try {
            const result = await exec('git', ['--git-dir', gitDir, 'rev-parse', `refs/tags/${action.tag}`], { shell: false });
            localTag = result.stdout.trim();
          } catch {
            localTag = '';
          }
          if (localTag && localTag !== action.commit) throw new Error('local frozen tag conflicts with planned commit');
          if (!localTag) {
            await exec('git', ['--git-dir', gitDir, 'tag', action.tag, action.commit], { shell: false });
          }
          await exec('git', [
            '--git-dir', gitDir,
            'push',
            `--force-with-lease=refs/tags/${action.tag}:`,
            remoteUrl,
            `refs/tags/${action.tag}`,
          ], { shell: false });
        } else if (action.actionType === ActionType.GITHUB_RELEASE) {
          await exec('gh', [
            'release', 'create', action.tag,
            '--repo', ghRepo(action),
            '--verify-tag',
            '--title', action.name ?? `Release ${action.tag}`,
            '--notes', action.notes ?? `Release ${action.tag}`,
          ], { cwd: context.root, shell: false, env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' } });
        } else if (action.actionType === ActionType.SET_DEFAULT_BRANCH) {
          validateDefaultBranchAction(action);
          const { stdout: current } = await exec('gh', ['api', `repos/${action.repo}`, '--jq', '.default_branch'], {
            cwd: context.root,
            shell: false,
            env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' },
          });
          if (current.trim() !== action.oldBranch) {
            throw new Error(`default branch drift immediately before update: expected ${action.oldBranch} but observed ${current.trim()}`);
          }
          const newBranchCommit = await readRemoteBranchCommit(action, exec);
          if (newBranchCommit !== action.expectedNewBranchCommit) {
            throw new Error(
              `new default branch commit drift immediately before update: expected ${action.expectedNewBranchCommit} but observed ${newBranchCommit || 'missing'}`,
            );
          }
          await exec('gh', ['api', `repos/${action.repo}`, '-X', 'PATCH', '-f', `default_branch=${action.newBranch}`], {
            cwd: context.root,
            shell: false,
            env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' },
          });
        } else {
          throw new Error(`unsupported action type: ${action.actionType}`);
        }
        return createResult({ actionType: action.actionType, status: ActionStatus.EXECUTED });
      } catch (err) {
        return createResult({ actionType: action.actionType, status: ActionStatus.EXECUTE_FAILED, error: err.message });
      }
    },

    async observe(action, context) {
      try {
        let observation;
        if (action.actionType === ActionType.GIT_PUSH) {
          const { stdout } = await exec('git', ['ls-remote', '--heads', action.remote ?? 'origin', action.branch ?? 'main'], {
            cwd: context.root,
            shell: false,
          });
          observation = { remoteCommit: stdout.trim().split(/\s+/)[0] ?? '' };
        } else if (action.actionType === ActionType.GIT_TAG) {
          const { remoteUrl } = await validateTagAction(action, context, exec);
          observation = { tag: action.tag, commit: await readRemoteTag(action, remoteUrl, exec) };
        } else if (action.actionType === ActionType.GITHUB_RELEASE) {
          const { stdout } = await exec('gh', [
            'release', 'view', action.tag,
            '--repo', ghRepo(action),
            '--json', 'tagName,url',
          ], { cwd: context.root, shell: false, env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' } });
          const release = JSON.parse(stdout);
          const commitResult = await exec(
            'gh',
            ['api', `repos/${action.repo}/git/ref/tags/${action.tag}`, '--jq', '.object.sha'],
            { cwd: context.root, shell: false, env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' } },
          );
          observation = { tag: release.tagName, commit: commitResult.stdout.trim(), releaseUrl: release.url };
        } else if (action.actionType === ActionType.SET_DEFAULT_BRANCH) {
          validateDefaultBranchAction(action);
          const { stdout: current } = await exec('gh', ['api', `repos/${action.repo}`, '--jq', '.default_branch'], {
            cwd: context.root,
            shell: false,
            env: { ...process.env, GH_HOST: action.githubHost ?? 'github.com' },
          });
          observation = {
            defaultBranch: current.trim(),
            newBranchCommit: await readRemoteBranchCommit(action, exec),
          };
        } else {
          throw new Error(`unsupported action type: ${action.actionType}`);
        }
        return createResult({ actionType: action.actionType, status: ActionStatus.OBSERVED, observation });
      } catch (err) {
        if (action.actionType === ActionType.GITHUB_RELEASE && isNotFound(err)) {
          return createResult({
            actionType: action.actionType,
            status: ActionStatus.OBSERVED,
            observation: { exists: false },
          });
        }
        return createResult({ actionType: action.actionType, status: ActionStatus.OBSERVED, observation: {}, error: err.message });
      }
    },

    async verify(action, context) {
      const observed = await this.observe(action, context);
      if (observed.error) return createResult({ actionType: action.actionType, status: ActionStatus.VERIFY_FAILED, observation: observed.observation, error: observed.error });
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
