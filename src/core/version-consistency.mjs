/**
 * 版本一致性校验纯函数 — 供 blackbox runner 和单测使用。
 *
 * 给定 release plan JSON 和预期版本字符串，检查：
 * 1. plan.status === 'PREPARED'
 * 2. plan 至少有一个 release unit
 * 3. 若指定 expectedUnitId，该 unit 必须存在且 targetVersion === expectedVersion
 * 4. 每个 unit 的 targetVersion === expectedVersion
 * 5. 每个带 parameters.version 的 action === expectedVersion
 * 6. 每个带 expected.version 的 action === expectedVersion
 * 7. 每个带 expected.tag 的 action：必须通过 unitId 找到 unit，
 *    unit 必须有合法 tagTemplate，然后只做模板展开后的精确相等；
 *    否则失败。不做子串匹配。
 *
 * @param {object} plan - 解析后的 release plan JSON
 * @param {string} expectedVersion - 预期版本号
 * @param {object} [options] - 可选参数
 * @param {string} [options.expectedUnitId] - 必须存在的 unit id
 * @returns {{ passed: boolean, details: object }}
 */
export function validateVersionConsistency(plan, expectedVersion, options = {}) {
  const failures = [];

  // 1. plan status
  if (!plan || typeof plan !== 'object') {
    return { passed: false, details: { failures: ['plan is null or not an object'], expectedVersion } };
  }
  if (plan.status !== 'PREPARED') {
    failures.push(`plan.status is ${JSON.stringify(plan.status)}, expected PREPARED`);
  }

  // 2. plan must have at least one release unit (must be an array)
  const rawUnits = plan.units;
  const units = Array.isArray(rawUnits) ? rawUnits : [];
  if (!Array.isArray(rawUnits)) {
    failures.push(`plan.units is ${JSON.stringify(rawUnits)}, expected an array`);
  }
  if (units.length === 0) {
    failures.push('plan has no release units; at least one unit is required');
  }

  // 3. expectedUnitId validation (if specified)
  const { expectedUnitId } = options;
  if (expectedUnitId) {
    const found = units.find(u => u.id === expectedUnitId);
    if (!found) {
      failures.push(`expected unit "${expectedUnitId}" not found in plan units`);
    } else if (found.targetVersion !== expectedVersion) {
      failures.push(`expected unit "${expectedUnitId}" targetVersion is ${JSON.stringify(found.targetVersion)}, expected ${expectedVersion}`);
    }
  }

  // 4. unit versions
  for (const unit of units) {
    if (unit.targetVersion !== expectedVersion) {
      failures.push(`unit "${unit.id ?? '(unknown)'}" targetVersion is ${JSON.stringify(unit.targetVersion)}, expected ${expectedVersion}`);
    }
  }

  // 5. action parameters.version & expected.version (externalActions must be an array)
  const rawActions = plan.externalActions;
  const actions = Array.isArray(rawActions) ? rawActions : [];
  if (!Array.isArray(rawActions)) {
    failures.push(`plan.externalActions is ${JSON.stringify(rawActions)}, expected an array`);
  }

  // Build unit -> tagTemplate map for exact tag validation
  const unitTagTemplates = new Map();
  for (const unit of units) {
    if (unit.id && unit.tagTemplate) {
      unitTagTemplates.set(unit.id, unit.tagTemplate);
    }
  }

  for (const action of actions) {
    if (action.parameters?.version != null && action.parameters.version !== expectedVersion) {
      failures.push(`action "${action.id}" parameters.version is ${JSON.stringify(action.parameters.version)}, expected ${expectedVersion}`);
    }
    if (action.expected?.version != null && action.expected.version !== expectedVersion) {
      failures.push(`action "${action.id}" expected.version is ${JSON.stringify(action.expected.version)}, expected ${expectedVersion}`);
    }
    // 7. tag must match exactly via template expansion — no substring matching.
    const tag = action.expected?.tag;
    if (tag) {
      if (!action.unitId) {
        failures.push(`action "${action.id}" has expected.tag but no unitId; unitId is required for tag validation`);
      } else {
        const tagTemplate = unitTagTemplates.get(action.unitId);
        if (!tagTemplate) {
          failures.push(`action "${action.id}" unit "${action.unitId}" has no tagTemplate; tagTemplate is required for tag validation`);
        } else {
          const expectedTag = tagTemplate.replace('{version}', expectedVersion);
          if (tag !== expectedTag) {
            failures.push(`action "${action.id}" expected.tag ${JSON.stringify(tag)} does not match expanded template ${JSON.stringify(expectedTag)} (exact match required)`);
          }
        }
      }
    }
  }

  return {
    passed: failures.length === 0,
    details: {
      expectedVersion,
      expectedUnitId: expectedUnitId ?? null,
      unitCount: units.length,
      actionCount: actions.length,
      failures,
    },
  };
}
