---
name: release-setup
description: "首次接入 release-skill：只读发现发布单元与个性化验证候选，机械提取提案，经人工确认 setupDigest 后仅首次创建配置"
---

# release-setup

## 适用场景

项目尚无 `.release-skill/project.yaml`，或用户要求初始化、接入、校准发布规则时使用。配置已存在时只审计并路由到 `release-assess`，不得重新生成。

## 硬边界

- 默认只读。README、slogan、CHANGELOG、业务脚本和已有配置均为人工权威内容，不得重写或覆盖。
- 发现脚本不等于选择或授权。间接脚本以 `SIDE_EFFECTS_UNPROVEN` 排除；项目特有 hook/gate 只能人工增量注册。
- 仓库、公开文件等证据冲突时停止自动提案，交给人工修正权威事实后重新发现。
- 写入只允许 create-once（仅创建一次），必须同时提供 answers 与精确 `setupDigest`；无安全原生写入能力时失败关闭。
- Agent 的多次 shell 调用彼此独立；只能用首轮打印的会话目录绝对路径续接，不得假设变量仍存在。

## 首次接入

1. 检查入口：

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" help --json
```

2. 只读发现并机械提取提案。完整报告仅写入临时会话目录；不要设置 `trap EXIT`，确认前必须保留会话文件：

```bash
set -eu
PROJECT=<项目绝对路径>
SETUP_SESSION="$(mktemp -d "${TMPDIR:-/tmp}/release-setup.XXXXXX")"
REPORT="$SETUP_SESSION/discovery.json"
ANSWERS="$SETUP_SESSION/answers.json"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"
set +e
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" setup --root "$PROJECT" --json > "$REPORT"
SETUP_STATUS=$?
set -e
[ "$SETUP_STATUS" -eq 0 ] || [ "$SETUP_STATUS" -eq 2 ] || exit "$SETUP_STATUS"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary){console.error("compactSummary missing");process.exit(2)}process.stdout.write(JSON.stringify(r.compactSummary,null,2)+"\n")' "$REPORT"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if((r.proposalConflicts??[]).length){console.error("proposal conflicts require human resolution");process.exit(2)}if(!r.recommendedAnswers){console.error("recommendedAnswers missing");process.exit(2)}fs.writeFileSync(process.argv[2],JSON.stringify(r.recommendedAnswers,null,2)+"\n",{flag:"wx",mode:0o600})' "$REPORT" "$ANSWERS"
```

若 `proposalConflicts` 非空，暂停，让用户修正仓库/映射权威事实，删除本会话目录后从第 2 步重跑，不得猜测选边。无冲突时可人工增量编辑 `answers.json`：hook 写入 `recommendedAnswers.projectConfig.hooks` 对应的 `projectConfig.hooks`；gate 写入 `verificationGates`，并把同一 id 加入 `selectedGateIds`。人工文件保持 `mode: preserve`，跨单元共享源使用 `sourceScope: workspace`。

3. 使用上一步打印的两个绝对字面量重新赋值，运行绑定 dry-run；任何人工编辑后都必须重跑本步：

```bash
set -eu
SETUP_SESSION=<上一步打印的会话目录绝对路径>
PROJECT=<上一步打印的项目绝对路径>
ANSWERS="$SETUP_SESSION/answers.json"
BOUND_REPORT="$SETUP_SESSION/bound.json"
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" setup --root "$PROJECT" --answers "$ANSWERS" --json > "$BOUND_REPORT"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.compactSummary||!r.setupDigest){console.error("bound setup report incomplete");process.exit(2)}process.stdout.write(JSON.stringify({compactSummary:r.compactSummary,setupDigest:r.setupDigest},null,2)+"\n")' "$BOUND_REPORT"
printf 'SETUP_SESSION=%s\nPROJECT=%s\n' "$SETUP_SESSION" "$PROJECT"
```

只向用户展示绑定摘要、配置差异和精确 `setupDigest`，取得一次明确确认。

4. 确认后用原会话与已确认摘要首次创建。三个完整报告均重定向到文件，固定提取器成功后才清理会话目录：

```bash
set -eu
SETUP_SESSION=<已确认会话目录的绝对路径>
PROJECT=<已确认项目的绝对路径>
CONFIRMED_SETUP_DIGEST=<用户确认的精确 setupDigest>
ANSWERS="$SETUP_SESSION/answers.json"
CREATED_REPORT="$SETUP_SESSION/created.json"
POST_REPORT="$SETUP_SESSION/post-setup.json"
ASSESS_REPORT="$SETUP_SESSION/assess.json"
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" setup --root "$PROJECT" --answers "$ANSWERS" --write --confirm-setup "$CONFIRMED_SETUP_DIGEST" --json > "$CREATED_REPORT"
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" setup --root "$PROJECT" --json > "$POST_REPORT"
set +e
node "${CLAUDE_PLUGIN_ROOT}/bin/release-skill.mjs" assess --root "$PROJECT" --offline --json > "$ASSESS_REPORT"
ASSESS_EXIT=$?
set -e
[ "$ASSESS_EXIT" -eq 0 ] || [ "$ASSESS_EXIT" -eq 1 ] || exit "$ASSESS_EXIT"
node -e 'const fs=require("node:fs");const [c,p,a]=process.argv.slice(1).map(x=>JSON.parse(fs.readFileSync(x,"utf8")));if(c.status!=="CONFIG_CREATED"||p.status!=="ALREADY_CONFIGURED"){console.error("setup lifecycle verification failed");process.exit(2)}if(!["ASSESSED","NEEDS_INPUT","BLOCKED"].includes(a.status)){console.error("assessment report invalid");process.exit(2)}const blocking=(a.gaps??[]).filter(g=>g.severity==="error").map(({code,scope,message})=>({code,scope,message}));process.stdout.write(JSON.stringify({created:{status:c.status,compactSummary:c.compactSummary},postSetup:{status:p.status,compactSummary:p.compactSummary},assessment:{status:a.status,summary:a.summary,gapCount:(a.gaps??[]).length,blockingGaps:blocking}},null,2)+"\n")' "$CREATED_REPORT" "$POST_REPORT" "$ASSESS_REPORT"
node -e 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:false})' "$SETUP_SESSION"
```

## 故障路由

- `NEEDS_INPUT`：审阅紧凑摘要；有冲突先修正权威事实并重跑。
- `LOCAL_ONLY_DETECTED`：只能建立本地配置，由用户决定是否创建远端渠道。
- `ALREADY_CONFIGURED` / `CONFIG_EXISTS`：不覆盖，转 `release-assess`。
- `SETUP_DIGEST_MISMATCH`：事实或 answers 已变化，重新只读发现与确认。
- `SAFE_WRITE_UNAVAILABLE`：保留只读报告，不启用普通路径写入兜底。

## 完成标准

完整报告未进入 Agent 上下文；跨 shell 只靠显式会话路径续接；无冲突提案由机器机械提取；写入仅创建一次且摘要精确匹配；创建后状态和 assess 只输出紧凑结果；人工文件保持原字节。
