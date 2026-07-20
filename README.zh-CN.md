# release-skill

[English](README.md) · 安装指南：[中文](INSTALL.zh-CN.md) / [English](INSTALL.md)

<!-- release-skill:release-version: 0.1.5 -->
面向 Claude Code 和 Codex 的发布准备工具，完整保留人工维护的文件内容。

release-skill 帮助维护者回答三个问题：准备发布什么、还有哪些检查未通过、最终
发布的字节究竟是什么。它先冻结并供人工审阅，再从同一份冻结制品发布，不会在
最后一步重新生成 README、重新打包活动工作区或覆盖人工内容。

<!-- release-skill:capability:external-write-boundary -->
> **当前边界：** v0.1.5 是当前发布版本。v0.1.1 已完成 GitHub 与 npm 的
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
> **生产路径自 v0.1.1 里程碑起已完成真实生产验证；v0.1.5 是当前发布版本。**
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
- 发布只冻结当前真相：`prepare` 不会刷新或重写人工文档。维护者必须先更新
  README、INSTALL 与 CHANGELOG（包括必须与 `package.json` 版本一致的机器可读
  `release-skill:release-version` 标记，以及当前包版本的正式 CHANGELOG 标题），
  再 prepare、审阅和批准。任一文档版本标记或 CHANGELOG 当前版本条目漂移时，
  发布前门禁失败关闭。

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

设置源码路径并安装依赖：

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

### 首次接入：不加载完整报告的确定性流程

setup 默认只读。可能很大的完整报告只写入临时文件；用户和 Agent 只查看确定性的
`compactSummary`（紧凑摘要）审阅视图。紧凑摘要不能替代授权：`setupDigest` 仍绑定
完整事实、候选和 answers。

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

`NEEDS_INPUT` 和 `LOCAL_ONLY_DETECTED` 按设计返回退出码 2。若
`proposalConflicts` 非空，包括 `PUBLIC_REPO_AUTHORITY_CONFLICT` 或公开文件映射冲突，
必须停止自动路径，由人工修正冲突的仓库或映射权威事实后重新运行 setup，不得猜测选边。

没有冲突时，只能机械提取机器提案；Agent 不得重写或逐项抄写：

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

写入必须返回 `CONFIG_CREATED`，下一次 setup 必须返回 `ALREADY_CONFIGURED`。已有配置
永不重新生成，后续只做经审阅的增量编辑。解释器/包管理器间接脚本会以
`SIDE_EFFECTS_UNPROVEN` 排除，不会自动选择；项目特有 hook/gate 只有人工审阅后才
增量加入：hook 编辑 `projectConfig.hooks`；gate 编辑 `verificationGates` 并将同一 id
加入 `selectedGateIds`，随后重新运行绑定 dry-run。人工文件保持 `mode: preserve`；只有显式跨单元共享源才使用
`sourceScope: workspace`。

#### 进阶 schema 参考——不是首次接入主路径

下面只说明 schema 形状。正常 setup 不应手写，而应按上文机械提取
`recommendedAnswers`。

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

这是 schema 参考，不是接入模板。正常 setup 必须使用机器提案；只有确认不存在任何
历史公开版本时才可使用 `mode: none`。

下面的参考只说明人工审阅过的 gate 与 `selectedGateIds` 的精确对应关系。需要时仅对
已提取的机器提案做这一处增量编辑：

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

id 必须复制自当前 `gateCandidates`，不得自创。示例命令只依赖公开快照中的
`package.json`。如果改用项目脚本，该脚本及其全部依赖必须包含在 `publicFiles` 中；
snapshot gate 看不到父工作空间的测试、开发依赖或 `node_modules`，除非它们本来就是
显式公开内容。

```bash
release-skill setup --root /absolute/path/to/my-project \
  --answers /absolute/path/to/setup-answers.json --json
release-skill setup --root /absolute/path/to/my-project \
  --answers /absolute/path/to/setup-answers.json \
  --write --confirm-setup <setupDigest> --json
```

setup 只会原子创建不存在的 `.release-skill/project.yaml`。v0.1.3 的 create-once
写入使用随包提供、带摘要登记的 `darwin-arm64` 原生预构建；
不支持的平台会以 `SAFE_WRITE_UNAVAILABLE` 失败关闭，不会退回存在路径竞态的写法。
已有配置返回 `ALREADY_CONFIGURED`/`CONFIG_EXISTS`，后续由人工增量编辑；README、slogan、
CHANGELOG 和业务脚本不会被生成或覆盖。没有远端渠道时会返回
`LOCAL_ONLY_DETECTED`，表示生产渠道仍需人工建立或明确放弃。

下面是人工配置的最小示例；npm 可见性、公开文件边界和远端目标必须显式选择，
不能依赖工具猜测：

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
      mode: none              # 首次发布：确认不存在前序公开版本
    distributions:
      - type: npm
        package: my-project
        access: public       # 或 restricted；必须按真实包策略选择
        provenance: false    # 只有 CI/OIDC 已配置时才启用 true
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
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
      branchStrategy: create-release-branch
      releaseTitleTemplate: "{unit} {version}"
      releaseNotes: "人工维护的发布说明"
```

每个发布单元都必须声明前序公开基线。只有确认不存在任何前序公开版本时才使用
`mode: none`。已有公开仓库必须绑定不可变的 ref 和 commit：

```yaml
    previousPublicBaseline:
      mode: bound
      repo: owner/my-project
      ref: release/v0.9.0
      commit: 0123456789abcdef0123456789abcdef01234567
```

`none` 不是跳过冲突检查的开关：publish 仍会在任何写入前检查目标 branch、tag、
GitHub Release 和 npm version 的唯一性。bound 的生产 prepare 必须在线运行，以便
观察 ref 到 commit 的映射。
默认 observer 不下载远端文件内容，因此只能报告 mapping diff，并明确标记 content
diff unavailable。发生漂移时先停止发布，由人工取得并审阅真实远端 commit；工具
不会下载或合并远端文件。`merge` 表示在 human-owned 权威源中同时保留本地与远端
修改；`adopt` 表示把审阅后的远端字节复制回该权威源；`reject` 表示停止本次发布并
调查或修复远端/ref，禁止改成 `mode: none` 绕过。选择 `merge` 或 `adopt` 后，还必须
把 `previousPublicBaseline` 重新绑定到人工接受的不可变 `repo`/`ref`/`commit`，再运行
新的 `prepare --online --production`、审阅和 approve。

分支策略也必须符合真实仓库语义：

- `create-release-branch`：创建不存在的独立发布分支；同名分支存在即停止。
- `advance-existing-branch`：在 `previousPublicBaseline` 精确提交上创建单父提交，
  只允许普通 fast-forward push；远端并发漂移时交由人工。
- `initialize-default-branch`：受控创建不存在的标准分支；只有显式配置
  `setAsDefaultBranch` 和 `expectedCurrentDefaultBranch` 时，默认分支切换才成为
  计划中可批准、可观察、可 reconcile 的独立动作。

三种策略的最小配置如下：

```yaml
# 新建不可变 release 分支；目标必须不存在。
previousPublicBaseline: { mode: none } # 仅限真正的首次公开发布
production:
  branchTemplate: release/{tag}
  branchStrategy: create-release-branch
```

```yaml
# 推进 main；绑定的 ref 必须与目标分支精确一致。
previousPublicBaseline:
  mode: bound
  repo: owner/my-project
  ref: refs/heads/main
  commit: 0123456789abcdef0123456789abcdef01234567
production:
  branchTemplate: main
  branchStrategy: advance-existing-branch
```

```yaml
# 一次性创建尚不存在的 main，并显式切换默认分支。
previousPublicBaseline:
  mode: bound
  repo: owner/my-project
  ref: refs/heads/old-public-branch
  commit: 0123456789abcdef0123456789abcdef01234567
production:
  branchTemplate: main
  branchStrategy: initialize-default-branch
  setAsDefaultBranch: true
  expectedCurrentDefaultBranch: old-public-branch
```

后两种策略必须运行 `prepare --online --production`。如果观察到的分支、commit、
目标不存在性或当前默认分支与预期不符，先停止并审阅真实远端状态，再人工更新权威
源文件/配置；禁止 force push 或弱化基线。

这只是解释机制的本地示例，不是完整的 npm 发布清单。真实发布前必须枚举全部
公开运行时代码、可执行文件、类型声明、图片和链接文档。monorepo 应把 `source`
设为 `packages/my-plugin` 之类的子目录；每个 `from` 仍相对工作空间根，例如
`packages/my-plugin/README.md`。

首次 prepare 前，建议提交 `.gitignore`、`.release-skill/project.yaml`、README、版本文件和
全部待发布内容，使 Git baseline 易于复现。prepare 前已有且之后未变化的未提交修改也会
进入 snapshot/baseline；只有 prepare 后再次变化才会使后续 baseline 校验停止。

### 主流程

按以下顺序执行。步骤 1–4 是安全默认（只读或仅本地）；步骤 5–9 是需要显式
人工门禁的生产发布。

```bash
# npm 安装的 CLI（推荐）：
CLI=(release-skill)
PROJECT=/absolute/path/to/my-project
ACTOR=your-name
# 开发回退（源码 checkout）：
# CLI=(node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs")
```

v0.1.1 生产发布验证完成后，npm 安装的 CLI 是受支持的用户入口；
源码 checkout 保留为开发/贡献者路径。

1. **环境检查：**
   ```bash
   "${CLI[@]}" help
   ```
2. **首次接入（仅缺少配置时，只读）：**
   ```bash
   "${CLI[@]}" setup --root "$PROJECT" --json
   ```
   按上文机械提取 `compactSummary` 与 `recommendedAnswers`，只确认一次绑定后的
   `setupDigest`；配置已存在时跳过。
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
   只有项目配置没有对应 hook 或 snapshot gate 时，才省略相应授权参数。授权前
   必须审阅可执行文件、参数、工作目录和副作用，不能把授权参数当固定样板。
5. **人工审阅：** 检查返回的 `planPath`、`externalActions`、
   `units[].targetVersion` 和 `planDigest`。每个发布单元的快照位于
   `<evidenceDir>/snapshots/<unit-id>/`。release-skill 自身只把数据写入
   `.release-skill/`；获得授权的项目 hook/gate 是无沙箱进程，可能写入其他位置或
   访问网络。
6. **生产计划冻结：**
   ```bash
   PRODUCTION_JSON=$("${CLI[@]}" prepare --root "$PROJECT" --online --production \
     --acknowledge-hook-side-effects \
     --acknowledge-gate-side-effects --json)
   printf '%s\n' "$PRODUCTION_JSON" | jq .
   PLAN_PATH=$(printf '%s\n' "$PRODUCTION_JSON" | jq -r '.planPath')
   PLAN_DIGEST=$(printf '%s\n' "$PRODUCTION_JSON" | jq -r '.planDigest')
   ```
   同样，只省略配置不需要的授权，并在授权前逐项审阅项目进程。
   审阅新 plan 的 externalActions、npm access/provenance/tag、branch/tag 和冻结摘要。
   `prepare --json` 返回的生产权威 `planPath` 指向
   `<项目>/.release-skill/plans/<planDigest>.json`，后续必须始终沿用这个返回值。
   `.release-skill/release-plan.json` 只是可变便利副本，不得传给生产
   approve/publish/reconcile。
7. **批准：**
   ```bash
   APPROVAL_JSON=$("${CLI[@]}" approve --plan "$PLAN_PATH" \
     --digest "$PLAN_DIGEST" --actor "$ACTOR" --json)
   printf '%s\n' "$APPROVAL_JSON" | jq .
   APPROVAL_PATH=$(printf '%s\n' "$APPROVAL_JSON" | jq -r '.approvalPath')
   ```
   返回的生产权威 `approvalPath` 指向
   `<项目>/.release-skill/approvals/<planDigest>/<approvalDigest>.json`。
   `latestApprovalPath` 指向 `.release-skill/approval-record.json`，它只是可变便利
   副本，不得传给生产 publish/reconcile。批准 24 小时失效；PARTIAL 恢复可为同一
   plan 重新批准，同时逐字节保留全部旧批准。后续必须使用返回的 immutable
   `approvalPath` 和 `expiresAt`。
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
   只有计划既没有 consumer gate，也没有 npm `smokeBin` 时才省略授权。两者都会
   执行已安装的项目代码，而且没有操作系统或网络沙箱。

以上返回值交接示例依赖 `jq`。没有 `jq` 时必须从 JSON 原样复制这四个字段；不要把
文档其他位置的尖括号标签直接当作 shell 语法。

生产 prepare 会把每个公开快照封存为独立 Git commit/tree，并为 npm 单元生成固定
tarball。`publish` 先对所有动作做只读预检，再按“公开快照 branch → tag → npm →
GitHub Release → Claude/Codex 插件市场（marketplace）安装”执行并逐项观察。`verify` 在隔离目录
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
      source: packages/plugin/package.json
      tagTemplate: my-plugin-v{version}
    distributions:
      # 只有当单元确实发布插件时才声明插件消费者。
      # CLI 冒烟独立；只有插件包同时暴露 CLI 二进制时才声明 smokeBin。
      - type: claude-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
        timeoutMs: 300000     # 可选；范围 30000–900000；默认 300000
      - type: codex-plugin
        plugin: my-plugin
        marketplace: my-plugin
        entrySkill: my-plugin-help
        timeoutMs: 300000     # 可选；范围 30000–900000；默认 300000
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
    previousPublicBaseline:
      mode: none
    production:
      branchTemplate: release/{tag}
      releaseTitleTemplate: "{unit} {version}"
```

每个插件单元**必须**列出 Claude/Codex `plugin.json`、`marketplace.json`、
入口 Skill 和全部 required public files。CLI 冒烟（`smokeBin`）对插件单元
是可选项，仅当发布包同时暴露 CLI 二进制时才适用。

插件分发可声明 `timeoutMs`（范围 30,000–900,000 毫秒；默认 300,000 毫秒），
用于设置 marketplace add、plugin install 和 plugin list 三条命令的子进程超时。
真实网络下这些命令可能需要 40–105 秒；默认 300 秒超时避免误报 `PARTIAL`。
解析后的值冻结到计划中，与其他动作参数一起接受批准。无 `timeoutMs` 的旧计划
在执行时默认回退到 300,000 毫秒以保证向后兼容。

### PARTIAL 恢复与 reconcile

当 `publish` 在部分检查点成功但在其他检查点失败时，运行进入 `PARTIAL`
状态。**不要从头重跑，也不要删除远端状态**（例如不要删除已推送的 tag 或
unpublish 已发布的包）。

使用 `reconcile` 检查实际远端状态，跳过已一致的步骤，安全重试未完成的动作：

```bash
RECONCILE_JSON=$("${CLI[@]}" reconcile --root "$PROJECT" \
  --run "$PUBLISH_RUN_PATH" \
  --plan "$PLAN_PATH" \
  --approval "$APPROVAL_PATH" \
  --confirm-production "$PLAN_DIGEST" --json)
printf '%s\n' "$RECONCILE_JSON" | jq .
RECONCILE_RUN_PATH=$(printf '%s\n' "$RECONCILE_JSON" | jq -r '.runPath')
# 保存 reconcile 返回的新 runPath，再执行全新的安装验证。
"${CLI[@]}" verify --root "$PROJECT" \
  --plan "$PLAN_PATH" --run "$RECONCILE_RUN_PATH" \
  --acknowledge-gate-side-effects --json
```

只有冻结计划既没有 consumer gate，也没有 npm `smokeBin` 时才省略 verify 授权。
以上变量沿用主流程从 JSON 提取的精确值；如果恢复期间批准已过期，应为同一个不可变
计划重新批准，并在 reconcile 前替换 `APPROVAL_PATH`。

`reconcile` 查询实际远端状态（Git refs、npm 版本、GitHub Release、
marketplace 安装），跳过证据已匹配冻结计划的步骤，只重试安全且未完成的
步骤。远端冲突（例如意外的 tag 或 npm 版本）需要人工判断，无法自动解决。
reconcile 成功只返回 `PUBLISHED`，不会返回 `VERIFIED`；只有全新运行的 verify
可以产生终态 `VERIFIED`。

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
- 从冻结 Git ref 安装配置的 Claude/Codex 插件，证明入口 Skill 和安装载荷摘要；
- 明确区分 `PUBLISHED`（外写完成）与 `VERIFIED`（远端和消费者安装证据完成）；
- 中途失败停止后续动作，记录独立 run；不修改冻结 plan，不自动撤销已成功动作。

## 个性化验证：hook 与 gate

`hooks.docs/build/test/typecheck/lint` 在冻结前运行，适合确实需要生成源文件或依赖
父工作区的步骤。它们可能修改项目或访问网络，prepare 必须显式传入
`--acknowledge-hook-side-effects`。

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
  - id: installed-help
    phase: consumer-verify
    scope: { unit: my-project, distribution: npm }
    command: [node, scripts/check-installed-help.mjs]
    cwd: .
    timeoutMs: 30000
    envAllowlist: []
    expectedJson: { status: READY }
```

snapshot 示例刻意设计为自包含，只读取已映射的公开文件。若替换成项目脚本，该脚本
及其全部依赖必须存在于冻结公开快照；consumer 脚本也必须存在于精确安装的发行物。
gate 不能借用父工作空间中的测试、开发依赖或 `node_modules`。

`snapshot-verify` 在冻结公开快照的一次性可写副本中执行；`consumer-verify` 在精确
npm/Claude/Codex 隔离安装根执行。两者都使用命令数组而非 shell 字符串，定义和
结果会进入摘要证据，并要求 prepare/verify 显式传入
`--acknowledge-gate-side-effects`。gate 仍是无网络沙箱的项目进程，release-skill
无法保证它不会写文件或访问网络。push、tag、默认分支切换、GitHub Release 和
npm publish 不能放进 hook/gate，只能由冻结计划的受控动作执行。

## 当前不会做什么

<!-- release-skill:capability:unsupported-scope -->
- 不自动生成 README，不覆盖项目源文件；
- 不自动合并冲突，也不要求回滚工作流；
- 不声称已经替项目完成真实生产 canary；
- `prepare --online` 只观察 bound 前序基线的 ref→commit 映射；目标唯一性由
  publish 全局预检完成；
- 不覆盖已有 branch/tag/Release，不 unpublish npm；新建 ref 仅使用
  `--force-with-lease=<ref>:` 作为“目标必须不存在”的原子比较并设置断言，推进已有
  分支使用普通非 force push；
- 不承诺 Windows 或广泛的跨平台原生写入；
- 不会隐藏地 commit、push、打 tag、创建 Release 或发布包。

### 写入安全

`setup` 默认只读，写入只允许精确摘要确认后首次创建配置。`assess` 默认只读，
只有显式指定报告输出时才写报告。`prepare` 会在
`.release-skill/` 下写本地文件，但不会写项目源文件或远端服务。如果配置了
hook，它就是任意本地进程，必须使用 `--acknowledge-hook-side-effects` 明确授权；
gate 同样是项目进程，必须使用 `--acknowledge-gate-side-effects` 明确授权。它们
可能自行产生文件系统或网络副作用。`publish` 是唯一生产外写入口，必须同时
提供 approval 和当前 plan digest。最小安全演练应省略 hook，并在本地沙箱目标运行。

### 失败时怎么办

| 结果 | 下一步 |
|---|---|
| `NEEDS_INPUT` | 补齐 setup 列出的仓库、tag、渠道、基线和 gate 人工决策。 |
| `LOCAL_ONLY_DETECTED` | 决定建立远端渠道或仅保留本地配置设计；不得冒充生产就绪。 |
| `SETUP_DIGEST_MISMATCH` | 项目事实或 answers 已变化；重新 dry-run、审阅并确认新摘要。 |
| `CONFIG_EXISTS` | setup 不覆盖已有配置；运行 assess 后人工增量修改。 |
| `SAFE_WRITE_UNAVAILABLE` | 当前平台不支持自动 create-once；保留只读报告，由人工首次创建经审阅的配置，且不得覆盖已有文件。 |
| `CONFIG_INVALID` | 修正 `.release-skill/project.yaml`，重新运行 `assess`。 |
| `PUBLIC_FILE_MISSING` | 添加或修正配置中的公开文件。 |
| `FORBIDDEN_CONTENT_DETECTED` | 移除泄漏或私有内容，再次 prepare。 |
| `SNAPSHOT_FIDELITY_FAILED` | 检查源文件和快照路径，重新运行 `prepare`。 |
| `BASELINE_CHANGED` | 保留人工修改，重新 prepare、审阅和 approve。 |
| `prepare` 阶段 `GATE_FAILED` | 修复 snapshot gate 或冻结公开制品，再生成一份新 plan；失败 plan 不得批准。 |
| `verify` 阶段 `GATE_FAILED` | 若是消费者环境失败，修复环境后从同一 `PUBLISHED` run 重跑 verify；若是已发布制品缺陷，发布新的补丁版本，不覆盖旧制品。 |
| `PARTIAL` | 不重跑整套发布、不删除远端；审阅返回的 `runPath` 并运行 `reconcile`（见上文）。 |
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

冲突默认仍由人工介入。v0.1.1 生产发布后，受支持的用户入口是 npm 安装的
`release-skill` CLI；源码 checkout 保留为开发/贡献者路径。

## 许可证

MIT，见 [LICENSE](LICENSE)。
