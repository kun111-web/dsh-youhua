# 工作区插件管理

## 安装到 DSH

正式版日常安装和升级使用 GitHub Release 附件的 `.tgz` 下载地址，也可先下载，再用文件的完整路径离线安装。安装后核对桌面配置中的依赖来源和已安装版本。

开发验证使用带版本号的本地 `.tgz`。`scripts/local-registry.mjs` 仅供本机测试，从各插件的 `dist/` 读取带 SHA-256 校验记录的安装包，在 `127.0.0.1` 提供下载。

## 版本更新

每批改动只要涉及工作区内的插件项目，就必须在同一批改动中提升对应插件的版本号。涉及多个插件时，各自提升版本号。修复和小改动至少提升补丁版本号。

1. 同步更新插件 `package.json` 的版本和描述中的版本号，以及 `package-lock.json` 的顶层和根包版本。
2. 将 `install.ps1` 指向新版安装包，并更新工作区及插件文档中的当前版本和安装示例。历史版本记录按原版本保留。
3. 发布新版时运行测试并生成新版 `.tgz`，核对包内版本并更新 `dist/SHA256SUMS.txt`。

## GitHub 同步

工作区对应 GitHub 主仓库 [kun111-web/dsh-youhua](https://github.com/kun111-web/dsh-youhua)。本地 `main` 跟踪 `origin/main`。

1. 同步前用 `git status --short --branch` 和 `git diff` 确认当前分支及改动范围，只暂存本次任务涉及的文件。
2. 发布新版时，将版本改动、对应 `.tgz` 和 `dist/SHA256SUMS.txt` 一起提交。会话数据、隔离环境和本机 QA 产物留在本地。
3. 推送 `main` 后，核对 GitHub 的 `main` 已包含本次提交。

## 公开发布

GitHub Releases 是本仓库插件的唯一公开分发渠道。停止向 npm 发布正式版和测试版。

1. 使用统计和归档管理发布到 `kun111-web/dsh-youhua`。
2. 确认发版提交已推送到 GitHub 后，为每个发版插件直接在 GitHub 创建标签和 Release。标签采用 `<包名>-v<版本号>`，并指向包含该版本源码、安装包和校验记录的发版提交。可用 `gh release create` 的 `--target` 指定完整提交 SHA，由 GitHub 创建远程标签。
3. 每个 Release 上传通过测试和校验的版本化 `.tgz` 及对应的 `SHA256SUMS.txt`。发布说明注明「本插件参考 ZCode 源码进行优化，并适配 DeepSeek Harness（DSH）」。
4. 发布后核对 GitHub 标签指向的提交，以及 Release 附件的文件名和 SHA-256，确保与工作区 `dist/SHA256SUMS.txt` 一致。
