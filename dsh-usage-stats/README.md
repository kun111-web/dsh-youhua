# DSH 使用统计 1.3.1

项目实现与维护说明见 [项目说明.md](项目说明.md)，工作区导航见 [总说明](../README.md)。

直接参考 [ZCode 官方源码](https://github.com/zai-org/ZCode/tree/a9fe401eede6e6e5e01be9048679c206fe6f02d9/packages/ui/src/settings/usage-stats)，在 DSH 的 **设置 → 使用统计** 中展示本机用量。源码、构建产物和安装包均放在此独立文件夹。

## 已实现

- 删除会话后保留历史用量；独立存储摘要，重启后仍可查看。
- 累计 Token、单日峰值、最长聊天跨度、当前与最长连续使用天数。
- 52 周热力图：每日 / 每周 / 累计三种模式。
- 最近 7 / 30 日逐模型趋势，点击图例显隐，悬停查看用量。
- 同一时间范围内分别展示未缓存输入、输出、缓存读取和缓存写入 Token。
- 同一时间范围内的模型用量环形图、数量和比例。
- 跟随 DSH 深浅主题；适配窄设置面板；刷新、打开页面时更新、前台每 30 秒更新。
- 导出汇总 JSON；加载、空数据、读取异常和部分统计缺失状态。

不需要 API Key，不调用模型。统计汇总在本机进行；界面只访问本插件的同源回环端点。当前仅提供应用用量，没有接入个人套餐。

## 本机安装

当前目标版本：**DeepSeek Harness Desktop 0.2.2-rc.1**。已在相同版本的独立测试 profile 验证。其他 DSH 版本没有宣称兼容。

在 Windows 版 DSH 从 npm 安装并启用 `dsh-usage-stats-local@1.3.1` 后，点击「插件 → 已安装插件 → 使用统计插件详情 → 检查并安排更新」。开启「自动更新」会定期检查，完全退出 DSH 后再安装兼容的 npm 正式版。

本机日常 desktop profile 使用 `.tgz` 安装包。首次安装或更新时，在 PowerShell 运行安装脚本。

```powershell
& 'F:\dsh-youhua\dsh-usage-stats\install.ps1'
```

或使用桌面版自带命令直接安装已构建的包：

```powershell
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'F:\dsh-youhua\dsh-usage-stats\dist\dsh-usage-stats-local-1.3.1.tgz'
```

然后完全退出并重新打开 DSH，在设置左侧点击「使用统计」。此插件不修改主程序 app.asar。

卸载可在 DSH 的插件管理页移除，或运行：

```powershell
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-usage-stats-local
```

## 开发与验证

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm run pack:plugin
node scripts/check-local-data.mjs
npm run preview
```

本地预览地址：`http://127.0.0.1:19420/`。默认使用核对脚本生成的本机汇总快照；`?demo` 是明确标注的模拟数据样式演示，`?empty` / `?error` 可检查空状态和错误状态。预览不会写入 DSH 配置。

`scripts/setup-sandbox.mjs` 建立 `.sandbox/home`，复制会话文件用于隔离验证，不复制账户凭据。用以下命令运行隔离宿主：

```powershell
node scripts/setup-sandbox.mjs
$env:DSH_HOME = 'F:\dsh-youhua\dsh-usage-stats\.sandbox\home'
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' web --port 19419 --no-open
```

此环境与 desktop 正式配置独立；停止测试进程后，在当前 PowerShell 清除该测试环境变量，避免后续命令指向测试目录：`Remove-Item Env:DSH_HOME`。

## 数据口径和限制

- 汇总当前 DSH_HOME 中已保存的会话用量摘要，包含已删除会话。升级前已删除且没有摘要或可核对副本的历史无法自动补回；未持久化的流式响应和未写入 assistant/message 的调用不计入，不等同于服务商账单。
- 以完成的 assistant/message.usage 为准，优先使用 totalTokens；缺失时累计 DSH 的输入、输出、缓存读、缓存写四个互斥桶。不会额外叠加流式 usage。
- 首次升级会重读仍有日志的会话以补齐明细。无法拆分的总量继续计入「未拆分」，包括只有总量的旧摘要、缺失分项对应的差额，以及分项和超过总量的记录。导出 JSON 的每日 `tokenBreakdown` 包含这四个字段和 `unclassifiedTokens`，缺省分项表示无可用记录。
- 根据宿主提供的 inheritedEventCount 排除分叉继承前缀。供应商和模型共同区分统计序列。
- 首次创建统计存储时固定宿主本地时区，之后按该时区的自然日统计。近 7 / 30 日包含今天；当前连续天数允许最后活跃日为昨天。
- 最长聊天时长是单会话首末活动跨度，包含等待时间，非模型生成耗时。
- 会话摘要按 revision 更新并持久化到 storages/usage_stats_local/，源日志消失后仍保留摘要。宿主启动和每 30 秒会更新，无需打开统计页。读取和汇总在共享写队列之外完成，写入前会核对 revision 和最新摘要。
- 台账、当前会话集合和统计日期均未变化时，刷新复用已算好的汇总。删除前写入的用量会使汇总失效，下次刷新会使用最新台账。
- 有效用量事件以指纹核对。旧前缀可以沿用现有摘要。日志与已保存记录出现分歧时，页面保留已有用量并报告受影响的会话数。旧格式摘要按已有日期、模型和分项核对，可核对的日志会补上指纹。
- 配合归档管理，彻底删除前核对主日志和登记的备份，并保存可核对的最终总量及明细。主日志或副本含异常用量时会暂停清理当前会话。手工或其他程序直接删文件只能保留最后一次成功保存的用量。
- 个别会话无法读取时显示「统计不完整」，不静默伪装为完整总额。导出只包含汇总，不含聊天正文。
- 访问入口限制为本机回环、同源、GET 和专用请求头。远程访问 DSH 时本插件不提供统计。

## 文件

`src/` 源码；`lib/` 可加载插件；`dist/` 安装包；`test/` 聚合与接口测试；`qa/` 验证报告及截图；`scripts/` 构建和预览工具；`.research/` 本地调研资料（不打包）；`.sandbox/` 隔离测试数据（不打包）。

许可证与参考文件见 NOTICE.md。插件不使用 dsh-scope。
