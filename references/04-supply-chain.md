# 04 -- 供应链安全

本文档定义 release-skill 在 GitHub、npm 和插件 marketplace 发布中的安全要求，包括 provenance、签名、Action SHA 固定和最小权限模型。配置中的 hook 安全约束见 `02-project-config.md`，adapter 接口见 `06-adapter-contract.md`。

---

## 1. 最小权限原则

### 1.1 GitHub Actions

- 权限按 job 收紧，不使用仓库级默认宽权限。
- 每个 job 仅声明其实际需要的 `permissions`。
- 使用 `persist-credentials: false` 防止 token 留在 git 配置中。
- 使用 GitHub App Token 或 Fine-grained PAT 替代 Classic PAT，实现精细权限控制。

### 1.2 npm

- 优先使用 Trusted Publishing（npm OIDC），不存储长期 npm token。
- 若必须使用 token，限定 scope 为最小必要范围。
- 使用 `npm publish --access public` 显式声明公开范围。

### 1.3 插件 marketplace

- 插件发布凭据限定为 marketplace 注册操作。
- 不在 CI 环境中存储 Claude/Codex API 凭据。

---

## 2. Provenance 与签名

### 2.1 npm Provenance

- npm 包发布时必须携带 provenance 证明（`--provenance` 标志）。
- Provenance 通过 OIDC token 由 CI 环境签名，证明包的构建来源和构建过程。
- 发布后验证阶段（见 `01-state-machine.md` VERIFIED）检查 npm provenance 状态。

### 2.2 Git Tag 签名

- 发布 tag 优先使用 GPG 或 SSH 签名。
- 若无法签名，tag 必须具备可追溯性：commit hash、创建时间、创建者身份记录在发布证据中。
- 签名或可追溯性信息在批准界面展示。

### 2.3 Commit 签名

- 版本提交优先签名。
- 签名状态记录在基线快照中。

---

## 3. 第三方 Action SHA 固定

### 3.1 规则

所有第三方 GitHub Action 必须固定到完整 commit SHA（40 字符），不接受分支名或语义版本标签。

```yaml
# 正确：固定到 SHA
- uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11

# 错误：使用标签
- uses: actions/checkout@v4

# 错误：使用分支
- uses: actions/checkout@main
```

### 3.2 验证

- 配置加载时检查所有 Action 引用格式。
- 不符合 SHA 固定要求的 Action 引用返回 `CONFIG_INVALID` 错误码。

---

## 4. Secret 检测

### 4.1 检测范围

公开快照和发布产物中必须扫描以下内容：

- 配置中声明的 `forbiddenContentPatterns`。
- 通用 token 前缀：`ghp_`、`github_pat_`、`npm_`、`AKIA`。
- 私钥标记：`BEGIN RSA PRIVATE KEY`、`BEGIN EC PRIVATE KEY`、`BEGIN OPENSSH PRIVATE KEY`。
- 本机绝对路径：`<project-root>/` 前缀。
- 内部目录名：`research/`、`standards/`、`runs/`、`docs/superpowers/`。

### 4.2 检测行为

- 检测到 secret 时返回 `SECRET_DETECTED` 错误码。
- 错误信息中不记录 secret 的实际值，仅记录类型和位置。
- 日志中不记录 token、认证头、npm 配置内容或未经脱敏的环境变量（见 `05-evidence-and-errors.md` 脱敏规则）。

### 4.3 禁止路径

以下路径不得出现在公开快照中：

- 父工程专属目录：`standards/`、`research/`、`runs/`、`docs/superpowers/`。
- 配置中声明的 `forbiddenPaths`。
- 本机绝对路径。

检测到禁止路径时返回 `PUBLIC_PATH_FORBIDDEN` 错误码。

---

## 5. 公开快照安全

### 5.1 导出规则

- 仅从 `git ls-files` 跟踪的文件中导出。
- 显式声明的生成文件和 `package.json` 的 `files` 字段纳入导出范围。
- 拒绝符号链接逃逸到源码根目录之外。
- 拒绝大小写归一化后的重复目标路径。
- 拒绝设备文件。

### 5.2 构建物检查

- `dist/` 目录中的文件与当前构建清单比对。
- 构建清单不匹配的陈旧构建物返回 `STALE_BUILD_ARTIFACT` 错误码。

---

## 6. 策略与 Waiver

### 6.1 安全策略

项目通过 `policy` 字段声明安全要求（见 `02-project-config.md`）：

- `requiredPublicFiles`：必须出现在公开快照中的文件列表。
- `forbiddenPaths`：不得出现在公开快照中的路径列表。
- `forbiddenContentPatterns`：不得出现在公开快照内容中的正则模式列表。

### 6.2 不可豁免项

以下安全要求不得通过 overlay 或 waiver 关闭（详见 `02-project-config.md` 第 5、6 节）：

1. Secret 扫描。
2. 发布计划摘要校验。
3. 显式授权门。
4. 发布后验证。

---

## 7. 跨标准引用

- 配置 schema、hooks 和 overlay 限制见 `02-project-config.md`。
- 错误码定义和脱敏规则见 `05-evidence-and-errors.md`。
- Adapter 接口和外部写授权门见 `06-adapter-contract.md`。
- 发布后验证阶段见 `01-state-machine.md` VERIFIED 状态。
