# 01 -- 状态机

本文档定义 release-skill 发布生命周期的全部状态、合法转换、禁止转换和异常处理规则。设计原则见 `00-target-state.md`。

---

## 1. 状态定义

发布生命周期包含 7 个主状态和 3 个异常状态，共计 10 个状态。

### 1.1 主状态

| 状态 | 含义 | 进入条件 |
|---|---|---|
| **DISCOVERED** | 系统首次识别到一个可发布项目 | 通过配置文件发现或用户指定项目根目录 |
| **ASSESSED** | 项目拓扑、配置、文档、供应链和发布流程已完成只读评估 | `assess` 命令成功退出 |
| **PREPARED** | 发布门全部通过，发布计划已冻结写入磁盘 | `prepare` 命令成功退出，所有门均通过，计划 schema 验证通过 |
| **APPROVED** | 人工审阅并批准了冻结的发布计划 | 批准记录绑定到发布计划 hash，且未过期 |
| **PUBLISHING** | 外部写操作正在按检查点依次执行 | `publish` 命令读取已批准计划并开始执行 |
| **PUBLISHED** | 所有发布检查点均已成功完成 | 最后一个检查点的 `observe` 验证通过 |
| **VERIFIED** | 发布后验证全部通过 | `verify` 命令在全新环境中完成安装、调用、泄漏审计和远端一致性校验 |

### 1.2 异常状态

| 状态 | 含义 | 进入条件 |
|---|---|---|
| **NEEDS_INPUT** | 缺少会改变发布结果的用户选择或授权 | 配置中存在歧义、版本来源未确定或需要额外授权 |
| **BLOCKED** | 认证、权限、验证门或外部服务阻止继续，且没有安全的本地替代路径 | 认证缺失（AUTH_MISSING）、远端服务不可达或权限不足 |
| **PARTIAL** | 至少一个外部检查点已经成功，但发布单元尚未全部完成 | `publish` 在中途失败且已有检查点成功 |

---

## 2. 合法转换

以下表格列出全部合法的状态转换。不在表中的转换均为禁止转换。

| 源状态 | 目标状态 | 触发条件 |
|---|---|---|
| DISCOVERED | ASSESSED | `assess` 成功完成 |
| DISCOVERED | NEEDS_INPUT | 发现歧义或缺失用户输入 |
| ASSESSED | PREPARED | `prepare` 所有门通过且计划冻结 |
| ASSESSED | NEEDS_INPUT | 评估发现需要用户输入 |
| ASSESSED | BLOCKED | 认证缺失或外部服务阻止 |
| PREPARED | APPROVED | 人工批准记录创建，且计划 hash、tree hash、目标版本和远端冲突状态均未变化 |
| PREPARED | NEEDS_INPUT | 计划需要补充信息 |
| APPROVED | PUBLISHING | `publish` 读取未过期批准并开始执行 |
| APPROVED | PREPARED | 批准过期或计划变更导致批准失效，回退到重新准备 |
| PUBLISHING | PUBLISHED | 所有检查点成功 |
| PUBLISHING | PARTIAL | 至少一个检查点成功但后续失败 |
| PUBLISHING | BLOCKED | 外部服务阻断且无法继续 |
| PUBLISHED | VERIFIED | `verify` 全部通过 |
| PUBLISHED | POST_PUBLISH_VERIFY_FAILED | 发布后验证失败（保留 PUBLISHED 事实但标记验证失败） |
| NEEDS_INPUT | DISCOVERED | 用户提供输入后重新开始评估 |
| NEEDS_INPUT | ASSESSED | 用户提供输入后恢复评估 |
| BLOCKED | ASSESSED | 阻断因素解除后重新评估 |
| BLOCKED | PUBLISHING | 阻断因素解除后从检查点恢复 |
| PARTIAL | PUBLISHING | `reconcile` 从记录的检查点恢复执行 |
| PARTIAL | VERIFIED | `reconcile` 补齐剩余步骤且 `verify` 通过 |
| VERIFIED | DISCOVERED | 新版本周期开始 |

### 2.1 自动转换规则

以下转换在条件满足时自动触发，无需人工干预：

- APPROVED -> PREPARED：当批准记录的计划 hash 与当前冻结计划不匹配时，批准自动失效。
- APPROVED -> PREPARED：当 plan digest、Git tree hash、workspace digest、目标版本或已批准 action 列表变化时，批准自动失效。
- PUBLISHING -> PARTIAL：当任一检查点成功后下一检查点失败时，自动计算 PARTIAL 状态。

---

## 3. 禁止转换

以下转换在任何条件下均不允许：

| 禁止转换 | 原因 |
|---|---|
| DISCOVERED -> PREPARED | 必须先完成评估 |
| DISCOVERED -> APPROVED | 必须先评估再准备再批准 |
| DISCOVERED -> PUBLISHING | 未评估未准备不能发布 |
| ASSESSED -> APPROVED | 必须先通过 prepare 生成冻结计划 |
| ASSESSED -> PUBLISHING | 必须先准备并获得批准 |
| PREPARED -> PUBLISHING | 未获批准不能发布 |
| PREPARED -> VERIFIED | 不能跳过发布直接验证 |
| APPROVED -> VERIFIED | 不能跳过发布直接验证 |
| APPROVED -> PUBLISHED | 不能跳过发布执行直接到已发布 |
| PUBLISHING -> VERIFIED | 发布完成后必须先到 PUBLISHED |
| PUBLISHING -> APPROVED | 发布进行中不能回退到批准 |
| PUBLISHING -> PREPARED | 发布进行中不能回退到准备 |
| PUBLISHED -> PUBLISHING | 已发布的不能重新发布同一计划 |
| PUBLISHED -> APPROVED | 不能从已发布回退到批准 |
| VERIFIED -> PUBLISHING | 已验证的不能重新发布 |
| VERIFIED -> PUBLISHED | 已验证的不能回退到已发布 |
| NEEDS_INPUT -> PUBLISHING | 缺少输入不能发布 |
| BLOCKED -> PUBLISHING（非恢复路径） | 阻断状态只能通过 `reconcile` 恢复 |
| PARTIAL -> VERIFIED（非 reconcile 路径） | 部分成功必须经过 `reconcile` 补齐 |

---

## 4. 异常处理

### 4.1 NEEDS_INPUT 处理

- 系统必须明确列出缺失的输入项、影响范围和可选方案。
- NEEDS_INPUT 不能被静默转换为 VERIFIED。
- 用户提供输入后，系统从 DISCOVERED 或 ASSESSED 重新开始。

### 4.2 BLOCKED 处理

- 系统必须记录阻断原因、相关错误码（见 `05-evidence-and-errors.md`）和建议的解除方式。
- BLOCKED 不能被静默转换为 VERIFIED。
- 阻断因素解除后，系统从 ASSESSED 重新评估或从 PUBLISHING 恢复。

### 4.3 PARTIAL 处理

- 系统必须保留至少一个已成功的外部检查点记录，不得丢失。
- PARTIAL 状态在任何后续操作前必须被显式处理。
- 恢复路径通过 `reconcile` 命令执行：查询远端实际状态，跳过已一致的步骤，仅重试安全且未完成的步骤。
- 系统不得自动删除远端 tag、覆盖 GitHub Release、unpublish npm 包或从头重跑。
- 远端状态与冻结计划不一致时（REMOTE_CONFLICT），停止并要求人工决策。

### 4.4 批准失效

批准记录绑定到发布计划 hash。以下任何变化均导致批准自动失效：

- 发布计划内容变化（plan digest 不匹配）。
- Git tree hash 变化。
- 工作区 digest 变化。
- 目标版本变化。
- 已批准的 action 列表变化。

远端冲突状态（如 tag 已存在、npm 版本冲突等）不在 approval 绑定字段中；它在 publish/reconcile 的 preflight 阶段阻断执行并要求人工决策。

失效后系统回退到 PREPARED 状态，要求重新批准。

### 4.5 发布检查点失败

发布按以下检查点顺序执行（详见 `06-adapter-contract.md`）：

1. 推送父工程版本提交（若配置管理该步骤）。
2. 更新并推送公开子仓库快照。
3. 创建并推送签名或可追溯 tag。
4. 发布 npm 包。
5. 创建 GitHub Release。
6. 写入远端 URL、commit、tag、包版本、integrity 和执行结果。

任一步失败都停止后续动作，保存检查点并进入 PARTIAL。已完成的检查点通过 `observe` 验证后在 `reconcile` 中幂等跳过。

---

## 5. 跨标准引用

- 配置中的状态声明和 hook 参数约束见 `02-project-config.md`。
- 错误码与证据格式见 `05-evidence-and-errors.md`。
- Adapter 的 preflight/execute/observe/verify 接口和授权门见 `06-adapter-contract.md`。
- 发布计划冻结和批准界面内容要求见本文档第 4.4 节和 `06-adapter-contract.md` 第 3 节。
