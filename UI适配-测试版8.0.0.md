# 测试版 8.0.0 UI

用户选定 8.0.0 自适应方案，7.0.0 对比方案已移除。

- Scaffold 统一应用并消费系统安全区 Insets，避免顶部栏重复留白。
- 根据内容区宽高调整卡片留白、按钮和来源行高度；遵循系统字体缩放，较大字体不启用紧凑布局。
- 所有应用内 Snackbar 采用 B 方案：居中的浅色悬浮胶囊，宽度随文字变化，最大 360dp 且不超过窗口安全宽度。28dp 圆角、轻微阴影和状态图标。所有状态统一使用 primaryContainer / onPrimaryContainer 动态配色，只以图标和文案区分结果。
- 提示条位于根布局固定浮层，底部始终预留系统安全区和 80dp 导航空间；缓存管理等无底栏页面也保持相同高度，不再随底栏显隐跳动。
- 采用 Material 3 SnackbarHost 的显示生命周期、淡入淡出及无障碍超时支持，并加入轻微上浮效果。长文字换行，失败提示可手动关闭。
- 版本仍为 8.0.0-beta，versionCode 10，沿用原签名，交付 arm64-v8a。保留现有用户数据和缓存功能。

构建：`gradle :app:assembleRelease --offline`。

官方适配依据：[Insets 消费](https://developer.android.com/develop/ui/compose/system/insets-ui)、[edge-to-edge](https://developer.android.com/develop/ui/compose/system/setup-e2e)、[挖孔安全区](https://developer.android.com/develop/ui/compose/system/cutouts)。
