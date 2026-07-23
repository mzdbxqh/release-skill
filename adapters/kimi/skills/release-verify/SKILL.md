---
name: release-verify
description: Post-publish verification including remote state recheck, exact npm installation smoke, and consumer plugin install verification
---

> **Kimi Code 安装入口解析协议**：Kimi Code 官方技能契约提供正文占位符 `${KIMI_SKILL_DIR}`，宿主在向 Agent 发送正文前会将其展开为当前 `SKILL.md` 所在目录的绝对路径。必须把展开后的字面量作为当前技能目录的唯一权威输入，记为 `SKILL_DIR`。
> 禁止从工作目录、可执行搜索路径、源码仓库、shell 调用上下文或任何未记载的宿主元数据路径猜测技能目录。若正文中的 `${KIMI_SKILL_DIR}` 未被宿主展开（仍是字面量占位符），立即停止并报告安装定位失败。
> 对 `SKILL_DIR` 执行 `realpath`，取其目录向上两级得到 `PLUGIN_ROOT`；校验真实技能路径匹配 `PLUGIN_ROOT/skills/*/SKILL.md` 且仍位于插件根内（路径包含检查）。
> 令 `RELEASE_SKILL_ENTRY=PLUGIN_ROOT/bin/release-skill.mjs`，对入口执行 `realpath` containment、`lstat` 非符号链接且为普通文件校验。
> 每一次 shell 工具调用都必须在同一个调用中用上述已验证绝对值设置 `RELEASE_SKILL_ENTRY`，然后执行 `node "$RELEASE_SKILL_ENTRY" ...`；不得依赖前一次 shell 的变量。
>

# release-verify

## 触发

用户请求验证发布结果完整性，或发布流程自动进入 verify 阶段。

## 当前状态

verify 是发布流程的最终验证阶段，是唯一能将状态提升到 `VERIFIED` 的命令。
它执行远端状态重检、精确 npm 安装烟雾测试和消费者插件安装验证。
verify 只接受 `PUBLISHED` 状态的源 run；`VERIFIED` 是终态，不会再次派生运行。

## 职责与边界

验证远端所有 action 的实际状态与冻结计划一致。执行精确 `<package>@<version>` npm 安装到隔离目录，验证包名、版本、bin 路径安全和 CLI 烟雾输出。对每个声明的 marketplace distribution 执行全新隔离消费者安装验证。

**阶段通过规则**: 只有 CLI exit code 0 和结构化状态码 `VERIFIED` 才是完整终态。

**源 run 要求**: `--run` 必需；源 run 的所有 checkpoint 必须为 succeeded 或 skipped。

**不确定性停止**: 任何验证失败立即停止，不进行部分降级。

## 正向执行路径

1. 确认有 `--run` 路径（必需），且源 run 状态为 PUBLISHED
2. 使用插件根相对路径运行 CLI；若存在 consumer gate 或 npm `smokeBin`，先逐项审阅并增加 `--acknowledge-gate-side-effects`
3. 检查 exit code 和结构化状态：`VERIFIED`（全部通过）/ 失败（具体错误）
4. 只有 `VERIFIED` 才是 happy end

## 确定性脚本调用

```bash
# 从插件根运行
node "$RELEASE_SKILL_ENTRY" verify --root <path> --plan <plan-path> --run <run-path> --json
# 计划含 consumer gate 或 smokeBin 时：
node "$RELEASE_SKILL_ENTRY" verify --root <path> --plan <plan-path> --run <run-path> --acknowledge-gate-side-effects --json
```

## 验证步骤

1. 加载并验证 release plan schema 和 digest
2. 加载源 run，验证 planDigest 匹配和 checkpoint 完整性
3. 对每个 plan action 执行 adapter.verify()（远端状态重检）
4. 对每个 npm distribution 执行隔离安装烟雾测试
5. 对每个 marketplace distribution 执行全新隔离消费者安装验证
6. 全部通过 → `VERIFIED`

## 烟雾测试

- 在 `os.tmpdir()` 创建隔离目录
- 执行 `npm install <package>@<version>` 带安全标志
- 验证安装的 `package.json` name 和 version 精确匹配
- 若配置了 `smokeBin`：验证 bin 路径安全（无逃逸、无 symlink），从精确安装根、隔离 HOME 和最小环境执行并验证输出；这会运行已安装代码，必须显式授权
- 若未配置 `smokeBin`：仅安装 + name/version 检查即通过

## 常见错误

| 场景 | 状态 | 处理 |
|------|------|------|
| 源 run 非 PUBLISHED | GATE_FAILED | 拒绝执行；VERIFIED 是终态 |
| 源 run 有 incomplete checkpoint | GATE_FAILED | 拒绝执行 |
| 远端状态不匹配 | POST_PUBLISH_VERIFY_FAILED | 停止 |
| npm 安装失败 | POST_PUBLISH_VERIFY_FAILED | 停止 |
| CLI 烟雾输出不匹配 | POST_PUBLISH_VERIFY_FAILED | 停止 |
| consumer gate / smokeBin 未授权 | GATE_FAILED | 展示命令和副作用，人工确认后加 `--acknowledge-gate-side-effects` |
