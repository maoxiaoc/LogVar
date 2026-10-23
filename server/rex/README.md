# LogVar Rex 弹幕模块

导入文件：[logvar-rex-1.0.5.js](../dist/logvar-rex-1.0.5.js)。模块显示名称为 **LogVar**，版本号只出现在文件名和版本字段中。模块 ID 为 `logvar.rex.local`。

1.0.5 同步 APP 测试版 11.0.0 的爱奇艺修复：优先本地解码视频 ID，数字 TVID 直接使用，超出安全整数范围时保留国际解码接口后备路径，避免国际站解码接口超时导致空弹幕。已在两个发布脚本中通过离线回归：国际接口不可用时仍返回弹幕，并覆盖数字 TVID、后备路径和两种处理模式；Apple TV 实机播放待验证。

1.0.4 同步 APP 测试版 11.0.0 的爱壹帆 App 签名接口，覆盖搜索、选集、弹幕和旧链接补齐 videoId；默认启用爱壹帆（`aiyifan`），作品及分集标签显示“爱壹帆”。保留两种处理模式与 Rex 导入兼容字段。已通过两种模拟宿主的离线流程回归，包含签名刷新、冷启动、无计时器与年份接口失败场景，仍需 Apple TV 实机验证。

升级后若播放器保留旧的来源参数，请在 `enabledSources` 中补上 `aiyifan`，再重新搜索选集。APP 测试记录中该来源直连受到 Cloudflare 1009 地区限制；模块使用播放器网络，不会自动继承 Android APP 的代理配置。

1.0.3 修正版（覆盖同版本旧构建）修复本地 JS 导入失败：恢复 `requiredVersion: "0.0.2"`。用户在同一 Rex 中确认 Forward 1.0.3 可导入、Rex 1.0.3 不可导入；仅补回此字段的 Rex 验证包随后导入成功。开发库将字段声明为可选，但实际导入需保留。新增离线检查防止再次遗漏；实机反馈确认的是导入，不等于已验证播放和所有来源。

基于 LogVar Forward 1.0.5 生成，复用同一套来源、匹配、过滤和合并代码。两种播放器使用独立模块 ID 和分集索引缓存，避免相互覆盖。Rex 版不需要先安装 Forward 模块。

## 导入和功能

在 Rex 的模块管理中导入上述 JS 文件，并在弹幕功能中选择 LogVar。如果当前客户端只接受 URL，可使用 [Rex 模块 JS 原文链接](https://raw.githubusercontent.com/maoxiaoc/LogVar/main/server/dist/logvar-rex-1.0.5.js)。GitHub 文件预览页不是脚本导入地址。

- 媒体资料优先：有宿主 TMDB 上下文时，经 IMDb、豆瓣关联平台分集；资料不可用时回退标题搜索。
- 合并全部来源，或只保留有效弹幕条数最多的来源，不提供来源优先级。
- 默认启用腾讯、爱奇艺、芒果、B站、优酷、弹弹、人人、韩剧TV、爱壹帆，共允许配置 17 个来源。
- 保留来源中文标签、B站 Cookie、屏蔽词、去重时间窗设置。
- 搜索完成但无结果时显示“😭 未匹配到资源”；没有本地弹幕文件导入功能。
- 在播放器脚本环境中获取弹幕，不需要手机或电脑常驻服务。仍依赖上游网络接口，部分来源使用公共中转。

参数和来源说明见 [共享功能说明](../forward/README.md)。首次导入需在 Rex 重新搜索选集，不会读取 Forward 的历史分集索引。

## Rex 适配依据

2026-10-22 核对 `baranwang/rex-widget-libs` 的 `@rexnow/libs` 3.1.3 源码：

- [弹幕接口](https://github.com/baranwang/rex-widget-libs/blob/main/packages/libs/src/env/danmu.ts)：沿用 `animes`、`episodeId/episodeTitle`、`count/comments` 及 `cid/p/m`。
- [模块元数据](https://github.com/baranwang/rex-widget-libs/blob/main/packages/libs/src/env/metadata.ts)：保留 `searchDanmu/getDetail/getComments` 三个 danmu 入口及五项全局参数。1.0.3 根据用户实机对照恢复 `requiredVersion: "0.0.2"`；此兼容字段不代表逐一验证过所有 Rex 历史版本。
- [Widget 适配器](https://github.com/baranwang/rex-widget-libs/blob/main/packages/libs/src/widget-adaptor.ts)：HTTP 的 `statusCode` 转换成原核心需要的 `status`，兼容字符串 JSON；TMDB 使用不带开头斜线的相对路径，匹配适配器在路径前添加 `/3/` 的行为。

脚本仍整集获取弹幕，没有增加按进度分片入口。所有来源逻辑来自项目现有核心；Rex 的宿主能力、计时器及实际平台接口可用性需实机验证。开发库模拟接口不是客户端源码，离线验证不能代替 Apple TV 导入和播放检查。

## 构建和检查

仓库根目录执行：

```powershell
npm run build-rex-widget --prefix server
npm run test-rex-widget --prefix server
```

可选联网检查：

```powershell
node server/forward/test.mjs --rex --live
```

共用构建器 `server/forward/build.mjs` 与测试 `server/forward/test.mjs`，通过 `--rex` 选择目标，避免维护两套弹幕核心。Rex 测试使用只含 `statusCode` 的 HTTP 返回值，检查 TMDB 路径，并覆盖媒体匹配、季数、标题回退、来源开关、合并、两种处理模式、无结果提示、异常隔离与脚本冷启动后的分集恢复。

2026-10-22 已通过上述离线检查及弹弹真实联网检查：《FX战士久留美》搜索返回 1 个作品、8 集，第一集取得 5968 条弹幕。这验证的是带模拟 Rex 桥接的发布脚本及该来源链路，尚未验证 Apple TV 客户端导入、渲染或其他来源的实时可用性。

沿用项目 AGPL-3.0-only 许可和 [NOTICE](../../NOTICE.md) 中的来源声明。
