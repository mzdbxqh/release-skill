# 06 -- Adapter 契约

本文档定义 release-skill adapter 的接口规范、外部写授权门和幂等重试机制。状态机见 `01-state-machine.md`，安全要求见 `04-supply-chain.md`，错误码见 `05-evidence-and-errors.md`。

---

## 1. Adapter 接口

每个 adapter 必须实现以下四个方法。所有 adapter 遵循同一接口契约，由 adapter registry 统一调度。

### 1.1 preflight(action, context)

- **职责**：在执行外部写操作前检查远端状态，确认操作可安全执行。
- **时机**：在 `publish` 命令执行每个检查点之前调用。
- **输入**：`action` 描述待执行的外部操作，`context` 包含冻结计划、批准记录和授权标志。
- **输出**：结构化观察结果，包含远端当前状态和是否可安全执行。
- **失败处理**：preflight 失败时不执行后续操作，返回 `REMOTE_CONFLICT` 或 `AUTH_MISSING`。

### 1.2 execute(action, context)

- **职责**：执行外部写操作。
- **前置条件**：`context.externalWritesAuthorized === true`，即批准记录有效且未过期。
- **输入**：`action` 描述待执行的外部操作，`context` 包含冻结计划和授权信息。
- **输出**：结构化执行结果，包含远端资源标识（commit hash、tag、包版本等）。
- **安全约束**：若授权标志为 false，execute 必须拒绝执行并返回 `AUTH_MISSING`。

### 1.3 observe(action, context)

- **职责**：查询远端实际状态，与冻结计划对比。
- **时机**：在 `reconcile` 和 `verify` 阶段调用，也用于 `execute` 后的即时验证。
- **输入**：`action` 描述已计划的外部操作，`context` 包含冻结计划。
- **输出**：远端实际状态和与计划的一致性判断。
- **一致性判断**：
  - `CONSISTENT`：远端状态与计划完全匹配。
  - `MISSING`：远端资源尚未创建。
  - `CONFLICTING`：远端资源存在但与计划不匹配。

### 1.4 verify(action, context)

- **职责**：对外部写操作的结果进行深度验证。
- **时机**：在 `verify` 阶段调用。
- **输入**：`action` 描述已执行的外部操作，`context` 包含冻结计划和执行记录。
- **输出**：验证结果，包括 integrity、provenance、签名状态等。
- **验证范围**：
  - Git tag 指向正确的 commit。
  - GitHub Release 内容与计划一致。
  - npm 包的 integrity 和 provenance 有效。
  - 插件清单可被 marketplace 发现。
  - 公开仓库通过泄漏审计。

---

## 2. 标准 Adapter 列表

### 2.1 Git/GitHub Adapter

| 操作 | 方法 | 说明 |
|---|---|---|
| 推送版本提交 | execute | 推送已批准的父工程版本提交 |
| 推送子仓库快照 | execute | 更新并推送公开子仓库快照 |
| 创建签名 tag | execute | 创建并推送签名或可追溯 tag |
| 创建 GitHub Release | execute | 基于冻结计划创建 Release |
| 查询 tag 状态 | observe | 检查 tag 是否存在及指向 |
| 查询 Release 状态 | observe | 检查 Release 是否存在及内容 |
| 验证 tag 指向 | verify | 确认 tag 指向正确的 commit |

工具：`git` CLI 和 `gh` CLI，使用 `execFile` 参数数组调用。

### 2.2 npm Adapter

| 操作 | 方法 | 说明 |
|---|---|---|
| 发布 npm 包 | execute | 使用 `npm publish --provenance --access public` |
| 查询版本状态 | observe | 使用 `npm view` 检查版本是否存在 |
| 验证 integrity | verify | 验证包的 integrity hash 和 provenance 状态 |

工具：`npm` CLI，使用 `execFile` 参数数组调用。

### 2.3 插件 Marketplace Adapter

| 操作 | 方法 | 说明 |
|---|---|---|
| 注册插件 | execute | 在 marketplace 注册插件清单 |
| 查询插件状态 | observe | 检查插件是否可被发现 |
| 验证安装性 | verify | 在全新环境中安装并验证插件可调用 |

支持目标：Claude Code plugin marketplace、Codex plugin manifest/marketplace。

---

## 3. 外部写授权门

### 3.1 授权要求

所有 adapter 的 `execute` 方法必须在以下条件全部满足时才能执行外部写操作：

1. 发布计划已冻结且 schema 验证通过。
2. 发布计划摘要与批准记录中的摘要匹配。
3. 批准记录存在且未超过 24 小时有效期。
4. Git tree hash 与批准记录中的匹配。
5. 目标版本与批准记录中的匹配。
6. 远端无冲突状态（preflight 通过）。
7. `context.externalWritesAuthorized === true`。

任一条件不满足时，execute 返回对应错误码（`AUTH_MISSING`、`BASELINE_CHANGED`、`REMOTE_CONFLICT` 等）并拒绝执行。

### 3.2 批准记录结构

```json
{
  "planDigest": "<sha256>",
  "baseline": {
    "gitTreeHash": "<sha256>"
  },
  "targetVersion": "1.0.0",
  "approvedActions": ["push-snapshot", "create-tag", "npm-publish", "github-release"],
  "actor": "maintainer",
  "approvedAt": "2026-07-15T12:00:00.000Z",
  "expiresAt": "2026-07-16T12:00:00.000Z"
}
```

- `approvedActions` 不得包含通配符。
- `expiresAt` 不得晚于 `approvedAt` + 24 小时。

---

## 4. 幂等重试

### 4.1 幂等规则

- `reconcile` 阶段首先通过 `observe` 查询所有计划操作的远端状态。
- 状态为 `CONSISTENT` 的操作幂等跳过，不重新执行。
- 状态为 `MISSING` 的操作安全重试。
- 状态为 `CONFLICTING` 的操作停止并返回 `REMOTE_CONFLICT`，要求人工决策。

### 4.2 重试安全约束

- 系统不得自动删除远端 tag。
- 系统不得覆盖已存在的 GitHub Release。
- 系统不得 unpublish npm 包。
- 系统不得从头重跑已完成的发布。
- 重试仅限于安全且未完成的步骤。

### 4.3 检查点记录

每个外部操作的执行结果作为检查点写入证据目录（见 `05-evidence-and-errors.md`）。检查点包含：

- 操作标识和类型。
- 执行前的 `observe` 结果。
- 执行结果（成功/失败/跳过）。
- 执行后的 `observe` 验证结果。
- 远端资源标识（commit、tag、版本、URL）。

---

## 5. 发布 Saga 执行流程

`publish` 命令按以下顺序执行：

1. 重新验证发布计划 schema。
2. 重新验证发布计划摘要。
3. 检查批准记录是否过期。
4. 检查 Git tree hash 是否变化。
5. 执行远程 preflight。
6. 按批准的操作列表顺序执行每个检查点。
7. 每个检查点：preflight -> execute -> observe -> 记录。
8. 任一检查点失败时停止后续动作，计算 PARTIAL（若已有成功检查点）。
9. 所有检查点成功后进入 PUBLISHED 状态。

---

## 6. 跨标准引用

- 状态机中的 PUBLISHING、PARTIAL、PUBLISHED 和 VERIFIED 状态见 `01-state-machine.md`。
- 配置中的 hook 和安全策略见 `02-project-config.md`。
- 供应链安全中的 provenance、签名和最小权限见 `04-supply-chain.md`。
- 证据目录结构和事件格式见 `05-evidence-and-errors.md`。
