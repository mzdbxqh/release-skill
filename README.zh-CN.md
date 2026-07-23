# release-skill

[English](README.md) · 安装指南：[中文](INSTALL.zh-CN.md) / [English](INSTALL.md)

<!-- release-skill:release-version: 0.1.8 -->
面向 Claude Code、Codex 和 Kimi Code 的发布准备工具，完整保留人工维护的文件内容。

release-skill 帮助维护者回答三个问题：准备发布什么、还有哪些检查未通过、最终发布的内容是什么。它先冻结并供人工审阅，再从同一份冻结产物发布，不会在最后一步重新生成 README、重新打包当前工作区或覆盖人工内容。

<!-- release-skill:managed:start id=latest-release -->
**0.1.8** (2026-07-23)

v0.1.8 在不改写已经公开的 v0.1.7 制品的前提下，新增对 Kimi Code 一等插件宿主的支持。由于 Kimi Code 没有可脚本化的非交互插件安装接口，Kimi 分发采用生成的自包含适配器，以及失败关闭、绑定冻结计划的人工安装证明。npm 包名（`release-skill`）、发布身份（`publisher: mzdbxqh`）、公开仓库（`ifoohoo/release-skill`）与公司维护主体均保持不变。

**变更**

- **Kimi Code 插件分发与验证**：v0.1.8 新增根
  `.kimi-plugin/plugin.json`、生成的自包含 `adapters/kimi/` 适配器和公开安装说明。
  由于 Kimi Code 没有可脚本化的非交互插件安装接口，生产发布会生成版本钉死的人工
  安装要求并进入 `PARTIAL`；操作者必须在隔离的 `KIMI_CODE_HOME` 中完成安装，并
  提供分别绑定冻结计划摘要和载荷摘要的可信证明，之后 `reconcile` 才能进入
  `PUBLISHED`，`verify` 才能进入 `VERIFIED`。
- **保留不可变的 v0.1.7 历史**：既有 v0.1.7 Git 标签、GitHub Release、npm
  版本与公开提交均不改写。v0.1.8 生产计划以已公开的 v0.1.7 提交
  `fe5897456d4166a2ec60e99405836b122562b80d` 作为前序公开基线。
<!-- release-skill:managed:end id=latest-release -->

<!-- release-skill:capability:external-write-boundary -->
> **当前边界：** v0.1.8 是当前发布版本（v0.1.7 曾处于已发布、待独立验证状态）。
> v0.1.1 已完成 GitHub 与 npm 的
> 真实生产发布，是首次生产验证的历史里程碑，并从冻结 Git ref 完成精确 npm
> 安装及 Claude/Codex 消费者安装验证；“当前发布版本”与“首次生产验证里程碑”
> 是两个不同的事实，不得混写成同一含义。同一工作流还通过了本地
> 生产等价协议套件：测试运行真实 release-skill CLI 和冻结制品，Git 目标是
> 本地 bare remote，`gh`、`npm`、Claude、Codex 使用协议级 fake。该套件没有
> 提供 OS 级网络隔离，也不能证明其他项目的认证、权限、限流和最终一致性行为
> 与本次发布相同；每个项目的第一次生产发布仍应作为受监控 canary。
> `prepare --online` 观察 bound 前序公开基线，漂移或不可观察时失败关闭；
> 远端唯一性检查在 `publish` 全局预检执行。

<!-- release-skill:capability:safe-first-command -->
> **生产路径自 v0.1.1 里程碑起已完成真实生产验证；v0.1.8 是当前发布版本。**
> npm 安装的 CLI 是受支持的用户入口；源码 checkout 保留为开发/贡献者路径。
>
> **第一条命令：**
> - npm 安装：`npm install -g release-skill` → `release-skill help`
> - 源码 checkout：`node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs" help`

<!-- release-skill:maturity:v0.1-boundary -->
<!-- release-skill:maturity:boundary -->
> **安全默认路径：** 推荐 `help → assess → prepare --offline → 人工审阅`；
> 生产发布在此基础上显式增加 `prepare --production → approve → publish
> --confirm-production <planDigest>`；`bound` 前序公开基线必须使用
> `prepare --online --production`。没有摘要确认就不会预检或写远端。

## 为什么人工修改的 README 不会丢失

release-skill 不重新生成、也不回写项目源文件。`prepare` 从当前工作区把每个公开文件复制到隔离的本地快照，并验证复制前后的字节。README 的 slogan、示例、正文、格式，以及后续任何人工修改都会作为完整文件被保留。

- 后续 prepare 重新读取当前文件，不会从模板重建。
- 快照必须与源文件逐字节一致。
- 计划变化会产生新的 digest，旧批准不能授权新内容。
- prepare 后再改源文件，publish 会因 baseline 变化在远端写入前停止。保留修改的正确方式是重新 prepare、重新审阅并重新 approve。
- 冻结制品被篡改时，publish 会因 snapshot/tarball/Git object 摘要不符停止。
- 远端 branch、tag、Release 或 npm 版本冲突时交给人工；系统不 force、不覆盖。
- 只有 `publicFiles` 明确列出的文件会被复制；需要发布的翻译 README、图片、演示文件和链接文档都要显式加入配置。
- 发布只冻结当前真相：`prepare` 不会刷新或重写人工文档。维护者必须先更新 README、INSTALL 与 CHANGELOG（包括必须与 `package.json` 版本一致的机器可读 `release-skill:release-version` 标记，以及当前包版本的正式 CHANGELOG 标题），再 prepare、审阅和批准。任一文档版本标记或 CHANGELOG 当前版本条目漂移时，发布前门禁失败关闭。

保护规则只有一句话：**复制当前事实，冻结已审阅事实，不重写人工事实。**

## 快速开始

### 安装 / 前置条件

- Node.js 22+
- Git 2.30+
- 至少已有一个提交的目标 Git 仓库

**从 npm 安装（推荐）：**

```bash
npm install -g release-skill
```

或免安装直接运行：

```bash
npx release-skill help
```

**验证安装：**

```bash
release-skill help
```

**开发安装（贡献者回退，从源码 checkout）：**

```bash
export RELEASE_SKILL_HOME=/absolute/path/to/release-skill
cd "$RELEASE_SKILL_HOME"
npm exec --yes pnpm@10.17.1 -- install --frozen-lockfile
```

然后通过 `node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs"` 调用 CLI。

先保护本地运行数据，避免把计划、审批和冻结制品提交进仓库：

```gitignore
.release-skill/*
!.release-skill/project.yaml
```

### 首次接入

`setup` 默认只读。把完整报告写入临时文件，只查看确定性的 `compactSummary`（紧凑摘要）：

```bash
PROJECT=/absolute/path/to/my-project
SETUP_SESSION="$(mktemp -d "${TMPDIR:-/tmp}/release-setup.XXXXXX")"
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"

release-skill setup --root "$PROJECT" --json > "$REPORT" || test "$?" -eq 2
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary){console.error("compactSummary missing");process.exit(2)}process.stdout.write(JSON.stringify(r.compactSummary,null,2)+"\n")' "$REPORT"
```

`NEEDS_INPUT` 和 `LOCAL_ONLY_DETECTED` 按设计返回退出码 2。若 `proposalConflicts` 非空，必须停止自动路径，由人工修正冲突的仓库或映射权威事实后重新运行 setup，不得猜测选边。

没有冲突时，机械提取机器提案：

```bash
SETUP_SESSION='/上一步打印的会话目录绝对路径'
PROJECT='/上一步打印的项目绝对路径'
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if((r.proposalConflicts??[]).length){console.error("proposal conflicts require human resolution");process.exit(2)}if(!r.recommendedAnswers){console.error("recommendedAnswers missing");process.exit(2)}fs.writeFileSync(process.argv[2],JSON.stringify(r.recommendedAnswers,null,2)+"\n",{flag:"wx",mode:0o600})' "$REPORT" "$ANSWERS"

release-skill setup --root "$PROJECT" --answers "$ANSWERS" --json > "$BOUND_REPORT"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary||!r.setupDigest){console.error("bound setup report incomplete");process.exit(2)}process.stdout.write(JSON.stringify({compactSummary:r.compactSummary,setupDigest:r.setupDigest},null,2)+"\n")' "$BOUND_REPORT"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"
```

只审阅这份绑定摘要和精确摘要值，并由用户确认一次。确认后使用其字面量首次创建配置：

```bash
SETUP_SESSION=<上一步打印的会话目录绝对路径>
PROJECT=<上一步打印的项目绝对路径>
ANSWERS="$SETUP_SESSION/answers.json"
CREATED_REPORT="$SETUP_SESSION/created.json"
POST_REPORT="$SETUP_SESSION/post-setup.json"
ASSESS_REPORT="$SETUP_SESSION/assess.json"
release-skill setup --root "$PROJECT" --answers "$ANSWERS" \
  --write --confirm-setup <已确认的 setupDigest> --json > "$CREATED_REPORT"
release-skill setup --root "$PROJECT" --json > "$POST_REPORT"
set +e
release-skill assess --root "$PROJECT" --offline --json > "$ASSESS_REPORT"
ASSESS_EXIT=$?
set -e
[ "$ASSESS_EXIT" -eq 0 ] || [ "$ASSESS_EXIT" -eq 1 ] || exit "$ASSESS_EXIT"
node -e 'const fs=require("node:fs");const [c,p,a]=process.argv.slice(1).map(x=>JSON.parse(fs.readFileSync(x,"utf8")));if(c.status!=="CONFIG_CREATED"||p.status!=="ALREADY_CONFIGURED"||!["ASSESSED","NEEDS_INPUT","BLOCKED"].includes(a.status)){process.exit(2)}process.stdout.write(JSON.stringify({created:c.status,postSetup:p.status,assessment:{status:a.status,summary:a.summary,gapCount:(a.gaps??[]).length,blockingCodes:(a.gaps??[]).filter(g=>g.severity==="error").map(g=>g.code)}},null,2)+"\n")' "$CREATED_REPORT" "$POST_REPORT" "$ASSESS_REPORT"
node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:false})' "$SETUP_SESSION"
```

写入必须返回 `CONFIG_CREATED`，下一次 setup 必须返回 `ALREADY_CONFIGURED`。已有配置永不重新生成，后续只做经审阅的增量编辑。发现的解释器/包管理器脚本标记为 `SIDE_EFFECTS_UNPROVEN`，不会被自动选中。只有在人工审阅之后才添加项目专属的 hook 或 gate：编辑 `projectConfig.hooks`，或编辑 `verificationGates` 并把同一个 id 加入 `selectedGateIds`，然后重新运行绑定 dry-run。人工维护的文件保持 `mode: preserve`；只有明确的跨单元共享来源才使用 `sourceScope: workspace`。

#### 进阶：schema 参考——并非首次接入路径

下面的 wrapper 仅用于说明 schema。正常 setup 路径中不要手工编写它；按上文机械提取 `recommendedAnswers`。

```json
{
  "projectConfig": {
    "apiVersion": "release-skill/v1",
    "kind": "ReleaseProject",
    "project": { "name": "my-project", "defaultBranch": "main" },
    "releaseUnits": [{
      "id": "my-project",
      "source": ".",
      "publicRepo": "owner/my-project",
      "version": { "source": "package.json", "tagTemplate": "v{version}" },
      "distributions": [{
        "type": "npm",
        "package": "my-project",
        "access": "public",
        "provenance": false,
        "tag": "latest",
        "registry": "https://registry.npmjs.org",
        "publisher": "my-npm-username"
      }],
      "publicFiles": [
        { "from": "README.md", "to": "README.md", "mode": "preserve" },
        { "from": "package.json", "to": "package.json", "mode": "preserve" }
      ],
      "requiredPublicFiles": ["README.md", "package.json"],
      "previousPublicBaseline": { "mode": "none" },
      "production": {
        "branchTemplate": "release/{tag}",
        "branchStrategy": "create-release-branch"
      }
    }]
  },
  "selectedGateIds": []
}
```

这只是 schema 参考，不是接入模板。正常 setup 必须使用机器提案。`mode: none` 仅在不存在任何公开版本时有效。

下面的参考展示经人工审阅的 gate 与 `selectedGateIds` 之间的精确关系。该关系只能作为对提取出的机器提案的增量编辑来应用：

```json
{
  "projectConfig": {
    "apiVersion": "release-skill/v1",
    "kind": "ReleaseProject",
    "project": { "name": "my-project", "defaultBranch": "main" },
    "releaseUnits": [{
      "id": "my-project",
      "source": ".",
      "publicRepo": "owner/my-project",
      "version": { "source": "package.json", "tagTemplate": "v{version}" },
      "distributions": [{
        "type": "npm",
        "package": "my-project",
        "access": "public",
        "provenance": false,
        "tag": "latest",
        "registry": "https://registry.npmjs.org",
        "publisher": "my-npm-username"
      }],
      "publicFiles": [
        { "from": "package.json", "to": "package.json", "mode": "preserve" }
      ],
      "requiredPublicFiles": ["package.json"],
      "previousPublicBaseline": { "mode": "none" },
      "production": {
        "branchTemplate": "release/{tag}",
        "branchStrategy": "create-release-branch"
      }
    }],
    "verificationGates": [{
      "id": "my-project-script-test",
      "phase": "snapshot-verify",
      "scope": { "unit": "my-project" },
      "command": ["node", "-e", "const p=require('./package.json');if(!p.name)process.exit(1)"],
      "cwd": ".",
      "timeoutMs": 30000,
      "envAllowlist": []
    }]
  },
  "selectedGateIds": ["my-project-script-test"]
}
```

id 必须从当前 `gateCandidates` 复制，不得臆造。示例命令在公开快照内自包含。项目脚本只有在脚本本身及其全部依赖都包含在 `publicFiles` 中时才有效；snapshot gate 看不到父工作区的测试、开发依赖或 `node_modules`，除非它们被显式公开。

```bash
release-skill setup --root /absolute/path/to/my-project \
  --answers /absolute/path/to/setup-answers.json --json
release-skill setup --root /absolute/path/to/my-project \
  --answers /absolute/path/to/setup-answers.json \
  --write --confirm-setup <setupDigest> --json
```

Setup 只原子创建缺失的 `.release-skill/project.yaml`。这一 create-once 步骤使用 v0.1.3 起随包发布、经 digest 登记的 `darwin-arm64` 原生预编译产物；不支持的平台以 `SAFE_WRITE_UNAVAILABLE` 失败关闭，不会回退到基于路径的写入。`ALREADY_CONFIGURED`/`CONFIG_EXISTS` 表示现有文件仍由人工所有，只能增量编辑。README、slogan、CHANGELOG 和业务脚本永不被生成或覆盖。没有远端渠道的项目会报告 `LOCAL_ONLY_DETECTED`，而不是虚构生产支持。

以下是一个最小的人工编写配置。npm 可见性、公开文件边界和远端目标都必须显式声明：

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
    previousPublicBaseline:
      mode: none              # 首次发布：不存在更早的公开版本
    distributions:
      - type: npm
        package: my-project
        access: public       # 或 restricted；选择真实的包策略
        provenance: false    # 只有在 CI/OIDC 配置完成后才使用 true
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
        # 可选：CLI smoke 验证。配置 smokeBin 后，verify 会在隔离目录
        # 安装该包并运行指定二进制。不配置 smokeBin 时，verify 只确认
        # 安装与 name/version。
        # smokeBin: my-project
        # smokeArgs: [help, --json]
        # smokeExpectedJson:
        #   command: help
        #   status: READY
    production:
      branchTemplate: release/{tag}
      branchStrategy: create-release-branch
      releaseTitleTemplate: "{unit} {version}"
      releaseNotes: "人工维护的发布说明"
```

每个发布单元都必须声明其前序公开基线。只有当你确认不存在更早的公开版本时才使用 `mode: none`。对于已有公开仓库，绑定精确的不可变 ref 与 commit：

```yaml
    previousPublicBaseline:
      mode: bound
      repo: owner/my-project
      ref: release/v0.9.0
      commit: 0123456789abcdef0123456789abcdef01234567
```

`none` 不是绕过冲突检查的手段：publish 仍会在任何写入前检查目标 branch、tag、GitHub Release 与 npm 版本的唯一性。bound 模式的生产 prepare 必须在线运行，以便观察 ref 到 commit 的映射。默认观察器不下载远端文件内容，因此它报告映射差异并标记内容差异不可用。发生漂移时停止，由人工选择 `merge`、`adopt` 或 `reject`。先获取并审阅真实远端 commit；工具不会下载或合并其文件。`merge` 在人工所有的来源中保留本地与远端双方修改；`adopt` 把审阅过的远端字节复制进该来源；`reject` 在调查或修正远端/ref 期间停止本次发布；永远不要为了绕过漂移而改回 `mode: none`。`merge` 或 `adopt` 之后，把 `previousPublicBaseline` 重新绑定到已接受的不可变 `repo`/`ref`/`commit`，再运行新的 `prepare --online --production`、审阅并批准。

分支策略应与真实仓库匹配（`create-release-branch`、`advance-existing-branch`、`initialize-default-branch`）；三种策略的最小配置示例见[英文 README](README.md)。

### 主流程

按以下顺序执行。步骤 1–4 是安全默认（只读或仅本地）；步骤 5–9 是需要显式人工门禁的生产发布。

```bash
# npm 安装的 CLI（推荐）：
CLI=(release-skill)
PROJECT=/absolute/path/to/my-project
ACTOR=your-name
# 开发回退（源码 checkout）：
# CLI=(node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs")
```

1. **环境检查：**
   ```bash
   "${CLI[@]}" help
   ```
2. **首次接入（仅缺少配置时，只读）：**
   ```bash
   "${CLI[@]}" setup --root "$PROJECT" --json
   ```
   按上文机械提取 `compactSummary` 与 `recommendedAnswers`，只确认一次绑定后的 `setupDigest`；配置已存在时跳过。
3. **就绪评估（只读）：**
   ```bash
   "${CLI[@]}" assess --root "$PROJECT" --offline --json
   ```
4. **本地快照与计划冻结：**
   ```bash
   "${CLI[@]}" prepare --root "$PROJECT" --offline \
     --acknowledge-hook-side-effects \
     --acknowledge-gate-side-effects --json
   ```
   只有项目配置没有对应 hook 或 snapshot gate 时，才省略相应授权参数。授权前必须审阅可执行文件、参数、工作目录和副作用，不能把授权参数当固定样板。
5. **人工审阅：** 检查返回的 `planPath`、`externalActions`、`units[].targetVersion` 和 `planDigest`。每个发布单元的快照位于 `<evidenceDir>/snapshots/<unit-id>/`。
6. **生产计划冻结：**
   ```bash
   PRODUCTION_JSON=$("${CLI[@]}" prepare --root "$PROJECT" --online --production \
     --acknowledge-hook-side-effects \
     --acknowledge-gate-side-effects --json)
   printf '%s\n' "$PRODUCTION_JSON" | jq .
   PLAN_PATH=$(printf '%s\n' "$PRODUCTION_JSON" | jq -r '.planPath')
   PLAN_DIGEST=$(printf '%s\n' "$PRODUCTION_JSON" | jq -r '.planDigest')
   ```
   同样，只省略配置不需要的授权，并在授权前逐项审阅项目进程。`prepare --json` 返回的生产权威 `planPath` 指向 `<项目>/.release-skill/plans/<planDigest>.json`，后续必须始终沿用这个返回值。`.release-skill/release-plan.json` 只是可变便利副本，不得传给生产 approve/publish/reconcile。
7. **批准：**
   ```bash
   APPROVAL_JSON=$("${CLI[@]}" approve --plan "$PLAN_PATH" \
     --digest "$PLAN_DIGEST" --actor "$ACTOR" --json)
   printf '%s\n' "$APPROVAL_JSON" | jq .
   APPROVAL_PATH=$(printf '%s\n' "$APPROVAL_JSON" | jq -r '.approvalPath')
   ```
   批准 24 小时失效；`--actor` 只是未经认证的本地审计标签。后续必须使用返回的 immutable `approvalPath` 和 `expiresAt`。
8. **发布（从此开始写远端）：**
   ```bash
   PUBLISH_JSON=$("${CLI[@]}" publish --root "$PROJECT" \
     --plan "$PLAN_PATH" --approval "$APPROVAL_PATH" \
     --confirm-production "$PLAN_DIGEST" --json)
   printf '%s\n' "$PUBLISH_JSON" | jq .
   PUBLISH_RUN_PATH=$(printf '%s\n' "$PUBLISH_JSON" | jq -r '.runPath')
   ```
   保存返回的 `runPath`。`PUBLISHED` **不是**终态。
9. **验证（消费者安装检查）：**
   ```bash
   "${CLI[@]}" verify --root "$PROJECT" \
     --plan "$PLAN_PATH" --run "$PUBLISH_RUN_PATH" \
     --acknowledge-gate-side-effects --json
   ```
   只有计划既没有 consumer gate，也没有 npm `smokeBin` 时才省略授权。

生产 prepare 会把每个公开快照封存为独立 Git commit/tree，并为 npm 单元生成固定 tarball。`publish` 先对所有动作做只读预检，再按“公开快照 branch → tag → npm → GitHub Release → Claude/Codex 插件市场安装”执行并逐项观察。Kimi Code 没有可脚本化的安装接口，其检查点**失败关闭**：`publish` 在完成自动化写入后落入 `PARTIAL`，并产出版本钉死的手动安装要求。操作者随后用 requirement 给出的隔离 `KIMI_CODE_HOME` 启动 Kimi Code，运行钉死的 `/plugins install <release-tag URL>`，把可信证明（同时绑定冻结**计划**摘要与快照**载荷**摘要）写入按计划摘要命名的目录 `.release-skill/kimi-attestations/<planDigest>/<plugin>/`，再运行 `reconcile`（→ `PUBLISHED`）与 `verify`（→ `VERIFIED`）；两者都从同一稳定位置读取证明。安装到日常 `~/.kimi-code` 不被接受。完整流程与证明 JSON 字段见 `INSTALL.zh-CN.md`。`verify` 在隔离目录安装每一个精确 npm `package@version`；配置 `smokeBin` 后还会运行 CLI 并校验输出。只有全部证据与冻结计划一致才进入 `VERIFIED`。默认分支名由每个 unit 的 `production.branchTemplate` 配置；同名远端对象存在时停止，交由人工判断。

### 发布文档刷新（可选）

发布单元可以声明 `releaseDocuments`，用一份结构化双语说明源确定性刷新 README 受管区域和 CHANGELOG 当前版本条目。核心 CLI 完全离线运行：不联网、不调用大模型、不自动翻译；只改写声明过的受管区域、唯一版本标记的机器值和 CHANGELOG 当前版本受管条目，区域外字节逐字保留。`prepare` 只检查新鲜度，不写工作树。

```yaml
# .release-skill/project.yaml（发布单元片段）
releaseUnits:
  - id: my-project
    source: .
    releaseDocuments:
      notesSource: release-notes/{version}.yaml
      locales: [en, zh-CN]
      changelogs:
        - path: CHANGELOG.md
          locale: en
      readmes:
        - path: README.md
          locale: en
          regions: [latest-release]
          versionMarkers:
            - id: current-version
              pattern: '<!-- release-skill:version -->v{version}<!-- /release-skill:version -->'
        - path: README.zh-CN.md
          locale: zh-CN
          regions: [latest-release]
```

1. **只读演练：**
   ```bash
   "${CLI[@]}" docs refresh --root "$PROJECT" --unit my-project --json
   ```
2. **摘要确认的本地写入（仅在用户明确授权“本地发布文档写入”后执行）：**
   ```bash
   "${CLI[@]}" docs refresh --root "$PROJECT" --unit my-project \
     --write --confirm-refresh <refreshDigest> \
     --ack-local-document-write --json
   ```

该授权只覆盖声明的本地发布文档目标，不是 hook、Git 提交、push、publish 或安装的授权：维护者必须审阅刷新结果并提交，然后重新 `prepare`。

### 父工作空间 + npm 子单元 + 插件子单元

当 monorepo 从不同目录同时产出 npm 包和 Claude/Codex/Kimi Code 插件时，应定义独立的发布单元。只有当某个单元确实以 manifest、marketplace 和 entry Skill 的形式发布插件时，才为其添加插件分发：

这里的 `project` 是父工作空间的编排容器，不是公开发布单元。如果工作区根目录也发布自己的仓库或包，再添加一个 `source: .` 的发布单元。`version.source` 相对于该发布单元的 `source` 目录解析（`version.source` is resolved relative to that release unit's `source` directory）：因此 `source: packages/app` 的单元写裸 `package.json`，而不是 `packages/app/package.json`。

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
      source: package.json
      tagTemplate: my-app-v{version}
    distributions:
      - type: npm
        package: my-app
        access: public
        provenance: false
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
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
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"

  - id: my-plugin
    source: packages/plugin
    publicRepo: owner/my-plugin
    version:
      source: package.json
      tagTemplate: my-plugin-v{version}
    distributions:
      # 只有当单元确实发布插件时才声明插件消费者。
      # CLI smoke 是独立的；只有当插件包同时暴露 CLI 二进制时才声明 smokeBin。
      - type: claude-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
        timeoutMs: 300000     # 可选；范围 30000-900000；默认 300000
      - type: codex-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
        timeoutMs: 300000     # 可选；范围 30000-900000；默认 300000
      - type: kimi-plugin
        plugin: my-plugin
        entrySkill: my-plugin-help
        timeoutMs: 300000     # 可选；范围 30000-900000；默认 300000（Kimi 无安装命令；仅约束只读验证）
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
      - from: packages/plugin/.kimi-plugin/plugin.json
        to: .kimi-plugin/plugin.json
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
      - .kimi-plugin/plugin.json
      - .agents/plugins/marketplace.json
      - skills/my-plugin-help/SKILL.md
      - README.md
      - package.json
      - LICENSE
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"
```

每个插件单元**必须**列出其 Claude/Codex/Kimi Code `plugin.json`、Claude/Codex 的 `marketplace.json`（Kimi Code 没有 marketplace 清单）、entry Skill 以及全部必需公开文件。CLI smoke（`smokeBin`）对插件单元是可选的，只适用于发布的 npm 包暴露 CLI 二进制的情况。

插件分发可以声明 `timeoutMs`（范围 30,000–900,000 ms；默认 300,000 ms），用于 marketplace add、插件安装与插件列表命令的子进程超时。真实网络下这些命令可能需要 40–105 秒；默认 300 秒超时可以避免误报 `PARTIAL`。解析后的值会冻结进计划，并随其他动作参数一起批准。没有 `timeoutMs` 的旧计划在执行时按 300,000 ms 兼容处理。

### PARTIAL 恢复与 reconcile

当 `publish` 在部分检查点成功但在其他检查点失败时，运行进入 `PARTIAL` 状态。**不要从头重跑，也不要删除远端状态。**

使用 `reconcile` 检查实际远端状态，跳过已一致的步骤，安全重试未完成的动作：

```bash
RECONCILE_JSON=$("${CLI[@]}" reconcile --root "$PROJECT" \
  --run "$PUBLISH_RUN_PATH" \
  --plan "$PLAN_PATH" \
  --approval "$APPROVAL_PATH" \
  --confirm-production "$PLAN_DIGEST" --json)
printf '%s\n' "$RECONCILE_JSON" | jq .
RECONCILE_RUN_PATH=$(printf '%s\n' "$RECONCILE_JSON" | jq -r '.runPath')
"${CLI[@]}" verify --root "$PROJECT" \
  --plan "$PLAN_PATH" --run "$RECONCILE_RUN_PATH" \
  --acknowledge-gate-side-effects --json
```

reconcile 成功只返回 `PUBLISHED`，不会返回 `VERIFIED`；只有全新运行的 verify 可以产生终态 `VERIFIED`。

## 已验收能力

- 验证项目配置和发布单元；
- `assess` 在不修改项目的前提下报告就绪度；
- 把配置的公开文件复制到隔离快照；
- 只读发现首次接入候选，经精确 `setupDigest` 确认后仅首次创建配置；
- 在冻结快照副本和精确消费者安装根运行经人工选择的项目 gate；
- 检查必需文件、路径安全、精确字节/权限和明显泄漏；
- 记录 Git/工作区身份，冻结绑定 digest 的发布计划；
- 用计划摘要、有效期和显式 action allowlist 绑定人工批准；
- 从冻结 Git object 和 npm tarball 发布，并核对远端 commit/tree/tag/integrity；
- 从冻结 Git ref 安装配置的 Claude/Codex 插件，证明入口 Skill 和安装载荷摘要；对 Kimi Code（无可脚本化安装接口）产出版本钉死的手动安装要求，仅依据绑定到冻结计划摘要的可信证明来确认入口 Skill 和载荷摘要；
- 明确区分 `PUBLISHED`（外写完成）与 `VERIFIED`（远端和消费者安装证据完成）；
- 中途失败停止后续动作，记录独立 run；不修改冻结 plan，不自动撤销已成功动作。

## 个性化验证：hook 与 gate

`hooks.docs/build/test/typecheck/lint` 在冻结前运行，适合确实需要生成源文件或依赖父工作区的步骤。它们可能修改项目或访问网络，prepare 必须显式传入 `--acknowledge-hook-side-effects`。

每个 hook 都是一个对象，`command` 是可执行文件/参数数组，不是 shell 字符串（`command` is an executable/argument array, not a shell string）。每个 hook 还声明 `cwd`、`timeoutMs` 和 `envAllowlist`：

```yaml
hooks:
  build:
    command: [node, scripts/build.mjs]
    cwd: .
    timeoutMs: 120000
    envAllowlist: [CI]
  test:
    command: [node, --test, test/]
    cwd: .
    timeoutMs: 300000
    envAllowlist: []
```

`verificationGates` 是更适合发布校准的受控扩展点：

```yaml
verificationGates:
  - id: package-contract
    phase: snapshot-verify
    scope: { unit: my-project }
    command:
      - node
      - -e
      - "const p=require('./package.json'); if (!p.name) process.exit(1)"
    cwd: .
    timeoutMs: 120000
    envAllowlist: [CI]
```

`snapshot-verify` 在冻结公开快照的一次性可写副本中执行；`consumer-verify` 在精确 npm/Claude/Codex/Kimi Code 隔离安装根执行。两者都使用命令数组而非 shell 字符串，定义和结果会进入摘要证据，并要求 prepare/verify 显式传入 `--acknowledge-gate-side-effects`。

push、tag、默认分支修改、GitHub Release 和 npm publish 不能放进 hook/gate，只能由冻结计划的受控动作执行。

## 当前不会做什么

<!-- release-skill:capability:unsupported-scope -->
- 不自动生成 README，不覆盖项目源文件；
- 不自动合并冲突，也不要求回滚工作流；
- 不声称已经替项目完成真实生产 canary；
- `prepare --online` 只观察 bound 前序基线；目标唯一性由 publish 全局预检完成；
- 不覆盖已有 branch/tag/Release，不 unpublish npm；
- 不承诺 Windows 或广泛的跨平台原生写入；
- 不会隐藏地 commit、push、打 tag、创建 Release 或发布包。

### 写入安全

`setup` 默认只读，写入只允许精确摘要确认后首次创建配置。`assess` 默认只读。`prepare` 会在 `.release-skill/` 下写本地文件，但不会写项目源文件或远端服务。如果配置了 hook，它就是任意本地进程，必须使用 `--acknowledge-hook-side-effects` 明确授权；gate 同样需要 `--acknowledge-gate-side-effects`。

`publish` 是唯一生产外写入口，必须同时提供 approval 和当前 plan digest。

### 失败时怎么办

| 结果 | 下一步 |
|---|---|
| `NEEDS_INPUT` | 补齐 setup 列出的仓库、tag、渠道、基线和 gate 人工决策。 |
| `LOCAL_ONLY_DETECTED` | 决定建立远端渠道或仅保留本地配置设计；不得冒充生产就绪。 |
| `SETUP_DIGEST_MISMATCH` | 项目事实或 answers 已变化；重新 dry-run、审阅并确认新摘要。 |
| `CONFIG_EXISTS` | setup 不覆盖已有配置；运行 assess 后人工增量修改。 |
| `SAFE_WRITE_UNAVAILABLE` | 当前平台不支持自动 create-once；保留只读报告，由人工首次创建经审阅的配置。 |
| `CONFIG_INVALID` | 修正 `.release-skill/project.yaml`，重新运行 `assess`。 |
| `PUBLIC_FILE_MISSING` | 添加或修正配置中的公开文件。 |
| `FORBIDDEN_CONTENT_DETECTED` | 移除泄漏或私有内容，再次 prepare。 |
| `SNAPSHOT_FIDELITY_FAILED` | 检查源文件和快照路径，重新运行 `prepare`。 |
| `BASELINE_CHANGED` | 保留人工修改，重新 prepare、审阅和 approve。 |
| `prepare` 阶段 `GATE_FAILED` | 修复 snapshot gate 或冻结公开制品，再生成一份新 plan。 |
| `verify` 阶段 `GATE_FAILED` | 若是消费者环境失败，修复环境后从同一 `PUBLISHED` run 重跑 verify；若是已发布制品缺陷，发布新的补丁版本。 |
| `PARTIAL` | 不重跑整套发布、不删除远端；审阅返回的 `runPath` 并运行 `reconcile`。 |
| `PUBLISHED` | 运行 `verify --plan <planPath> --run <publishRunPath>`；此时还不是终态。 |
| `VERIFIED` | 远端状态、精确 npm 安装和插件消费者安装都与冻结计划一致。 |

## Skills

- `release-help`：环境检查和下一步引导。
- `release-setup`：首次接入的只读发现、人工校准和 create-once 配置创建。
- `release-assess`：只读发布就绪度报告。
- `release-prepare`：本地快照和可审阅发布计划。
- `release-publish`：经批准、摘要确认的冻结 GitHub+npm 发布。
- `release-reconcile`：基于证据恢复 PARTIAL；冲突时人工介入。
- `release-verify`：发布后验证；只有 `VERIFIED` 才是 happy end。

## 许可证

MIT，见 [LICENSE](LICENSE)。
