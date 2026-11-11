# 来源与修改说明

本插件直接参考 **zai-org/ZCode** 官方「使用统计 → 应用用量」界面，未采用 dsh-scope 或其他第三方 DSH 统计插件实现。

- 上游：https://github.com/zai-org/ZCode
- 核对版本：`a9fe401eede6e6e5e01be9048679c206fe6f02d9`
- 权利人：Z.ai / Zhipu AI，原始版权信息以官方源码及许可证为准。
- 上游许可：Apache License 2.0，全文见 LICENSE；上游声明保存在 licenses/ZCode-NOTICE.md。

直接参考的文件：

- packages/ui/src/settings/usage-stats/AppUsagePanel.tsx
- packages/ui/src/settings/usage-stats/UsageHeatmap.tsx
- packages/ui/src/settings/usage-stats/UsageHeatmapCells.tsx
- packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx
- packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx
- packages/ui/src/settings/usage-stats/appUsageChartPalette.ts
- packages/ui/src/settings/usage-stats/usageStatsUiParts.tsx

本地改动（2026-11-09）：重新实现 DSH sessionPersistence 数据适配、分叉前缀排除和缓存；将 ZCode 的组件布局、52 周自然周展示规则和数字格式设计适配为独立 React 页面；使用 DSH 主题变量和设置 slot；将 ZCode RPC / 国际化 / Tailwind 依赖替换为本插件实现；增加只读导出、读取异常提示和统计口径。没有加入 ZCode 账户或套餐接口。

界面依赖 React、Recharts、Lucide，相关许可证随包置于 licenses/third-party/。此插件为本地适配项目，不代表 ZCode 或 DeepSeek 官方。
