# 02 -- 项目配置

本文档定义 `.release-skill/project.yaml` 的 schema 规范、hooks 参数约束、profile 归一化、overlay 限制和 waiver 边界。状态机见 `01-state-machine.md`，安全要求见 `04-supply-chain.md`，错误码见 `05-evidence-and-errors.md`。

---

## 1. 配置文件位置与格式

项目使用 `.release-skill/project.yaml` 声明发布事实。

- 格式：YAML 1.2，兼容 JSON。
- 编码：UTF-8，无 BOM。
- 不得包含 YAML alias（`*anchor`）或重复键。
- 不得包含 `<project-root>/...` 等本机绝对路径。
- 配置摘要（SHA-256）基于规范化 JSON 计算：递归排序对象键、保持数组顺序、序列化为 UTF-8 JSON。

---

## 2. 顶层 schema

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject

project:
  name: <string>            # 项目标识，必填
  defaultBranch: <string>   # 默认分支，必填

releaseUnits:               # 发布单元数组，至少 1 个
  - id: <string>            # 唯一标识
    source: <string>        # 源码相对路径（相对项目根目录）
    publicRepo: <string>    # 公开仓库 owner/repo
    production:
      githubHost: github.com
      branchTemplate: <string>
      branchStrategy: create-release-branch # 或 advance-existing-branch / initialize-default-branch
    version:
      source: <string>      # 版本来源，如 "package.json"
      tagTemplate: <string> # tag 模板，如 "artifact-graph-v{version}"
    distributions:          # 分发渠道数组
      - type: <string>      # "npm" | "claude-plugin" | "codex-plugin"
        package: <string>   # npm 包名（type 为 npm 时必填）
    publicFiles:            # 公开源码镜像的显式闭世界映射
      - from: <string>      # 项目根相对路径
        to: <string>        # 公开仓库中的发布单元相对路径
        mode: preserve      # 保留源内容和可执行位
    requiredPublicFiles:    # 本发布单元不可缺失的目标路径
      - <string>
    previousPublicBaseline: # 必填；每个 unit 独立声明
      mode: none            # none | bound
      # bound 时还必须提供 repo/ref/commit，可选 tree/manifestDigest

verificationGates:         # 可选；定义会进入冻结计划摘要
  - id: <stable-id>
    phase: snapshot-verify # 或 consumer-verify
    scope:
      unit: <release-unit-id>
      # consumer-verify 还必须填写 distribution
    command: [<executable>, <arg>]
    cwd: .
    timeoutMs: 30000
    envAllowlist: []

hooks:                      # 可选，命令 hooks
  docs: <hook>
  build: <hook>
  test: <hook>
  typecheck: <hook>
  lint: <hook>

policy:                     # 可选，安全策略
  forbiddenPaths: [<string>]
  forbiddenContentPatterns: [<string>]
```

---

## 3. 公开源码镜像与分发包

`releaseUnits[].publicFiles` 定义 GitHub 公开源码镜像的显式、闭世界 allowlist。每个映射都必须可审阅；未列出的文件不会因为目录扫描、模板重生成或历史惯例而被自动加入。`sourceScope` 默认为 `unit`，此时 `from` 必须位于 `releaseUnits[].source` 内；只有历史共享许可证、公共文档或工作流等明确的工作空间级来源才可写 `sourceScope: workspace`，其路径仍必须受工作空间根目录的词法、realpath 和无符号链接校验约束。`releaseUnits[].requiredPublicFiles` 只约束同一发布单元，不能借用其他单元的目标路径。

公开源码镜像与 distribution pack 是两条不同边界：前者决定公开仓库快照，后者由 npm `files`、插件 manifest 等渠道合同决定安装内容。发布前必须分别冻结、比较并验证两条边界；distribution pack 中的必需路径必须由该发布单元的公开映射覆盖。

持续发布只复制已批准 mapping 指向的冻结源快照，不生成 README、slogan 或其他人工内容，也不以模板重新覆盖它们。人工修改一旦进入权威源，就作为下一轮迭代的输入保留。若公开目标仓库与冻结计划出现差异，系统停止写入并等待人工选择 merge、adopt 或 reject；不得静默采用任一侧，也不得从头生成文件。

### 3.1 前序公开基线与人工权威源

每个 `releaseUnits[]` 必须显式声明 `previousPublicBaseline`：

- 确认从未发布过公开版本时使用 `mode: none`。它不是跳过冲突检查的开关；publish
  仍会在任何 execute 前检查目标 branch、tag、GitHub Release 和 npm version 唯一性。
- 已有公开版本时使用 `mode: bound`，并填写精确的 `repo`、不可变 `ref` 和
  `commit`。生产 prepare 必须使用 `--online --production`，逐 unit 观察
  ref→commit mapping；offline production 不得冻结未观察的 bound 基线。

本地 human-owned 文件是下一轮发布内容的权威源；前序公开基线是冲突检测输入；
冻结 snapshot 是本轮审批和发布的唯一字节来源。默认 Git observer 只调用
`git ls-remote` 取得 ref→commit 映射，因此 commit 不一致时可提供 mapping diff，
但没有下载远端文件，必须把 content diff 明确标记为 unavailable，不能声称已经比较内容。

出现漂移时由人工选择：`merge`（合并双方修改）、`adopt`（采用远端修改）或
`reject`（拒绝远端修改）。无论选择 merge 还是 adopt，决定采用的内容都必须先合并回
human-owned 权威源，然后重新 prepare、审阅并 approve；后续环节只复制和冻结这些
字节，不重新生成或覆盖 README、slogan 及其他人工修改。

旧的 `policy.requiredPublicFiles` 已不支持。加载器必须返回 `CONFIG_INVALID`，并引导迁移到各自的 `releaseUnits[].requiredPublicFiles`。

### 3.2 公开分支策略

- `create-release-branch`：目标分支必须不存在；创建独立 release 分支，冻结提交没有父提交。
- `advance-existing-branch`：目标分支必须与 `previousPublicBaseline` 的精确提交一致；冻结提交以它为唯一父提交，publish 仅允许普通 fast-forward push。并发漂移或非快进时失败关闭，不使用 force。
- `initialize-default-branch`：目标标准分支必须不存在，冻结提交以当前公开基线为父提交；只有同时声明 `setAsDefaultBranch: true` 和 `expectedCurrentDefaultBranch` 时，计划才会增加显式 `set-default-branch` action。切换失败进入 PARTIAL，可由 reconcile 依据旧/新/第三方状态恢复或转人工。

已有公开仓不得使用 `mode: none` 伪装成首次发布。示例中的 commit 只是校准时点证据；每轮 production prepare 都必须在线重观测。

---

## 4. Hooks 参数约束

每个 hook 必须是对象，包含以下属性：

| 属性 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `command` | 字符串数组 | 是 | 至少 1 个元素；每个元素为字符串；第一个元素为可执行文件路径或名称；**不接受 shell 字符串** |
| `cwd` | 字符串 | 否 | 相对路径，不得以 `/` 开头，不得包含 `..` |
| `timeoutMs` | 整数 | 否 | 最小 1000，最大 7200000（2 小时） |
| `envAllowlist` | 字符串数组 | 否 | 每个元素匹配 `^[A-Z_][A-Z0-9_]*$`；无重复元素 |

hook 执行规则：

- 使用 `execFile`，不使用 `exec` 或 `{ shell: true }`。
- 通过 `realpath` 解析 cwd，拒绝逃逸到项目根目录之外。
- 超时后杀死子进程，返回 `HOOK_TIMEOUT` 错误码。
- 进程环境仅包含 `PATH`、平台必需进程变量和 allowlist 中声明的变量。

示例：

```yaml
hooks:
  test:
    command: [pnpm, test]
    cwd: .
    timeoutMs: 300000
    envAllowlist: [CI]
```

### 4.1 分阶段验证 gate

`verificationGates` 是项目个性化校验的受控扩展点，不是另一套发布流程：

| 字段 | 约束 |
|---|---|
| `id` | 全局唯一、稳定，匹配 `^[a-z0-9][a-z0-9._-]*$` |
| `phase` | `snapshot-verify` 或 `consumer-verify` |
| `scope.unit` | 必须引用现有发布单元 |
| `scope.distribution` | consumer 阶段必填，且必须是该单元真实声明的渠道 |
| `command` | `execFile` 风格字符串数组；禁止 shell 字符串 |
| `cwd` | 相对执行根，不允许路径逃逸或符号链接分量 |
| `timeoutMs` | 1000 至 7200000 |
| `envAllowlist` | 仅显式变量；其他凭证和环境变量不转发 |
| `expectedJson` | 可选；stdout 必须为 JSON 且递归包含这些字段 |

`snapshot-verify` 获得冻结公开快照的一次性可写副本；副本销毁后重新摘要原快照，失败时还没有远端写入。`consumer-verify` 只在精确 npm 或 Claude/Codex 隔离安装成功后，从安装根执行；结果摘要进入 verify run，失败不得达到 VERIFIED。

gate 与 legacy hook 都是无网络沙箱的本地进程，必须显式确认副作用。release-skill 会限制环境、路径、超时和证据输出，但不能替项目保证其命令不会写文件或访问网络。Git push、tag、默认分支、GitHub Release 和 npm publish 只能是冻结计划里的 adapter action，不能注册为 hook/gate。

### 4.2 首次接入 setup

`release-skill setup --root <path> --json` 默认只读，扫描工作区、包与插件 manifest、逐单元 Git 权威、旧版 `public-release.json` 和脚本，输出候选、完整 `recommendedAnswers`、结构化冲突/假设和 `setupDigest`。旧配置只作为不可信迁移事实，其中的 `snapshotCommands` 只成为未授权 gate 候选；它不会把脚本存在解释成用户选择，也不会读取 README 中的自然语言作为命令。报告可能包含大量精确映射，Agent 应先把完整 JSON 落到系统临时文件，只读取紧凑摘要，并机械提取 `recommendedAnswers`，不得在上下文中重新生成。

写入要求人工提供完整 answers JSON，再次 dry-run，并使用同一摘要执行 `--write --confirm-setup <setupDigest>`。写入只允许首次原子创建 `.release-skill/project.yaml`；已有配置返回 `ALREADY_CONFIGURED`/`CONFIG_EXISTS`，由人工增量编辑。事实漂移返回 `SETUP_DIGEST_MISMATCH`。没有远端渠道的项目返回 `LOCAL_ONLY_DETECTED`，不得宣称 production-ready。

---

## 5. Profile（规划中）

> **当前状态：** Profile 尚未实现，`project.yaml` 不支持 `profile` 字段。
> 以下为设计规划，不可写入当前配置文件。

profile 是预设的默认配置模板，提供常见发布拓扑的开箱配置。

### 5.1 首版 profile 列表

| profile | 适用场景 |
|---|---|
| `skill-plugin` | 纯 Claude/Codex 插件发布 |
| `npm-package` | 纯 npm 包发布 |
| `split-public-repos` | 父工程 + 多公开子仓库 |
| `hybrid-plugin-npm` | 插件与 npm 包混合发布 |

### 5.2 归一化规则

- profile 只提供默认配置值。
- 最终必须归一化为同一 schema，不能包含另一套发布流程。
- 项目显式声明的字段覆盖 profile 默认值。
- 归一化后的配置摘要必须稳定：相同的项目声明和 profile 组合产生相同的摘要。

---

## 6. Overlay 限制（规划中）

> **当前状态：** Overlay 尚未实现，`project.yaml` 不支持 `overlay` 字段。
> 以下为设计规划，不可写入当前配置文件。

项目 overlay 可以收紧通用规则（增加更严格的要求），但不能：

- 关闭 secret 扫描。
- 关闭发布计划摘要校验。
- 关闭显式授权门。
- 关闭发布后验证。
- 使 hook 接受 shell 字符串。
- 使用本机绝对路径。

违反上述限制的 overlay 在配置加载时拒绝，返回 `CONFIG_INVALID` 错误码。

---

## 7. Waiver 边界（规划中）

> **当前状态：** Waiver 尚未实现，`project.yaml` 不支持 `waiver` 字段。
> 以下为设计规划，不可写入当前配置文件。

当需要绕过某项安全门时，必须使用 waiver 机制：

### 7.1 Waiver 必填字段

| 字段 | 说明 |
|---|---|
| `rule` | 被豁免的规则标识 |
| `reason` | 豁免理由，不得为空 |
| `responsible` | 责任人，不得为空 |
| `expiresAt` | 失效日期，不得为空，不得晚于 30 天 |

### 7.2 展示要求

- Waiver 在批准界面必须显著展示。
- 过期的 waiver 自动失效，对应的规则恢复强制执行。
- Waiver 不适用于以下不可豁免项：secret 扫描、计划摘要校验、显式授权、发布后验证。

---

## 8. 配置验证

配置加载时执行以下验证：

1. YAML 语法正确，无 alias 和重复键。
2. `apiVersion` 为 `release-skill/v1`。
3. `kind` 为 `ReleaseProject`。
4. `project.name` 非空。
5. `releaseUnits` 至少包含 1 个元素。
6. 每个 `releaseUnit.id` 全局唯一。
7. 每个 `releaseUnit.source` 路径在项目中存在。
8. 所有 hook/gate 的 `command` 为数组且第一个元素非空。
9. 所有 hook/gate 的 `cwd` 不包含绝对路径前缀和 `..`。
10. gate id 唯一，unit/distribution scope 引用真实配置。
11. 分支推进策略使用 bound 基线；默认分支初始化具备显式旧/新分支断言。
12. 所有路径字段不包含 `<project-root>/` 前缀。

验证失败返回 `CONFIG_INVALID` 错误码，附带具体失败原因。

---

## 9. 跨标准引用

- 状态机中的状态定义和转换规则见 `01-state-machine.md`。
- 供应链安全中的最小权限和 Action 固定要求见 `04-supply-chain.md`。
- 错误码定义见 `05-evidence-and-errors.md`。
- Adapter 接口见 `06-adapter-contract.md`。
