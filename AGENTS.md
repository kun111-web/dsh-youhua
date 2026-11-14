# 工作区插件管理

## 安装到 DSH

本工作区的新增插件和已有插件的新版本，安装到 DSH 桌面配置前都必须先打包为带版本号的 `.tgz`。可用安装包的完整文件路径或 HTTP 地址安装，也可通过 DSH 的「自定义地址」按包名和版本安装。`scripts/local-registry.mjs` 从各插件的 `dist/` 读取带 SHA-256 校验记录的版本化 `.tgz`，只在 `127.0.0.1` 提供下载。安装后核对桌面配置中的依赖来源和已安装版本。

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

## 发布到 GitHub Releases

1. 将通过测试和校验的版本化 `.tgz` 发布到对应项目的 GitHub Releases。鸣潮入场动画在独立仓库 `kun111-web/dsh-wuthering-waves-intro` 发布，安装包内带齐媒体素材。
2. 确认发版提交已推送到 GitHub 后，为每个发版插件直接在 GitHub 创建标签和 Release。标签采用 `<包名>-v<版本号>`，并指向包含该版本源码、安装包和校验记录的发版提交。可用 `gh release create` 的 `--target` 指定完整提交 SHA，由 GitHub 创建远程标签。
3. 每个 Release 上传该插件的 `.tgz`，并在说明中注明「本插件参考 ZCode 源码进行优化，并适配 DeepSeek Harness（DSH）」。鸣潮入场动画的发布说明按独立项目的实际来源署名。
4. 发布后核对 GitHub 标签指向的提交，以及 Release 附件的文件名和 SHA-256，确保与工作区 `dist/SHA256SUMS.txt` 一致。
