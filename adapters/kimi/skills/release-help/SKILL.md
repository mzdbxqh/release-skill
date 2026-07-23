---
name: release-help
description: "Discoverable entry point for release-skill: dependency and environment checks, capability overview, minimal examples, read-only diagnosis, dry-run guidance, and failure triage"
---

> **Kimi Code 安装入口解析协议**：Kimi Code 官方技能契约提供正文占位符 `${KIMI_SKILL_DIR}`，宿主在向 Agent 发送正文前会将其展开为当前 `SKILL.md` 所在目录的绝对路径。必须把展开后的字面量作为当前技能目录的唯一权威输入，记为 `SKILL_DIR`。
> 禁止从工作目录、可执行搜索路径、源码仓库、shell 调用上下文或任何未记载的宿主元数据路径猜测技能目录。若正文中的 `${KIMI_SKILL_DIR}` 未被宿主展开（仍是字面量占位符），立即停止并报告安装定位失败。
> 对 `SKILL_DIR` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-help

## 触发

用户询问如何使用 release-skill、发布流程是什么、或请求只读诊断和 dry-run 安全检查。

## 职责

- 依赖和环境检查：Node.js >= 22、Git 决定本地准备就绪度；npm/gh 另行决定生产依赖就绪度
- 能力说明：缺少配置时走 `help → setup → assess`；已有配置的安全默认路径是 `help → assess → prepare --offline`；已有公开版本的生产闭环是显式的 `prepare --online --production → approve → publish → verify`
- 最小示例：展示从 release-help 到 release-assess 的最短路径
- 只读诊断：运行 dry-run 检查，不修改任何文件
- 故障引导：根据错误码指向对应的修复 Skill

**阶段通过规则**: `status` 与 `readiness.localPreparation.status` 只判断本地 help/assess/prepare；其充要条件是 `READY` 且 exit code 为 0。`missingRequired` 列出缺失的 Node/Git。生产发布必须另外读取 `readiness.productionPublish`：缺少 npm/gh 时为 `NOT_READY`，依赖存在时仍是 `AUTH_CHECK_REQUIRED`，因为 help 不访问网络、不验证认证。Agent 无权把本地就绪解释为生产就绪。

**边界**: help 不修改文件系统、不执行外部写操作、不生成发布计划。优先探测 PATH 上的全局安装命令 `release-skill`，不可用时回退到源码路径。每个 unit 必须配置 `previousPublicBaseline`：首次发布且确认无前序版本用 none，已有版本用 bound + repo/ref/commit；none 不是绕过 publish 唯一性预检的开关。v0.1.1 已完成 GitHub/npm 真实生产发布、冻结 Git ref 的 Claude/Codex 消费者安装、精确 npm 安装 smoke 与最终 VERIFIED；生产等价本地协议套件继续覆盖 fake gh/npm/Claude/Codex 和本地 bare Git。测试未做 OS 级禁网，且一次成功发布不能证明其他项目的认证、权限、限流或最终一致性行为；每个项目的首次生产发布仍应作为受监控 canary。

## 正向执行路径

1. 使用插件根相对路径运行 CLI：`node "$RELEASE_SKILL_ENTRY" help --json`
2. 检查 `readiness.localPreparation`；需要生产发布时再检查 `readiness.productionPublish`
3. 若环境就绪且缺少 `.release-skill/project.yaml`，先路由 `release-setup`；配置已存在才运行 `release-assess`
4. 默认在审阅本地计划和快照后停止；只有用户明确要求且完成摘要审批时才路由到 `release-publish`

## 确定性脚本调用

```bash
# 从插件根运行（自包含 bundle，无需 node_modules）
node "$RELEASE_SKILL_ENTRY" help --json
node "$RELEASE_SKILL_ENTRY" setup --root <path> --json
node "$RELEASE_SKILL_ENTRY" assess --root <path> --offline --json
# 发布文档刷新：默认只读演练
node "$RELEASE_SKILL_ENTRY" docs refresh --unit <id> --json
# 摘要确认后的本地写入（三项绑定缺一不可）
node "$RELEASE_SKILL_ENTRY" docs refresh --unit <id> \
  --write --confirm-refresh <refreshDigest> --ack-local-document-write --json
```

## 发布文档刷新（docs refresh）

发布单元配置 `releaseDocuments` 后，一份结构化双语说明源可确定性刷新 README 受管区域、唯一版本标记的机器值和 CHANGELOG 当前版本受管条目。核心 CLI 不联网、不调用大模型、不自动翻译；只改写声明过的受管区域、版本标记机器值和当前受管条目，区域外字节逐字保留。`prepare` 只检查新鲜度，不写工作树。

- **配置**：`releaseDocuments.notesSource`（说明源路径，只允许 `{version}` 占位符与 `.yaml`/`.yml`/`.json` 后缀）、`locales`（如 `[en, zh-CN]`）、`changelogs`（path + locale）、`readmes`（path + locale + `regions` 受管区域 id + `versionMarkers` 版本标记模式）。版本标记模式必须与 README 现有唯一标记精确匹配，`{version}` 代表机器版本值，刷新只替换该值；零次或多次匹配失败关闭。
- **说明源**：`version` 必须与单元版本精确一致，`date` 为 `YYYY-MM-DD`，每个配置语种恰好出现一次且 `summary`、变更项非空，`security`/`breaking`/`added`/`changed`/`deprecated`/`removed`/`fixed` 至少一个类别含条目。YAML alias、重复键、未知字段和语种回退都失败关闭。
- **只读演练**：`docs refresh --unit <id> --json` 输出逐文件相对路径、locale、新旧摘要、`version`、`locales`、`inputDigest`、`refreshDigest` 和 `nextCommand.argv`；候选无变化时 `status: "clean"`。
- **确认写入**：必须同时提供 `--write`、精确 `--confirm-refresh <refreshDigest>` 和 `--ack-local-document-write`，全部目标作为一个事务提交；成功后立即复演必须为 `clean`。

**授权边界**：本地发布文档写入授权只覆盖声明的本地文档目标，不是 hook、Git 提交、push、publish 或安装的授权。写入后必须审阅、提交，再重新 prepare。

## 故障路由

| 场景 | 处理 |
|---|---|
| Node.js 版本不足 | `status: "NOT_READY"`, `missingRequired` 含 `"node>=22"`；提示升级至 >= 22 |
| Git 未安装 | `status: "NOT_READY"`, `missingRequired` 含 `"git"`；提示安装 Git |
| pnpm 未安装 | 不影响本地准备；仅出现在 recommendations 中 |
| npm/gh 未安装 | 本地准备仍可就绪，但 `readiness.productionPublish.status` 为 `NOT_READY` |
| npm/gh 已安装 | 生产状态仍为 `AUTH_CHECK_REQUIRED`；发布前验证 `gh auth`、Git HTTPS credential 和 npm auth |
| CLI 入口不存在 | 确认 `$RELEASE_SKILL_ENTRY` 存在；不存在时重新安装插件 |
| 项目配置不存在 | 路由 `release-setup`，默认只读；不得直接生成或覆盖 README/配置 |
| assess 失败 | 运行 `node "$RELEASE_SKILL_ENTRY" assess --offline --json` 获取详情 |
| 请求生产发布 | 已有公开版本先调用 `release-prepare --online --production` 观察 bound 基线；人工审阅后再路由 `release-publish` |
| RELEASE_DOCS_INVALID | 配置或说明源语义非法（重复键、alias、未知字段、版本漂移等）；修正配置或说明源后重新演练 |
| RELEASE_DOCS_TRANSLATION_MISSING | 配置语种缺失或多余；补齐说明源语种，与 `releaseDocuments.locales` 完全一致，不得回退 |
| RELEASE_DOCS_CONFLICT | 目标含非受管同版本条目、受管标记损坏或人工冲突；人工修复目标并保留人工修改后重新演练 |
| RELEASE_DOCS_REFRESH_STALE | 确认绑定后候选已变化；重新演练取得新 `refreshDigest` 再确认写入 |
| RELEASE_DOCS_STALE | prepare 检测到文档未刷新；按 `docs refresh` → 审阅 → 提交 → 重新 prepare 恢复 |

## 后续引导

本地准备就绪后下一步运行 `release-assess`：`node "$RELEASE_SKILL_ENTRY" assess`。生产发布还要求 npm、gh 可用，并在发布前另行完成认证检查。
