# 安装指南

[English](INSTALL.md)

<!-- release-skill:release-version: 0.1.6 -->
## 前置条件

- Node.js 22.0.0 或更高版本
- Git 2.30 或更高版本

## 从 npm 安装（推荐）

公开版本只有在不可变生产计划经过批准、发布并达到 `VERIFIED` 后才算完整。对于更新的
源码检出，只有当 `npm view release-skill version` 返回该精确版本后才使用 npm 安装；
在此之前请使用下文的源码检出方式。

```bash
npm install -g release-skill
CLI=(release-skill)
```

也可以不安装，直接运行：

```bash
npx release-skill help
```

验证安装：

```bash
release-skill --version
release-skill help
```

输出中应包含版本号和可用命令列表。

## 开发安装（本地源码）

用于开发或尚未公开发布的源码候选：

```bash
export RELEASE_SKILL_HOME=/absolute/path/to/release-skill
cd "$RELEASE_SKILL_HOME"
npm exec --yes pnpm@10.17.1 -- install --frozen-lockfile
```

通过以下数组调用命令行工具：

```bash
CLI=(node "$RELEASE_SKILL_HOME/packages/release-skill/bin/release-skill.mjs")
"${CLI[@]}" help
```

当 `npm view release-skill version` 已确认目标版本公开并安装后，等价的 npm 入口是
`CLI=(release-skill)`。同一次运行不要混用 npm 与源码入口。

## 首次运行

最安全的首条命令始终是 `help`。它完全在本地运行，不写入文件：

```bash
"${CLI[@]}" help
```

如果项目尚无 `.release-skill/project.yaml`，把完整只读报告写入临时文件，只查看其中
确定性的 `compactSummary`（紧凑摘要）：

```bash
PROJECT=/path/to/your/project
SETUP_SESSION="$(mktemp -d "${TMPDIR:-/tmp}/release-setup.XXXXXX")"
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"

"${CLI[@]}" setup --root "$PROJECT" --json > "$REPORT" || test "$?" -eq 2
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary){console.error("compactSummary missing");process.exit(2)}process.stdout.write(JSON.stringify(r.compactSummary,null,2)+"\n")' "$REPORT"
```

紧凑摘要只是审阅视图，不是授权；`setupDigest` 仍绑定完整事实、候选和 answers。若
`proposalConflicts` 非空，必须由人工修正冲突的仓库/映射权威事实后重跑 setup，不能
猜测选边。没有冲突时，机械提取机器提案：

```bash
SETUP_SESSION='/上一步打印的会话目录绝对路径'
PROJECT='/上一步打印的项目绝对路径'
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if((r.proposalConflicts??[]).length){console.error("proposal conflicts require human resolution");process.exit(2)}if(!r.recommendedAnswers){console.error("recommendedAnswers missing");process.exit(2)}fs.writeFileSync(process.argv[2],JSON.stringify(r.recommendedAnswers,null,2)+"\n",{flag:"wx",mode:0o600})' "$REPORT" "$ANSWERS"
"${CLI[@]}" setup --root "$PROJECT" --answers "$ANSWERS" --json > "$BOUND_REPORT"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary||!r.setupDigest){console.error("bound setup report incomplete");process.exit(2)}process.stdout.write(JSON.stringify({compactSummary:r.compactSummary,setupDigest:r.setupDigest},null,2)+"\n")' "$BOUND_REPORT"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"
```

人工只确认一次绑定摘要和精确摘要值，然后使用已确认字面量首次创建。结果必须是
`CONFIG_CREATED`；第二次 setup 必须是 `ALREADY_CONFIGURED`，随后运行 assess。

```bash
SETUP_SESSION=<上一步打印的会话目录绝对路径>
PROJECT=<上一步打印的项目绝对路径>
ANSWERS="$SETUP_SESSION/answers.json"
CREATED_REPORT="$SETUP_SESSION/created.json"
POST_REPORT="$SETUP_SESSION/post-setup.json"
ASSESS_REPORT="$SETUP_SESSION/assess.json"
"${CLI[@]}" setup --root "$PROJECT" --answers "$ANSWERS" \
  --write --confirm-setup <已确认的 setupDigest> --json > "$CREATED_REPORT"
"${CLI[@]}" setup --root "$PROJECT" --json > "$POST_REPORT"
set +e
"${CLI[@]}" assess --root "$PROJECT" --offline --json > "$ASSESS_REPORT"
ASSESS_EXIT=$?
set -e
[ "$ASSESS_EXIT" -eq 0 ] || [ "$ASSESS_EXIT" -eq 1 ] || exit "$ASSESS_EXIT"
node -e 'const fs=require("node:fs");const [c,p,a]=process.argv.slice(1).map(x=>JSON.parse(fs.readFileSync(x,"utf8")));if(c.status!=="CONFIG_CREATED"||p.status!=="ALREADY_CONFIGURED"||!["ASSESSED","NEEDS_INPUT","BLOCKED"].includes(a.status)){process.exit(2)}process.stdout.write(JSON.stringify({created:c.status,postSetup:p.status,assessment:{status:a.status,summary:a.summary,gapCount:(a.gaps??[]).length,blockingCodes:(a.gaps??[]).filter(g=>g.severity==="error").map(g=>g.code)}},null,2)+"\n")' "$CREATED_REPORT" "$POST_REPORT" "$ASSESS_REPORT"
node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:false})' "$SETUP_SESSION"
```

解释器/包管理器间接脚本以 `SIDE_EFFECTS_UNPROVEN` 排除且默认不选。项目特有 hook/gate
只能经人工审阅后增量注册：hook 编辑 `projectConfig.hooks`；gate 编辑
`verificationGates` 并将同一 id 加入 `selectedGateIds`，然后重跑绑定 dry-run。人工文件使用 `mode: preserve`；显式跨单元共享源使用
`sourceScope: workspace`。

### 进阶 schema 参考——不是首次运行主路径

下面的外壳只说明 schema。正常 setup 不应手写，而应机械提取 `recommendedAnswers`。

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

这个外壳仅供参考。正常 setup 必须使用机器提案；只有确认不存在历史公开版本时才可
使用 `mode: none`。人工增量加入 gate 时，其 id 必须与 `selectedGateIds` 精确一致，
snapshot gate 及其依赖必须存在于 `publicFiles`。详见
[README 首次接入章节](README.zh-CN.md#首次接入不加载完整报告的确定性流程)。

已有配置永远不会被重新生成或覆盖。无法发现 GitHub/npm 渠道的项目返回
`LOCAL_ONLY_DETECTED`，不会冒充生产就绪。

自动 create-once 写入使用 v0.1.3 随包提供、带摘要登记的 `darwin-arm64` 原生预构建。
其他平台以 `SAFE_WRITE_UNAVAILABLE` 失败关闭；此时保留只读报告，由人工首次创建经审阅
的文件，不得启用不安全的路径写入兜底。

配置存在后，检查发布就绪度：

```bash
"${CLI[@]}" assess --root /path/to/your/project --offline --json
```

该命令只读地检查项目结构、配置、文档和供应链；未显式传入 `--output` 时不写报告，
也不运行项目 hook。

`prepare` 不同：它在目标项目的 `.release-skill/` 下写入发布工件，并可能运行已配置
hook。hook 是无沙箱的任意进程，可能写到项目外、访问凭据、使用网络或执行远端写入。
授予 `--acknowledge-hook-side-effects` 前必须审阅可执行文件、参数和工作目录。

Git 仓库应保留人工配置，同时忽略生成的权威文件和证据：

```gitignore
.release-skill/*
!.release-skill/project.yaml
```

## 项目配置

在项目根目录创建 `.release-skill/project.yaml`。以下是单包项目的最小示例：

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
    distributions:
      - type: npm
        package: my-project
        access: public
        provenance: false
        tag: latest
        registry: https://registry.npmjs.org
        publisher: my-npm-username
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
    requiredPublicFiles: [README.md, package.json, LICENSE]
    previousPublicBaseline:
      mode: none # 仅限已确认不存在历史公开版本
```

### 进阶：hook（可选）

hook 是可选的任意本地进程。prepare 使用 hook 时必须显式授予
`--acknowledge-hook-side-effects`：

```yaml
hooks:
  build:
    command: [npm, run, build]
  test:
    command:
      - node
      - -e
      - "const p=require('./package.json'); if (!p.name) process.exit(1)"
```

参数约束和安全要求见[完整 README](README.zh-CN.md)。

### 进阶：验证 gate（可选）

`snapshot-verify` 用于冻结公开快照的一次性可写副本；`consumer-verify` 用于精确且
隔离安装后的 npm/Claude/Codex 根目录。gate 使用可执行文件数组而不是 shell 字符串，
并声明 unit、必要时的 distribution、cwd、超时和环境变量白名单。

```yaml
verificationGates:
  - id: package-contract
    phase: snapshot-verify
    scope: { unit: my-project }
    command: [node, -e, "const p=require('./package.json');if(!p.name)process.exit(1)"]
    cwd: .
    timeoutMs: 30000
    envAllowlist: []
```

这个自包含示例只读取已映射的公开文件。若替换成项目脚本，该脚本及全部依赖必须
存在于冻结公开快照；gate 不能借用父工作空间中的测试、开发依赖或 `node_modules`。

当计划的当前阶段包含 gate 时，prepare 或 verify 必须传入
`--acknowledge-gate-side-effects`。hook/gate 都是无网络沙箱的项目进程；
release-skill 约束其输入与证据，但无法保证自定义命令不修改文件或不访问网络。
禁止把 Git push、tag、默认分支修改、GitHub Release 或 npm publish 注册为
hook/gate，它们只能由受控的计划动作完成。

### 进阶：发布文档刷新（可选）

发布单元可以声明 `releaseDocuments`，用一份结构化说明源确定性刷新 README 受管
区域和 CHANGELOG 当前版本条目。该命令离线运行：不联网、不调用大模型、不自动
翻译；只改写声明过的受管区域、唯一版本标记的机器值和 CHANGELOG 当前版本受管
条目，其他字节全部保留。`prepare` 只检查新鲜度，不写工作树。

```yaml
# .release-skill/project.yaml 的发布单元片段
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

`notesSource` 和所有目标路径均相对发布单元根；`versionMarkers[].pattern` 必须与
README 现有唯一版本标记精确匹配，刷新只替换机器版本值。说明源位于发布单元根
下，`version` 必须与解析出的单元版本一致，每个配置语种恰好出现一次且 summary
非空、至少一个变更类别有条目；YAML alias、重复键、未知字段和语种回退均失败
关闭：

```yaml
# release-notes/0.1.6.yaml
version: 0.1.6
date: 2026-07-21
locales:
  en:
    summary: Deterministic multilingual release-document refresh.
    changes:
      added:
        - Refresh managed README regions and changelogs from one source.
  zh-CN:
    summary: 从同一说明源确定性刷新多语种发布文档。
    changes:
      added:
        - 自动刷新 README 受管区域和 CHANGELOG。
```

先只读演练，确认后再带三项绑定写入：

```bash
"${CLI[@]}" docs refresh --root <your-project> --unit my-project --json
"${CLI[@]}" docs refresh --root <your-project> --unit my-project \
  --write --confirm-refresh <refreshDigest> --ack-local-document-write --json
```

`refreshDigest` 绑定规范说明对象、配置投影和按路径排序的逐文件新旧摘要，不绑定
时间、绝对路径或展示文本。摘要不匹配以 `RELEASE_DOCS_REFRESH_STALE` 失败关闭且
零写入；候选无变化时返回 `clean` 同样零写入。该授权只覆盖声明的本地文档目标，
不是 hook、提交、push、publish 或安装的授权。`prepare` 报告 `RELEASE_DOCS_STALE`
时，按“运行演练 → 审阅文件与语种 → 确认本地写入 → 审阅并提交 → 重新 prepare”
恢复。完整契约见 README 的发布文档刷新章节。

### 生产分支策略

每个生产发布单元显式选择一种策略：

- `create-release-branch`：创建此前不存在且不可变的 release 分支；
- `advance-existing-branch`：从精确绑定的公开基线用普通非 force push 快进已有分支；
- `initialize-default-branch`：创建不存在的标准分支；只有同时审阅
  `setAsDefaultBranch` 与 `expectedCurrentDefaultBranch` 后，计划才可增加显式默认分支动作。

远端漂移、非快进或默认分支不符合预期时必须停止并由人工介入。所有策略都禁止覆盖
远端历史。新建 ref 仅使用 `--force-with-lease=<ref>:` 作为“目标必须不存在”的原子
断言；推进已有分支使用普通非 force push。

```yaml
# create-release-branch：目标分支必须不存在
previousPublicBaseline: { mode: none } # 仅限真正的首次公开发布
production:
  branchTemplate: release/{tag}
  branchStrategy: create-release-branch
```

```yaml
# advance-existing-branch：ref 必须精确等于 refs/heads/<目标分支>
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
# initialize-default-branch：main 必须不存在，当前默认分支必须符合预期
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

后两种策略必须在线执行 production prepare。任何不一致都应停止并审阅；只有检查
真实远端状态后才能人工更新权威配置，禁止 force push 或弱化基线。

## 保护人工维护内容

README 文案、slogan、示例、排版及其他人工源文件始终是权威。release-skill 只按
`publicFiles` 映射做快照，不重新生成或覆盖源 README。每次人工编辑后重新 prepare，
并批准新的不可变计划；不得编辑冻结快照或复用旧批准绕过变化。

如果已有公开副本发生漂移，显式选择：

- **merge（合并）**：比较真实远端内容，把接受的改动合并回人工源文件，然后把
  `previousPublicBaseline` 绑定到精确不可变的 `repo`/`ref`/`commit`，再 prepare；
- **adopt（采纳）**：接受远端为新的事实来源，先带回人工源文件，再更新同一基线绑定；
- **reject（拒绝）**：停止并调查。不得改成 `mode: none` 绕过漂移或唯一性检查。

## 下一步

- 阅读[完整中文 README](README.zh-CN.md)了解整个工作流。
- 缺少配置时运行 `"${CLI[@]}" setup --root <your-project> --json`，在人工决策完成前
  保持默认 dry-run。
- 运行 `"${CLI[@]}" assess --root <your-project> --offline` 检查发布就绪度。
- 运行 `"${CLI[@]}" prepare --root <your-project> --offline` 生成发布计划；
  release-skill 自身只做本地写入，但项目 hook 可能执行远端操作。
- 生产前为每个 unit 配置 `previousPublicBaseline`。已有公开版本必须使用
  `mode: bound`，绑定精确 `repo`、`ref` 和 `commit`，再运行
  `"${CLI[@]}" prepare --root <your-project> --online --production`。默认观察器只证明
  ref 到 commit 的映射，不下载远端内容；目标 branch/tag/Release/npm 唯一性由
  publish 全局预检在任何 execute 前检查。
- 生产命令只使用 `prepare --json` 返回的不可变 `planPath`，以及 `approve --json`
  返回的不可变 `approvalPath`。可变的 latest 别名不能作为生产权威。
