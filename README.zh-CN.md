# release-skill

[English](README.md)

面向 Claude Code 和 Codex 的发布准备工具，完整保留人工维护的文件内容。

release-skill 帮助维护者回答三个问题：准备发布什么、还有哪些检查未通过、最终
发布的字节究竟是什么。它先冻结并供人工审阅，再从同一份冻结制品发布，不会在
最后一步重新生成 README、重新打包活动工作区或覆盖人工内容。

<!-- release-skill:capability:external-write-boundary -->
> **当前边界：** `assess`、离线 `prepare`，以及冻结 Git branch/tag、GitHub
> Release、npm tarball、Claude/Codex 插件市场消费者安装验证已通过生产等价协议沙箱：
> 测试运行真实 release-skill CLI 和冻结制品，Git 目标是本地 bare remote，`gh`、
> `npm`、Claude、Codex 是协议级 fake；另有隔离的本地探针调用已安装的
> Claude/Codex CLI，但没有访问真实 marketplace 或生产 API。这些测试没有提供
> OS 级网络隔离。我们尚未替你执行真实生产 canary；
> 第一次真实发布仍应作为受监控 canary。真实 API、认证、权限、限流和最终一致性
> 不属于该沙箱证明范围。`prepare --online` 仍失败关闭，远端唯一性检查在
> `publish` 的全局预检完成。

<!-- release-skill:capability:safe-first-command -->
> **第一条命令：**
> `node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help`

<!-- release-skill:maturity:v0.1-boundary -->
<!-- release-skill:maturity:boundary -->
> **安全默认路径：** 推荐 `help → assess → prepare --offline → 人工审阅`；
> 生产发布在此基础上显式增加 `prepare --production → approve → publish
> --confirm-production <planDigest>`，没有摘要确认就不会预检或写远端。

## 为什么人工修改的 README 不会丢失

release-skill 不重新生成、也不回写项目源文件。`prepare` 从当前工作区把每个公开文件复制
到隔离的本地快照，并验证复制前后的字节。README 的 slogan、示例、正文、格式，
以及后续任何人工修改都会作为完整文件被保留。

- 后续 prepare 重新读取当前文件，不会从模板重建。
- 快照必须与源文件逐字节一致。
- 计划变化会产生新的 digest，旧批准不能授权新内容。
- prepare 后再改源文件，publish 会因 baseline 变化在远端写入前停止。保留修改的
  正确方式是重新 prepare、重新审阅并重新 approve。
- 冻结制品被篡改时，publish 会因 snapshot/tarball/Git object 摘要不符停止。
- 远端 branch、tag、Release 或 npm 版本冲突时交给人工；系统不 force、不覆盖。
- 只有 `publicFiles` 明确列出的文件会被复制；需要发布的翻译 README、图片、
  演示文件和链接文档都要显式加入配置。

保护规则只有一句话：**复制当前事实，冻结已审阅事实，不重写人工事实。**

## 快速开始

### 安装 / 前置条件

- Node.js 22+
- Git 2.30+
- release-skill 的本地 checkout
- 至少已有一个提交的目标 Git 仓库

每个 shell 会话设置一次源码位置：

```bash
export RELEASE_SKILL_HOME=/absolute/path/to/release-skill
```

在 release-skill 工作空间根目录安装锁定版本的依赖：

```bash
cd "$RELEASE_SKILL_HOME"
npm exec --yes pnpm@10.17.1 -- install --frozen-lockfile
```

在目标项目创建 `.release-skill/project.yaml`：

先保护本地运行数据，避免把计划、审批和冻结制品提交进仓库：

```gitignore
.release-skill/*
!.release-skill/project.yaml
```

然后创建配置；npm 的可见性必须显式选择，不能依赖工具猜测：

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject

project:
  name: my-project
  defaultBranch: main

releaseUnits:
  - id: my-project
    source: .
    publicRepo: owner/my-project
    version:
      source: package.json
      tagTemplate: v{version}
    publicFiles:
      - from: README.md
        to: README.md
        mode: preserve
      - from: package.json
        to: package.json
        mode: preserve
      - from: LICENSE
        to: LICENSE
        mode: preserve
    requiredPublicFiles: [README.md, LICENSE, package.json]
    distributions:
      - type: npm
        package: my-project
        access: public       # 或 restricted；必须按真实包策略选择
        provenance: false    # 只有 CI/OIDC 已配置时才启用 true
        tag: latest
        # 可选：CLI 冒烟验证。配置 smokeBin 后，verify 会在隔离目录安装包
        # 并运行指定的二进制文件。未配置 smokeBin 时，verify 只确认安装
        # 和 name/version 一致。
        # smokeBin: my-project
        # smokeArgs: [help, --json]
        # smokeExpectedJson:
        #   command: help
        #   status: READY
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"
      releaseNotes: "人工维护的发布说明"
```

这只是解释机制的本地示例，不是完整的 npm 发布清单。真实发布前必须枚举全部
公开运行时代码、可执行文件、类型声明、图片和链接文档。monorepo 应把 `source`
设为 `packages/my-plugin` 之类的子目录；每个 `from` 仍相对工作空间根，例如
`packages/my-plugin/README.md`。

首次 prepare 前，建议提交 `.gitignore`、`.release-skill/project.yaml`、README、版本文件和
全部待发布内容，使 Git baseline 易于复现。prepare 前已有且之后未变化的未提交修改也会
进入 snapshot/baseline；只有 prepare 后再次变化才会使后续 baseline 校验停止。

### 主流程

按以下顺序执行。步骤 1–3 是安全默认（只读或仅本地）；步骤 4–8 是需要显式
人工门禁的生产发布。

```bash
CLI="$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs"
PROJECT=/absolute/path/to/my-project
```

1. **环境检查：**
   ```bash
   node "$CLI" help
   ```
2. **就绪评估（只读）：**
   ```bash
   node "$CLI" assess --root "$PROJECT" --offline --json
   ```
3. **本地快照与计划冻结：**
   ```bash
   node "$CLI" prepare --root "$PROJECT" --offline --json
   ```
4. **人工审阅：** 检查返回的 `planPath`、`externalActions`、
   `units[].targetVersion` 和 `planDigest`。每个发布单元的快照位于
   `<evidenceDir>/snapshots/<unit-id>/`。命令只在 `.release-skill/` 下写入本地数据。
5. **生产计划冻结：**
   ```bash
   node "$CLI" prepare --root "$PROJECT" --offline --production --json
   ```
   审阅新 plan 的 externalActions、npm access/provenance/tag、branch/tag 和冻结摘要。
6. **批准：**
   ```bash
   node "$CLI" approve --plan <planPath> --digest <planDigest> --actor <name> --json
   ```
   返回 `approvalPath`（默认：`<planDir>/approval-record.json`）。批准 24 小时失效，
   以返回的 `expiresAt` 为准。
7. **发布（从此开始写远端）：**
   ```bash
   node "$CLI" publish --root "$PROJECT" \
     --plan <planPath> --approval <approvalPath> \
     --confirm-production <planDigest> --json
   ```
   保存返回的 `runPath`。`PUBLISHED` **不是**终态。
8. **验证（消费者安装检查）：**
   ```bash
   node "$CLI" verify --root "$PROJECT" \
     --plan <planPath> --run <publishRunPath> --json
   ```

生产 prepare 会把每个公开快照封存为独立 Git commit/tree，并为 npm 单元生成固定
tarball。`publish` 先对所有动作做只读预检，再按“公开快照 branch → tag → npm →
GitHub Release → Claude/Codex marketplace 安装”执行并逐项观察。`verify` 在隔离目录
安装每一个精确 npm `package@version`；配置 `smokeBin` 后还会运行 CLI 并校验输出。
只有全部证据与冻结计划一致才进入 `VERIFIED`。真实发布前运行 `gh auth login`、
`gh auth setup-git` 和 `npm login`，同时确认 Git HTTPS credential 能访问目标仓库。
默认分支名为 `release/<tag>`，可由每个 unit 的 `production.branchTemplate` 配置；
同名远端对象存在时停止，交由人工判断。

### 父工作空间 + npm 子单元 + 插件子单元

当 monorepo 从不同目录同时产出 npm 包和 Claude/Codex 插件时，应定义独立的
发布单元。只有当某个单元确实以 manifest、marketplace 和 entry Skill 的形式
发布插件时，才为其添加插件分发：

本例中的 `project` 是父工作空间的编排容器，本身不是公开发布单元；如果工作空间
根目录也要发布独立仓库或 package，应再增加一个 `source: .` 的 release unit。

```yaml
apiVersion: release-skill/v1
kind: ReleaseProject
project:
  name: my-workspace
  defaultBranch: main

releaseUnits:
  - id: my-app
    source: packages/app
    publicRepo: owner/my-app
    version:
      source: packages/app/package.json
      tagTemplate: my-app-v{version}
    distributions:
      - type: npm
        package: my-app
        access: public
        provenance: false
        tag: latest
        smokeBin: my-app
        smokeArgs: [help, --json]
        smokeExpectedJson:
          command: help
          status: READY
    publicFiles:
      - from: packages/app/README.md
        to: README.md
        mode: preserve
      - from: packages/app/package.json
        to: package.json
        mode: preserve
      - from: packages/app/LICENSE
        to: LICENSE
        mode: preserve
    requiredPublicFiles: [README.md, package.json, LICENSE]
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"

  - id: my-plugin
    source: packages/plugin
    publicRepo: owner/my-plugin
    version:
      source: packages/plugin/package.json
      tagTemplate: my-plugin-v{version}
    distributions:
      # 只有当单元确实发布插件时才声明插件消费者。
      # CLI 冒烟独立；只有插件包同时暴露 CLI 二进制时才声明 smokeBin。
      - type: claude-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
      - type: codex-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
    publicFiles:
      - from: packages/plugin/.claude-plugin/plugin.json
        to: .claude-plugin/plugin.json
        mode: preserve
      - from: packages/plugin/.claude-plugin/marketplace.json
        to: .claude-plugin/marketplace.json
        mode: preserve
      - from: packages/plugin/.codex-plugin/plugin.json
        to: .codex-plugin/plugin.json
        mode: preserve
      - from: packages/plugin/.agents/plugins/marketplace.json
        to: .agents/plugins/marketplace.json
        mode: preserve
      - from: packages/plugin/skills/my-plugin-help/SKILL.md
        to: skills/my-plugin-help/SKILL.md
        mode: preserve
      - from: packages/plugin/README.md
        to: README.md
        mode: preserve
      - from: packages/plugin/package.json
        to: package.json
        mode: preserve
      - from: packages/plugin/LICENSE
        to: LICENSE
        mode: preserve
    requiredPublicFiles:
      - .claude-plugin/plugin.json
      - .claude-plugin/marketplace.json
      - .codex-plugin/plugin.json
      - .agents/plugins/marketplace.json
      - skills/my-plugin-help/SKILL.md
      - README.md
      - package.json
      - LICENSE
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"
```

每个插件单元**必须**列出 Claude/Codex `plugin.json`、`marketplace.json`、
入口 Skill 和全部 required public files。CLI 冒烟（`smokeBin`）对插件单元
是可选项，仅当发布包同时暴露 CLI 二进制时才适用。

### PARTIAL 恢复与 reconcile

当 `publish` 在部分检查点成功但在其他检查点失败时，运行进入 `PARTIAL`
状态。**不要从头重跑，也不要删除远端状态**（例如不要删除已推送的 tag 或
unpublish 已发布的包）。

使用 `reconcile` 检查实际远端状态，跳过已一致的步骤，安全重试未完成的动作：

```bash
node "$CLI" reconcile --root "$PROJECT" \
  --run <publishRunPath> \
  --plan <planPath> \
  --approval <approvalPath> \
  --confirm-production <planDigest> \
  --json
# 保存 reconcile 返回的新 runPath，再执行全新的安装验证。
node "$CLI" verify --root "$PROJECT" \
  --plan <planPath> --run <reconcileRunPath> --json
```

`reconcile` 查询实际远端状态（Git refs、npm 版本、GitHub Release、
marketplace 安装），跳过证据已匹配冻结计划的步骤，只重试安全且未完成的
步骤。远端冲突（例如意外的 tag 或 npm 版本）需要人工判断，无法自动解决。
reconcile 成功只返回 `PUBLISHED`，不会返回 `VERIFIED`；只有全新运行的 verify
可以产生终态 `VERIFIED`。

## 已验收能力

- 验证项目配置和发布单元；
- `assess` 在不修改项目的前提下报告就绪度；
- 把配置的公开文件复制到隔离快照；
- 检查必需文件、路径安全、精确字节/权限和明显泄漏；
- 记录 Git/工作区身份，冻结绑定 digest 的发布计划；
- 用计划摘要、有效期和显式 action allowlist 绑定人工批准；
- 从冻结 Git object 和 npm tarball 发布，并核对远端 commit/tree/tag/integrity；
- 从冻结 Git ref 安装配置的 Claude/Codex 插件，证明入口 Skill 和安装载荷摘要；
- 明确区分 `PUBLISHED`（外写完成）与 `VERIFIED`（远端和消费者安装证据完成）；
- 中途失败停止后续动作，记录独立 run；不修改冻结 plan，不自动撤销已成功动作。

## 当前不会做什么

<!-- release-skill:capability:unsupported-scope -->
- 不自动生成 README，不覆盖项目源文件；
- 不自动合并冲突，也不要求回滚工作流；
- 不声称已经替项目完成真实生产 canary；
- `prepare --online` 尚未实现；生产远端检查由 publish 全局预检完成；
- 不 force push，不覆盖已有 branch/tag/Release，不 unpublish npm；
- 不承诺 Windows 或广泛的跨平台原生写入；
- 不会隐藏地 commit、push、打 tag、创建 Release 或发布包。

### 写入安全

`assess` 默认只读，只有显式指定报告输出时才写报告。`prepare` 会在
`.release-skill/` 下写本地文件，但不会写项目源文件或远端服务。如果配置了
hook，它就是任意本地进程，必须使用 `--acknowledge-hook-side-effects` 明确授权；
hook 可能自行产生文件系统或网络副作用。`publish` 是唯一生产外写入口，必须同时
提供 approval 和当前 plan digest。最小安全演练应省略 hook，并在本地沙箱目标运行。

### 失败时怎么办

| 结果 | 下一步 |
|---|---|
| `CONFIG_INVALID` | 修正 `.release-skill/project.yaml`，重新运行 `assess`。 |
| `PUBLIC_FILE_MISSING` | 添加或修正配置中的公开文件。 |
| `FORBIDDEN_CONTENT_DETECTED` | 移除泄漏或私有内容，再次 prepare。 |
| `SNAPSHOT_FIDELITY_FAILED` | 检查源文件和快照路径，重新运行 `prepare`。 |
| `BASELINE_CHANGED` | 保留人工修改，重新 prepare、审阅和 approve。 |
| `GATE_FAILED` | 检查冻结制品、认证、远端唯一性或生产摘要确认。 |
| `PARTIAL` | 不重跑整套发布、不删除远端；审阅返回的 `runPath` 并运行 `reconcile`（见上文）。 |
| `PUBLISHED` | 运行 `verify --plan <planPath> --run <publishRunPath>`；此时还不是终态。 |
| `VERIFIED` | 远端状态、精确 npm 安装和插件消费者安装都与冻结计划一致。 |

## Skills

- `release-help`：环境检查和下一步引导。
- `release-assess`：只读发布就绪度报告。
- `release-prepare`：本地快照和可审阅发布计划。
- `release-publish`：经批准、摘要确认的冻结 GitHub+npm 发布。
- `release-reconcile`：基于证据恢复 PARTIAL；冲突时人工介入。

冲突默认仍由人工介入。当前已验收入口是上面的源码 CLI。

## 许可证

MIT，见 [LICENSE](LICENSE)。
