# DSH 本地插件工作区说明

更新日期：2026-11-14。

GitHub 主仓库为 [kun111-web/dsh-youhua](https://github.com/kun111-web/dsh-youhua)，默认分支为 `main`。

本工作区用于开发和维护 DeepSeek Harness 的本地插件。「使用统计」和「归档管理」的功能与界面参考 ZCode 官方项目，未采用 dsh-scope。「鸣潮入场动画」为 DSH 桌面端提供可选角色的开屏动画。插件通过 DSH 扩展机制加载，不修改主程序 `app.asar`。

## 插件导航

| 项目 | 包名与当前版本 | DSH 入口 | 主要用途 |
| --- | --- | --- | --- |
| [使用统计项目说明](dsh-usage-stats/项目说明.md) | `dsh-usage-stats-local` 1.3.4 | 设置 → 使用统计 | 本机会话 Token 总量与四项明细、活动热力图、模型趋势与占比 |
| [归档管理项目说明](dsh-archive-manager/项目说明.md) | `dsh-archive-manager-local` 2.4.4 | 对话顶部、侧栏会话菜单、设置 → 归档管理 | 停止后直接删除，支持筛选删除、清理进度、子智能体清理和中断后续删 |
| [鸣潮入场动画](https://github.com/kun111-web/dsh-wuthering-waves-intro) | `dsh-wuthering-waves-intro` 0.4.7 | 桌面启动、设置 → 鸣潮入场动画 | 20 个角色，4K/60 帧、完整/快速开场、宿主能力检测与兼容降级 |

各项目可以分别构建、安装和卸载。工作区根目录没有统一的 npm 工程，开发命令应在对应插件文件夹执行。

## 从 GitHub 下载安装

**GitHub 是三个插件的唯一公开分发渠道。** 三个插件均提供 Release 安装包，鸣潮入场动画也可从 GitHub 仓库安装。原先发布到 npm 的三个主包和六个动画素材包均已下架。

在 DSH 桌面端打开「插件 → 添加插件」，在顶部粘贴所需 `.tgz` 的下载地址。也可以先下载 `.tgz`，再填写该文件的完整路径进行离线安装。

- [下载使用统计 1.3.4](https://github.com/kun111-web/dsh-youhua/releases/download/dsh-usage-stats-local-v1.3.4/dsh-usage-stats-local-1.3.4.tgz)
- [下载归档管理 2.4.4](https://github.com/kun111-web/dsh-youhua/releases/download/dsh-archive-manager-local-v2.4.4/dsh-archive-manager-local-2.4.4.tgz)
- [下载鸣潮入场动画 0.4.7](https://github.com/kun111-web/dsh-wuthering-waves-intro/releases/download/dsh-wuthering-waves-intro-v0.4.7/dsh-wuthering-waves-intro-0.4.7.tgz)

三个插件可分别安装。安装后完全退出并重新打开 DSH，在插件详情核对版本和来源。各版本的 SHA-256 校验记录随 Release 附件提供。

### 鸣潮入场动画固定安装地址

在 DSH「插件 → 添加插件」的顶部输入框粘贴仓库地址，安装完成后启用插件。

```text
https://github.com/kun111-web/dsh-wuthering-waves-intro
```

安装时读取仓库默认分支 `main` 的当前提交，包含全部 20 个角色的视频和预览图。升级时从托盘完全退出 Windows 版 DSH，用桌面端提供的 `dsh` 命令重新安装同一个地址，再打开 DSH。

```powershell
dsh plugin --profile desktop add 'https://github.com/kun111-web/dsh-wuthering-waves-intro'
```

已在 DSH 0.2.2-rc.3 的隔离桌面配置验证仓库安装和从 0.4.4 升到 0.4.7。已安装的版本会固定到当时解析的 Git 提交，需手动执行升级。

### 安装更新

升级时手动安装新版 Release 附件。Windows 桌面端通过托盘菜单完全退出 DSH 后，可执行 `dsh plugin --profile desktop add '<新版 .tgz 下载地址>'` 原位替换，再重启核对版本。使用已下载的文件时，将下载地址替换为文件的完整路径。

## 目录结构

```text
F:\dsh-youhua\
├─ README.md                      工作区总说明
├─ dsh-usage-stats\               使用统计插件
│  ├─ 项目说明.md                 功能、实现、维护与验证说明
│  ├─ README.md                   安装与使用指南
│  ├─ src\                       后端统计与前端页面源码
│  ├─ lib\                       DSH 实际加载的构建产物
│  ├─ dist\                      tgz 安装包和 SHA-256
│  ├─ test\                      自动测试
│  ├─ scripts\                   构建、预览、数据核对与隔离环境工具
│  └─ qa\                        测试记录、汇总快照和截图
└─ dsh-archive-manager\           归档管理插件
   ├─ 项目说明.md
   ├─ README.md
   ├─ src\                       归档状态、清除逻辑与设置页面
   ├─ lib\
   ├─ dist\
   ├─ test\
   ├─ scripts\
   └─ qa\
```

各插件的 `package.json` 定义包版本、DSH 声明及构建命令；`cordis.patch.yml` 注册宿主插件；`install.ps1` 安装对应打包版本；`NOTICE.md`、`LICENSE` 和 `licenses/` 保存来源与许可证。

`.research/` 是调研资料，`.sandbox/` 是隔离测试环境，`node_modules/` 是开发依赖。使用统计项目还可能有 `.preview/` 预览产物。这些目录和本机 `qa/` 验证记录均保存在本地。使用统计的隔离环境会复制本机真实会话。

## 本机环境与安装状态

2026-11-14，本机 **DeepSeek Harness 0.2.2-rc.3** 的桌面配置已切换到上述三个 GitHub Release 附件。已核对依赖地址、安装版本和启用状态。

| 用途 | 本机路径 |
| --- | --- |
| DSH 桌面程序 | `D:\deepseek\DeepSeek Harness.exe` |
| DSH CLI | `D:\deepseek\resources\runtime\cli\bin\dsh.cmd` |
| 日常数据根目录 | `C:\Users\ASUS\.dsh` |
| 桌面 profile 声明 | `C:\Users\ASUS\.dsh\profiles\desktop\package.json` |
| 归档管理删除标记 | `C:\Users\ASUS\.dsh\storages\archive_manager_local.json` |

2026-11-10 已将两个插件从工作区目录链接切换为 `.tgz` 安装。运行文件位于 `C:\Users\ASUS\.dsh\profiles\desktop\node_modules\` 下各自的插件目录，不再链接工作区；工作区完整保留，没有在 DSH 下额外保存安装包备份。已核对安装文件与当前构建一致、插件入口可独立导入、用量记录未变。

## 更新与交付

每批改动都必须提升所涉及插件的版本号。涉及多个插件时，各自提升版本号。安装和版本同步要求见 [工作区插件管理](AGENTS.md)。

以归档管理为例，修改源码后执行：

```powershell
Set-Location 'F:\dsh-youhua\dsh-archive-manager'
npm ci --ignore-scripts
npm test
npm run build
```

开发需要 Node.js 24 或更新版本。验证开发版本时，先生成带版本号的 `.tgz`，再用完整文件路径装入隔离配置。`node scripts/local-registry.mjs` 也可在 `127.0.0.1:4873` 提供已校验的开发包，供本机测试。宿主升级后重新检查插件接口，尤其是归档管理的内部兼容接口。

发版时从工作区根目录运行发布脚本。脚本检查两个插件的版本声明、锁文件和安装路径，跑完测试再构建两个包。两个插件都内嵌同一份台账源码。

```powershell
Set-Location 'F:\dsh-youhua'
node scripts/release.mjs
```

脚本核对包内版本和运行文件，将安装包写入各自的 `dist/` 并更新 `SHA256SUMS.txt`。已有同版本包内容有差异时会要求升版。各插件的 `npm run pack:plugin` 仍可单独用于开发打包。

当前安装包为使用统计 1.3.4、归档管理 2.4.4、鸣潮入场动画 0.4.7。鸣潮入场动画在其独立仓库运行 `npm run pack:plugin`，生成内含全部素材的安装包并校验。历史安装包和校验记录可用于复核既有版本。

## 同步到 GitHub

在工作区根目录检查 `git status --short --branch` 和 `git diff`，确认本地 `main` 跟踪 `origin/main`。逐项暂存本次要提交的文件，再用 `git diff --cached` 核对内容。

发布新版时，把对应的 `.tgz` 和 `dist/SHA256SUMS.txt` 一起提交。若新版安装包被 `dist/` 的忽略规则匹配，可用 `git add -f` 暂存对应文件。会话、隔离环境和本机 QA 产物留在本地。

提交后运行 `git push origin main`，在 GitHub 的 `main` 分支核对提交和文件。按 [公开发布流程](AGENTS.md#公开发布) 创建 Release，上传 `.tgz` 与 `SHA256SUMS.txt` 并核对附件。

## 两个插件的数据关系

使用统计将每个会话的日期、模型、用量摘要与事件指纹保存到独立的 usage_stats_local 存储域。归档和删除均保留已保存的统计。归档管理在持有写占用及租约期间核对主日志和登记副本，先保存可核对的最新用量。用量分歧或保存失败时保留当前会话的日志。刷新、重启、重复删除不会重计同一会话。

普通会话可以从菜单直接确认删除。归档管理支持按搜索结果删除，也可单独删除子智能体。确认后才释放会话。待清理文件或子智能体有变化时，会展示更新后的清单并再次确认。已经开始的清理可在归档页续删。插件复核日志、副本及缓存，同步该批次的搜索索引后再标记完成。主日志或副本有异常用量时保留当前会话。已登记目录不可用时暂停清理。无法核验归属的损坏备份会显示路径并保留。用量、项目文件与共享附件会保留。未登记的外部备份和云端副本在检查范围之外。

两个插件的接口均面向本机回环访问，不支持通过远程 DSH 地址使用这些扩展功能。

## 测试与维护记录

| 项目 | 已有验证证据 | 查看位置 |
| --- | --- | --- |
| 使用统计 | 28 项自动测试，覆盖汇总复用、删除前写入、跨日刷新和 DSH 原生更新的活动检查 | 本机 `dsh-usage-stats/qa/验证记录.md` |
| 归档管理 | 46 项自动测试，覆盖备份目录掉线、批量进度、目录复用和新增副本保护 | 本机 `dsh-archive-manager/qa/验证记录.md` |
| 鸣潮入场动画 | 0.4.7 通过离线安装、20 个视频哈希比对、分段读取及预览校验；0.4.3 在 rc.1/rc.2 各完成 40 次角色播放 | [动画插件测试记录](https://github.com/kun111-web/dsh-wuthering-waves-intro#片段与打包) |

2026-11-09 15:54:11，用户在日常 DSH 执行两条会话的彻底删除；随后只读检查确认两条记录均有 `purgedAt` 完成标记，原日志不存在，会话目录为空，项目目录仍存在。这与开发阶段的隔离测试分开记录。

2026-11-10 已复跑两组共 40 项自动测试，并在真实 0.2.2-rc.1 隔离宿主中验证删除前保存、删除后重启、重复提交与项目文件保留。结果见 dsh-usage-stats/qa/retention-integration.json。另从已有隔离副本补回两条先前已删除会话的 18,753,845 Token，仅代表副本时点；未恢复聊天日志。

维护时先阅读对应 `项目说明.md` 和 `README.md`。统计口径问题查看聚合与图表模型；归档删除问题查看管理服务与日志清除适配。不要直接手改日常删除标记来尝试恢复已经清除的日志。

### Windows 桌面端更新故障反馈

2026-11-12，本机从 DSH Desktop `0.2.2-rc.1` 更新到 `0.2.2-rc.2` 时，应用退出后停在「正在安装更新」。安装器在备份 `D:\deepseek` 时调用 `MoveFileExW`，连续 10 次收到 `ERROR_SHARING_VIOLATION (32)`，随后退出，未启动新版。

在临时目录独立运行官方安装器时，观察到显示更新提示的 `rundll32.exe` 继承了安装目标作为工作目录，阻止 Windows 重命名目标目录。独立复现时 DSH 和插件均未运行。给本机添加针对该提示进程的处理后，使用同一个签名安装包在原目录复测 rc.2 的自动安装流程，安装器返回 `0`，DSH 自动重启并进入工作台。跨版本自动升级待下一版发布后验证。

复现步骤、脱敏错误日志和对照结果已发到 [DSH 官方 GitHub 讨论 #12988 的回复](https://github.com/deepseek-ai/deepseek-harness/discussions/12988#discussioncomment-19562177)。

## 开源许可

本仓库的原创代码采用 Apache License 2.0，完整条款见 [LICENSE](LICENSE)。

上游署名和第三方依赖的许可信息见各插件的 `NOTICE.md` 和 `licenses/` 目录。[使用统计声明](dsh-usage-stats/NOTICE.md) · [归档管理声明](dsh-archive-manager/NOTICE.md)
