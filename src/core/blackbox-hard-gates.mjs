/**
 * README 黑盒测试独立硬门纯函数。
 *
 * 供 runner（run-readme-blackbox.mjs）和单测使用，用于独立验证
 * maintainer persona 产生的 workspace 产物，不信任 persona 自报布尔值。
 *
 * @module blackbox-hard-gates
 */

import { validateVersionConsistency } from './version-consistency.mjs';
import { validatePlanActionCompleteness } from './plan.mjs';

/**
 * 验证 project.yaml 配置中的 release unit 属性。
 *
 * @param {object} config - 已解析的 project.yaml 对象
 * @param {object} expectations
 * @param {string} expectations.expectedUnitId - 预期 unit id（如 'my-plugin'）
 * @param {string} expectations.expectedSource - 预期 source 路径（如 'packages/my-plugin'）
 * @param {string} expectations.expectedVersionSource - 预期 version.source（如 'package.json'）
 * @param {string} [expectations.expectedPublicRepo] - 预期 publicRepo
 * @param {string} [expectations.expectedTagTemplate] - 预期 tagTemplate
 * @param {string[]} [expectations.expectedDistributionTypes] - 预期 distribution types
 * @returns {{ passed: boolean, failures: string[] }}
 */
export function verifyMaintainerConfig(config, expectations) {
  const failures = [];
  const {
    expectedUnitId,
    expectedSource,
    expectedVersionSource,
    expectedPublicRepo,
    expectedTagTemplate,
    expectedDistributionTypes,
  } = expectations;

  if (!config || typeof config !== 'object') {
    return { passed: false, failures: ['config is null or not an object'] };
  }

  const units = config.releaseUnits;
  if (!Array.isArray(units) || units.length === 0) {
    failures.push('releaseUnits is missing or empty');
    return { passed: false, failures };
  }

  const unit = units.find(u => u.id === expectedUnitId);
  if (!unit) {
    failures.push(`unit "${expectedUnitId}" not found in releaseUnits`);
  } else {
    if (unit.source !== expectedSource) {
      failures.push(`unit "${expectedUnitId}" source is ${JSON.stringify(unit.source)}, expected ${JSON.stringify(expectedSource)}`);
    }
    const versionSource = unit.version?.source;
    if (versionSource !== expectedVersionSource) {
      failures.push(`unit "${expectedUnitId}" version.source is ${JSON.stringify(versionSource)}, expected ${JSON.stringify(expectedVersionSource)}`);
    }
    // publicRepo
    if (expectedPublicRepo && unit.publicRepo !== expectedPublicRepo) {
      failures.push(`unit "${expectedUnitId}" publicRepo is ${JSON.stringify(unit.publicRepo)}, expected ${JSON.stringify(expectedPublicRepo)}`);
    }
    // tagTemplate
    if (expectedTagTemplate && unit.version?.tagTemplate !== expectedTagTemplate) {
      failures.push(`unit "${expectedUnitId}" version.tagTemplate is ${JSON.stringify(unit.version?.tagTemplate)}, expected ${JSON.stringify(expectedTagTemplate)}`);
    }
    // distributions
    if (expectedDistributionTypes) {
      const actualTypes = (unit.distributions ?? []).map(d => d.type).sort();
      const sorted = [...expectedDistributionTypes].sort();
      if (JSON.stringify(actualTypes) !== JSON.stringify(sorted)) {
        failures.push(`unit "${expectedUnitId}" distribution types are ${JSON.stringify(actualTypes)}, expected ${JSON.stringify(sorted)}`);
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * 验证冻结发布计划的一致性。
 *
 * 两个独立门：
 * 1. 版本/tag 精确校验（validateVersionConsistency）
 * 2. 动作完整性校验（validatePlanActionCompleteness）
 *
 * @param {object} plan - 已解析的 release-plan.json 对象
 * @param {object} expectations
 * @param {string} expectations.expectedUnitId - 预期 unit id
 * @param {string} expectations.expectedVersion - 预期版本号
 * @returns {{ passed: boolean, failures: string[], details: object }}
 */
export function verifyPlanConsistency(plan, expectations) {
  const { expectedUnitId, expectedVersion } = expectations;

  // Gate 1: Version/tag exact consistency
  const versionResult = validateVersionConsistency(plan, expectedVersion, {
    expectedUnitId,
  });

  // Gate 2: Action completeness (every unit has its required actions)
  const actionResult = validatePlanActionCompleteness(plan);

  const allFailures = [
    ...versionResult.details.failures,
    ...actionResult.details.failures,
  ];

  return {
    passed: versionResult.passed && actionResult.passed,
    failures: allFailures,
    details: {
      unitCount: versionResult.details.unitCount,
      actionCount: versionResult.details.actionCount,
      expectedActionCount: actionResult.details.expectedCount,
      actualActionCount: actionResult.details.actualCount,
      versionGatePassed: versionResult.passed,
      actionCompletenessGatePassed: actionResult.passed,
    },
  };
}

/**
 * 计算 README 黑盒测试总体结论。
 *
 * 每个 persona 必须同时满足 success === true 和 verdict === 'PASS'，
 * 总体才为 PASS。persona 自报 verdict=PASS 但 success=false 时，
 * 总体必须 FAIL。
 *
 * @param {Array<{ success: boolean, verdict: string }>} personaResults
 * @returns {{ overall_verdict: 'PASS'|'FAIL', pass_count: number, fail_count: number }}
 */
export function computeOverallVerdict(personaResults) {
  const passCount = personaResults.filter(
    r => r.success === true && r.verdict === 'PASS',
  ).length;
  const failCount = personaResults.length - passCount;
  return {
    overall_verdict: failCount === 0 && personaResults.length > 0 ? 'PASS' : 'FAIL',
    pass_count: passCount,
    fail_count: failCount,
  };
}
