# 05 -- 证据与错误

本文档定义 release-skill 的稳定错误码、JSON/JSONL 事件格式、脱敏规则和证据目录结构。状态机见 `01-state-machine.md`，配置约束见 `02-project-config.md`。

---

## 1. 稳定错误码

以下列出用户最常遇到的稳定错误码。实现中的完整列表由 `src/core/errors.mjs` 维护；已发布错误码不得重命名或删除。

| 错误码 | 含义 | 触发场景 | 典型恢复 |
|---|---|---|---|
| `CONFIG_INVALID` | 配置文件格式或内容不合法 | YAML 语法错误、schema 校验失败、路径逃逸、hook 不合规 | 修正配置文件后重新运行 |
| `BASELINE_CHANGED` | 发布计划冻结后 Git tree 发生变化 | 有文件被修改、新增或删除导致 tree hash 不匹配 | 重新运行 `prepare` 冻结新基线 |
| `DIRTY_SCOPE_CONFLICT` | 工作目录存在未提交变更且可能影响发布范围 | dirty 文件与发布单元的源码路径重叠 | 提交或暂存变更后重试 |
| `GATE_FAILED` | 发布门（构建、测试、lint、文档验证等）未通过 | hook 返回非零退出码 | 修复失败项后重新运行 `prepare` |
| `AUTH_MISSING` | 缺少必要的认证凭据或权限 | GitHub token 未配置、npm 登录缺失、marketplace 凭据不足 | 配置凭据后重试 |
| `REMOTE_CONFLICT` | 远端资源状态与冻结计划不一致 | tag 已存在但指向不同 commit、npm 版本已发布、Release 已存在且内容不同 | 人工检查远端状态并决定处理方式 |
| `HOOK_TIMEOUT` | 项目 hook 执行超时 | hook 运行时间超过 `timeoutMs` 配置 | 增加超时值或优化 hook 执行效率 |
| `PARTIAL_RELEASE` | 发布部分成功 | 至少一个外部检查点成功但后续检查点失败 | 使用 `reconcile` 从检查点恢复 |
| `POST_PUBLISH_VERIFY_FAILED` | 发布后验证未通过 | 安装测试失败、泄漏审计未通过、provenance 验证失败 | 检查失败原因，可能需要人工干预 |
| `SETUP_DIGEST_MISMATCH` | setup 事实或答案已漂移 | dry-run 后 README/package/manifest/remote/answers 发生变化，或确认摘要错误 | 重新运行 setup dry-run、审阅并确认新摘要 |
| `CONFIG_EXISTS` | setup 目标配置已经存在 | 写入模式试图创建已有 `.release-skill/project.yaml` | 不覆盖；运行 assess 并人工增量编辑 |

---

## 2. JSON/JSONL 事件格式

### 2.1 事件结构

每次执行产生 JSONL 格式的事件流，每个事件为一行 JSON 对象。

```json
{
  "schemaVersion": 1,
  "runId": "<uuid>",
  "sequence": 1,
  "timestamp": "2026-07-15T12:00:00.000Z",
  "command": "prepare",
  "phase": "baseline",
  "status": "started",
  "error": null
}
```

### 2.2 必填字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | 整数 | 事件格式版本，当前为 1 |
| `runId` | 字符串 | 本次执行的唯一标识（UUID） |
| `sequence` | 整数 | 事件在本次执行中的序号，从 1 开始递增 |
| `timestamp` | 字符串 | ISO 8601 格式的 UTC 时间 |
| `command` | 字符串 | 触发命令名（assess、prepare、publish、reconcile、verify） |
| `phase` | 字符串 | 当前执行阶段标识 |
| `status` | 字符串 | 状态值：`started`、`succeeded`、`failed`、`skipped` |

### 2.3 可选字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `error` | 对象或 null | 失败时包含错误详情：`{ "code": "<ERROR_CODE>", "message": "<中文摘要>" }` |
| `duration` | 整数 | 阶段耗时（毫秒） |
| `details` | 对象 | 阶段特定的补充信息 |

### 2.4 摘要输出

每次执行结束时产生一个面向用户的中文摘要，包含：

- 执行的命令和最终状态。
- 每个阶段的执行结果。
- 失败的错误码和建议恢复方式。
- 关键产物路径（发布计划、证据目录、批准记录）。

---

## 3. 命令记录

每个 hook 和外部命令的执行记录包含以下信息：

| 字段 | 说明 |
|---|---|
| `command` | 命令和参数数组 |
| `cwd` | 执行目录（相对路径） |
| `startedAt` | 开始时间（ISO 8601） |
| `finishedAt` | 结束时间（ISO 8601） |
| `exitCode` | 退出码 |
| `stdout` | 标准输出引用（脱敏后存储，见第 4 节） |
| `stderr` | 标准错误引用（脱敏后存储，见第 4 节） |

验证 gate 不保存原始 stdout/stderr；证据仅记录命令数组、相对 cwd、时间、exit code、字节数、SHA-256 摘要和结构化裁决，避免把项目命令输出中的凭证复制进证据。

---

## 4. 脱敏规则

### 4.1 日志脱敏

日志不得记录以下内容：

- token、认证头、npm 配置内容。
- 未经脱敏的环境变量值。
- 私钥内容。

### 4.2 输出脱敏

命令输出中的敏感信息按以下规则脱敏：

| 模式 | 脱敏方式 |
|---|---|
| 键名匹配 `/token\|secret\|password\|authorization\|cookie/i` | 值替换为 `<REDACTED>` |
| 值以 `ghp_` 开头 | 替换为 `<REDACTED_GITHUB_TOKEN>` |
| 值以 `github_pat_` 开头 | 替换为 `<REDACTED_GITHUB_PAT>` |
| 值以 `npm_` 开头 | 替换为 `<REDACTED_NPM_TOKEN>` |
| 值以 `AKIA` 开头 | 替换为 `<REDACTED_AWS_KEY>` |
| 匹配私钥头尾标记 | 整段替换为 `<REDACTED_PRIVATE_KEY>` |

### 4.3 错误信息脱敏

错误信息中不记录 secret 的实际值。错误码和错误消息仅描述错误类型和位置，不包含敏感数据。`SECRET_DETECTED` 错误的报告中仅记录 secret 的类型（如"GitHub PAT"）和文件路径，不记录实际值。

---

## 5. 证据目录结构

每次执行产生一个证据目录，位于 `.release-skill/runs/<runId>/`。

```text
.runs/<runId>/
├── events.jsonl              # JSONL 事件流
├── summary.json              # 执行摘要
├── commands/                 # 命令执行记录
│   ├── 001-build.json
│   ├── 002-test.json
│   └── ...
├── plan/                     # 发布计划相关
│   ├── release-plan.json     # 冻结的发布计划
│   └── plan-digest.txt       # 计划摘要
├── baseline/                 # 基线快照
│   ├── baseline.json         # Git HEAD、tree hash、dirty 文件
│   └── snapshot-manifest.json
├── approval/                 # 批准记录（存在时）
│   └── approval-record.json
└── verify/                   # 验证结果（存在时）
    └── verify-report.json
```

### 5.1 文件保留

- 证据目录在执行完成后不得被自动删除。
- `events.jsonl` 为追加写入，不得在执行过程中被截断。
- `summary.json` 在执行结束时原子写入。
- 命令记录在每个命令完成后立即写入。

### 5.2 引用与存储

- 大型输出（如 stdout/stderr 完整内容）存储在 `commands/` 下的独立文件中。
- 事件和摘要中通过相对路径引用命令记录文件。
- 存储的输出内容经过第 4 节脱敏规则处理。

---

## 6. 跨标准引用

- 状态机中的异常状态和恢复规则见 `01-state-machine.md`。
- 配置中的 hook 约束和验证规则见 `02-project-config.md`。
- 供应链安全中的 secret 检测范围见 `04-supply-chain.md`。
- Adapter 接口和检查点记录见 `06-adapter-contract.md`。
