# 来源与适配

参考项目：[zai-org/ZCode](https://github.com/zai-org/ZCode)，核对提交 `a9fe401eede6e6e5e01be9048679c206fe6f02d9`。

直接阅读的功能设计与实现：

- `docs/task/delete-all-archived-tasks.md`
- `packages/ui/src/lib/archivedTaskDeletion.ts`

采用其全量收集归档、固定确认集合、删除前复查归档状态、独立报告成功/跳过/失败、保留底层会话记录的行为设计。本项目为重新编写的 DSH 插件，增加设置页中的多选、搜索和恢复功能；按用户要求将归档展示集中到设置页。

DSH 适配依据本机官方 0.2.2-rc.1 中的 workspace、session-query、session-controller、storage-domain、ui-workspace 和 settings slot 接口。没有采用 dsh-scope，也没有修改 DSH 主程序包。

1.1.0 的彻底删除是本插件自行增加的功能，不归因于 ZCode：通过 DSH 0.2.2-rc.1 的 session-persistence-jsonl 后端校验路径、获取写租约并删除当前会话日志。它与原先可恢复的列表删除分开提供。

ZCode 权利人为 Z.ai / Zhipu AI，许可 Apache License 2.0，全文见 LICENSE；上游声明保留在 licenses/ZCode-NOTICE.md。本插件不是 ZCode 或 DeepSeek 官方发行。依赖的开源许可证位于 licenses/third-party/。
