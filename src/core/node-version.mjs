/**
 * Node.js 版本解析、最低版本检查和 readiness 状态纯函数。
 *
 * @module core/node-version
 */

/**
 * 解析 Node.js --version 输出（如 "v24.0.0"），返回主版本号。
 * @param {string} versionString
 * @returns {number|null} major version number, or null if unparseable
 */
export function parseNodeMajor(versionString) {
  if (!versionString || typeof versionString !== 'string') return null;
  const match = versionString.trim().match(/^v(\d+)\./);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * 判断给定的 Node.js 主版本号是否满足最低要求。
 * @param {number|null} major
 * @param {number} minimum
 * @returns {boolean}
 */
export function meetsMinimum(major, minimum = 22) {
  if (major == null || typeof major !== 'number') return false;
  return major >= minimum;
}

/**
 * 计算环境就绪状态。
 *
 * Required（不满足 → NOT_READY）：
 * - Node.js >= 22
 * - Git
 *
 * Optional（不影响 READY/NOT_READY）：
 * - pnpm / npm / gh
 *
 * @param {object} checks - 环境检查结果（来自 performEnvironmentChecks）
 * @param {boolean} checks.nodeAvailable - Node.js 是否可用
 * @param {boolean} checks.nodeMeetsMinimum - Node.js 版本 >= 22
 * @param {boolean} checks.gitAvailable - Git 是否可用
 * @returns {{ status: 'READY'|'NOT_READY', requiredMet: boolean, missingRequired: string[] }}
 */
export function computeReadinessStatus(checks) {
  const missingRequired = [];

  if (!checks.nodeAvailable) {
    missingRequired.push('node');
  } else if (!checks.nodeMeetsMinimum) {
    missingRequired.push('node>=22');
  }

  if (!checks.gitAvailable) {
    missingRequired.push('git');
  }

  const requiredMet = missingRequired.length === 0;
  return {
    status: requiredMet ? 'READY' : 'NOT_READY',
    requiredMet,
    missingRequired,
  };
}
