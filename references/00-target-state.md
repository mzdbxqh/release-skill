# 00 -- 目标状态

本文档定义 release-skill 发布治理系统的目标拓扑、组件边界、设计原则和明确不做清单。所有规范性规则仅在此出现一次；关联领域的细节通过交叉引用指向对应标准。

---

## 1. 发布链路拓扑

首版支持以下发布链路：

```text
父工程
  -> 一个或多个公开 GitHub 子仓库
  -> GitHub Release
  -> 可选 npm publish
  -> Claude Code / Codex 插件 marketplace 校验
```

PyPI、Cargo、Docker 等发布目标不在首版范围内，但 registry adapter 必须可以扩展。

---

## 2. 仓库架构与组件边界

```text
release-skill/
├── standards/                 # 通用发布规范的唯一权威来源
├── research/                  # 开源项目与本地项目调研证据
├── schemas/                   # 项目配置、发布计划、执行证据 schema
├── packages/release-skill/    # 可公开发布的插件子工程
│   ├── skills/
│   ├── scripts/
│   ├── references/
│   └── adapters/
├── fixtures/                  # 不同成熟度项目和负向场景
├── scripts/                   # 父工程渲染、泄漏审计、公开发布
├── docs/                      # 设计、计划、评审和迁移报告
└── public-release.json        # 本项目自身 dogfooding 配置
```

### 2.1 规范层

`standards/` 是状态机（见 `01-state-machine.md`）、授权、配置（见 `02-project-config.md`）、版本、公开快照、文档质量（见 `03-readme-quality.md`）、供应链安全（见 `04-supply-chain.md`）、错误分类与恢复协议（见 `05-evidence-and-errors.md`）和 adapter 契约（见 `06-adapter-contract.md`）的唯一权威来源。

公开插件需要的 reference 从该目录确定性渲染，禁止人工维护两个规范副本。

### 2.2 确定性事务内核

内核负责读取配置、归一化 profile、生成和校验发布计划、构建公开快照、运行验证门、查询远端状态、执行发布检查点并写入结构化证据。内核不得依赖 Agent 自由拼接 shell 命令。

### 2.3 Skill 族

首版至少提供以下公开 Skill：

- `release-help`：用户可发现入口；完成依赖和环境检查、能力说明、最小示例、只读诊断、dry-run 和故障诊断引导。
- `release-assess`：识别项目拓扑，评估公开文档、配置、供应链和发布流程距目标状态的差距。
- `release-prepare`：补齐已授权的本地配置与文档，运行发布门并冻结发布计划，但不产生外部写操作。
- `release-publish`：只读取已批准且未过期的发布计划，执行外部发布检查点。
- `release-reconcile`：查询远端实际状态，处理部分成功、安全重试和发布后验证。

入口 Skill 保持轻量，只编排确定性脚本和指向细分 Skill，不复制业务执行协议。默认不执行破坏性操作，写入前遵守用户授权并保护已有文件。

### 2.4 Adapter 与 profile

标准 adapter 包括：

- Git 与公开 GitHub 子仓库
- GitHub Release
- npm registry
- Claude Code plugin marketplace
- Codex plugin manifest/marketplace

首版 profile 包括：

- `skill-plugin`
- `npm-package`
- `split-public-repos`
- `hybrid-plugin-npm`

profile 只提供默认配置，最终必须归一化为同一 schema（见 `02-project-config.md`），不能包含另一套发布流程。

---

## 3. 设计原则

以下八条原则贯穿 release-skill 全部组件，各标准文档通过交叉引用遵守而不再重复全文。

| 编号 | 原则 | 约束 |
|---|---|---|
| P-1 | 发布计划显式化 | 版本、发布单元、目标仓库、tag、包、验证命令和外部写操作必须进入可审阅、可冻结的发布计划（见 `01-state-machine.md` PREPARED 阶段）。 |
| P-2 | 准备与发布分离 | 任何用户都可以安全运行只读诊断和 dry-run；外部写操作只接受绑定到冻结计划的明确授权（见 `01-state-machine.md` APPROVED 阶段、`06-adapter-contract.md` 授权门）。 |
| P-3 | 确定性内核优先 | Agent 负责诊断、解释、生成计划和引导恢复；文件导出、hash、远端冲突检查、发布检查点和证据写入由脚本完成（见 `05-evidence-and-errors.md`）。 |
| P-4 | 项目声明差异 | 通用流程不理解某个项目的业务规则，项目只声明发布单元、版本来源、命令 hooks 和增量安全要求（见 `02-project-config.md`）。 |
| P-5 | 最小权限与可追溯性 | GitHub Actions 权限按 job 收紧；npm 优先 trusted publishing 和 provenance；第三方 Action 固定到 commit SHA（见 `04-supply-chain.md`）。 |
| P-6 | 部分成功可恢复 | GitHub、Git 和 npm 无法构成原子事务，系统必须保留检查点并从实际远端状态继续，不得盲目回滚或从头重跑（见 `01-state-machine.md` PARTIAL 状态、`06-adapter-contract.md` 幂等重试）。 |
| P-7 | README 是产品界面 | README 的可理解性、可操作性和命令新鲜度是发布硬门，不是"文件存在"检查（见 `03-readme-quality.md`）。 |
| P-8 | 保护既有工作 | 不得 reset、clean、restore、checkout 或 stash 用户变更；跨项目评估默认只读。 |

---

## 4. 明确不做

以下事项在 release-skill v1 中明确排除：

1. 不在本轮修改四个参考项目（artifact-graph、agent-method-registry、loop-agent、flow-architect）的工作树。
2. 不在本轮实际发布 GitHub/npm 资源。
3. 不首版实现 PyPI、Cargo、Docker adapter。
4. 不要求所有项目采用 Conventional Commits。
5. 不让项目 hook 覆盖通用安全门（见 `02-project-config.md` overlay 限制、`04-supply-chain.md`）。
6. 不把父工程私有路径、调研过程或本机绝对路径发布到公开插件。
7. 配置及生成产物不得包含 `<project-root>/...` 等本机绝对路径。

---

## 5. 交叉引用索引

| 领域 | 标准文档 |
|---|---|
| 状态与转换 | `01-state-machine.md` |
| 配置 schema、hooks、profile、overlay、waiver | `02-project-config.md` |
| README 质量门 | `03-readme-quality.md` |
| 供应链安全 | `04-supply-chain.md` |
| 错误码、证据格式、脱敏 | `05-evidence-and-errors.md` |
| Adapter 接口与授权门 | `06-adapter-contract.md` |
