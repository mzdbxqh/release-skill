---
name: release-help
description: "Discoverable entry point for release-skill: dependency and environment checks, capability overview, minimal examples, read-only diagnosis, dry-run guidance, and failure triage"
---

# release-help

## 触发

用户询问如何使用 release-skill、发布流程是什么、或请求只读诊断和 dry-run 安全检查。

## 职责

- 依赖和环境检查：Node.js >= 22、Git 决定本地准备就绪度；npm/gh 另行决定生产依赖就绪度
- 能力说明：安全默认路径是 `help → assess → prepare --offline`；生产闭环是显式的 `prepare --production → approve → publish → verify`
- 最小示例：展示从 release-help 到 release-assess 的最短路径
- 只读诊断：运行 dry-run 检查，不修改任何文件
- 故障引导：根据错误码指向对应的修复 Skill

**阶段通过规则**: `status` 与 `readiness.localPreparation.status` 只判断本地 help/assess/prepare；其充要条件是 `READY` 且 exit code 为 0。`missingRequired` 列出缺失的 Node/Git。生产发布必须另外读取 `readiness.productionPublish`：缺少 npm/gh 时为 `NOT_READY`，依赖存在时仍是 `AUTH_CHECK_REQUIRED`，因为 help 不访问网络、不验证认证。Agent 无权把本地就绪解释为生产就绪。

**边界**: help 不修改文件系统、不执行外部写操作、不生成发布计划。npm 包尚未发布，不假定全局命令可用。GitHub/npm、Claude/Codex marketplace 隔离安装、精确 npm 安装 smoke 与最终 VERIFIED 已通过真实 release-skill CLI + 本地 bare Git + fake gh/npm/Claude/Codex 的生产等价协议沙箱；另有隔离的已安装消费者 CLI 探针。测试未做 OS 级禁网，也未访问真实 marketplace；真实认证/API canary 尚未执行。

## 正向执行路径

1. 设置 `RELEASE_SKILL_HOME` 指向 release-skill checkout 根目录
2. 运行 `node "$RELEASE_SKILL_HOME/..." help --json` 检查环境
3. 检查 `readiness.localPreparation`；需要生产发布时再检查 `readiness.productionPublish`
4. 若环境就绪，运行 `release-assess` 识别项目拓扑
5. 默认在审阅本地计划和快照后停止；只有用户明确要求且完成摘要审批时才路由到 `release-publish`

## 确定性脚本调用

```bash
RELEASE_SKILL_HOME=/path/to/release-skill
node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help --json
node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" assess --root <path> --offline --json
```

## 故障路由

| 场景 | 处理 |
|---|---|
| Node.js 版本不足 | `status: "NOT_READY"`, `missingRequired` 含 `"node>=22"`；提示升级至 >= 22 |
| Git 未安装 | `status: "NOT_READY"`, `missingRequired` 含 `"git"`；提示安装 Git |
| pnpm 未安装 | 不影响本地准备；仅出现在 recommendations 中 |
| npm/gh 未安装 | 本地准备仍可就绪，但 `readiness.productionPublish.status` 为 `NOT_READY` |
| npm/gh 已安装 | 生产状态仍为 `AUTH_CHECK_REQUIRED`；发布前验证 `gh auth`、Git HTTPS credential 和 npm auth |
| CLI 入口不存在 | 提示设置 `RELEASE_SKILL_HOME`；不假定裸命令或 PATH |
| assess 失败 | 运行 `node "$RELEASE_SKILL_HOME/..." assess --offline --json` 获取详情 |
| 请求生产发布 | 先调用 `release-prepare --production`，人工审阅后再路由 `release-publish` |

## 后续引导

本地准备就绪后下一步运行 `release-assess`。生产发布还要求 npm、gh 可用，并在发布前另行完成认证检查。
