# LogVar

弹幕获取与多来源合并工具，提供 **Android 弹幕 API 服务**、**Forward 弹幕模块**和 **Rex 弹幕模块**。

当前版本：**测试版 11.0.0（11.0.0-beta）**。服务随应用在手机本地运行，无需 Termux，也无需另行部署服务器。11.0.0 新增爱壹帆来源、更新 App 接口适配，并修复爱奇艺国际解码超时造成的 0 条弹幕问题。已修复代理中转的 POST 转发并验证可经代理获取弹幕；当前直连被源站地区规则拒绝，不能保证无需代理可用。变更详见 [更新记录](CHANGELOG.md)，开发交接见 [11.0.0 交接文档](交接文档-测试版11.0.0.md)。

## 适用范围：选择哪一种？

| 形式 | 适用播放器 / 环境 | 是否需要其他设备运行服务 |
| --- | --- | --- |
| Android APP（测试版 11.0.0） | 支持填写兼容自定义弹幕 API 地址的播放器；服务运行于 Android 手机，可供本机或同一局域网设备访问 | 需要 Android 手机运行服务 |
| Forward 模块（1.0.7） | **Forward 播放器**中支持 JavaScript 弹幕模块的版本，面向 Apple TV / tvOS 使用场景 | 不需要 Android APP、电脑或 NAS 常驻 |
| Rex 模块（1.0.7） | **Rex 播放器**中支持 Widget 弹幕模块的版本，面向 Apple TV / tvOS 使用场景 | 不需要 Android APP、电脑或 NAS 常驻 |

两个模块都是播放器内部执行的 JavaScript，不是独立 tvOS 应用或后台 HTTP 服务器。请在 Forward 导入 Forward 文件，在 Rex 导入 Rex 文件；不适用于只接受弹幕 API 地址而不支持这类脚本的其他播放器。其他客户端平台未逐一验证，不据此宣称全部兼容。

## Forward / Rex 模块下载与导入

| 播放器 | 当前模块文件 | 可直接用于 URL 导入的 JS 原文 | 使用说明 |
| --- | --- | --- | --- |
| Forward | [logvar-forward-1.0.7.js](server/dist/logvar-forward-1.0.7.js) | [Forward 导入链接](https://raw.githubusercontent.com/maoxiaoc/LogVar/main/server/dist/logvar-forward-1.0.7.js) | [Forward 说明](server/forward/README.md) |
| Rex | [logvar-rex-1.0.7.js](server/dist/logvar-rex-1.0.7.js) | [Rex 导入链接](https://raw.githubusercontent.com/maoxiaoc/LogVar/main/server/dist/logvar-rex-1.0.7.js) | [Rex 说明](server/rex/README.md) |

在对应播放器的模块管理中导入文件或 JS 原文链接，然后在弹幕功能中选择 **LogVar** 并搜索作品、选择分集。模块显示名称不带版本号，文件名保留版本号方便区分。GitHub 文件预览页不是可导入的 JS 原文地址。

1.0.7 将完整提示放入参数标题：“启用来源（未设置时使用默认来源）”，使不展示参数说明的界面也能显示提示。实际显示和旧参数信息是否刷新仍需客户端验证。

1.0.6 将启用来源标注为“可选，未设置时使用默认 9 个来源”。未填写、手动清空或仅输入空白均使用默认来源；填写具体来源时替换默认列表，逗号分隔、不分优先级。

1.0.5 进一步同步爱奇艺本地视频 ID 解码修复，避免国际解码接口超时导致空弹幕。

1.0.4 已同步 APP 测试版 11.0.0 的爱壹帆签名接口。更新后若保留了旧参数，请在启用来源中添加 `aiyifan` 并重新搜索。该来源存在地区访问限制，模块不会自动继承 APP 代理配置。

两个模块共用弹幕核心：媒体资料优先匹配、标题搜索兜底，支持“合并全部来源”和“仅保留弹幕最多的来源”；默认启用 9 个来源（含爱壹帆），共允许配置 17 个来源。提供屏蔽词、去重间隔、可选 B站 Cookie；搜索无结果时显示“😭 未匹配到资源”。无来源优先级或本地弹幕文件导入功能。

两个版本使用独立模块 ID 和分集缓存，Rex 版适配其 HTTP 状态字段和 TMDB 路径。它们都需要网络访问上游接口，部分来源使用公共中转。

已通过两种宿主接口格式的离线回归检查及部分弹弹真实接口验证。旧构建 Rex 1.0.3 缺少 `requiredVersion` 导致本地导入失败；仅补回该字段的验证包已获用户实机导入成功反馈，1.0.3 修正版已补回此字段，当前 **Rex 1.0.7** 继续保留。该反馈仅确认导入，播放、渲染及各来源可用性仍需实机验证。

## 项目来源

本项目基于 [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api) 的服务端代码开发，针对 Android 本地运行增加原生界面、前台服务、弹幕源管理、缓存管理及移动端资源控制。界面设计参考了 [m3e-canvas](https://github.com/lnkiai/m3e-canvas) 和本仓库中的设计稿。

本项目由独立维护者开发，属于非官方 Android 实现，不代表上游作者或任何视频平台。感谢上游项目及其贡献者。

## 功能

### 本地弹幕服务

- 在 Android 手机上直接启动本地弹幕 API 服务，无需安装 Termux 或单独部署服务器。
- 首页展示服务运行状态、当前网络、可访问的 IP 地址与监听端口；没有 Wi-Fi 或热点时，显示仅供本机使用的 `127.0.0.1` 地址。
- 支持复制完整 API 地址，方便粘贴到支持自定义弹幕接口的播放器。
- 可手动启动或停止服务；服务运行时会提供前台通知，降低被系统后台限制的概率。
- 在 Wi-Fi 或手机热点环境下，其他已连入同一局域网的设备可通过手机显示的地址访问服务。

### 弹幕源与检测

- 支持管理腾讯视频、爱奇艺、B站、弹弹play、芒果 TV、优酷、人人视频、韩剧TV、爱壹帆等弹幕源。
- 可单独启用或停用每个弹幕源；未启用的来源不会参与搜索和下载。
- 支持通过左侧拖拽手柄调整来源顺序，用于控制查询优先级。
- 支持开启或关闭多源弹幕合并，减少同一内容来自多个来源时的重复弹幕。
- 可检测当前已启用的弹幕源，依次验证搜索、读取分集和下载单集弹幕流程，并展示每个来源的结果、弹幕数量和检测时间。

### 缓存与资源管理

- 分别展示搜索缓存、弹幕缓存、匹配数据缓存和应用临时缓存。搜索与弹幕为服务内存数据估算；匹配数据及应用临时缓存为磁盘文件大小，与 Android 系统设置的统计口径不同。
- 进入首页或在首页恢复前台时读取缓存，清理完成后立即重新读取；不采用每两秒轮询缓存的方式。读取失败显示“暂时无法读取”，小于 1 KB 的缓存以 B 显示。
- 支持按类别清理缓存，也可一次清理全部缓存。
- 清理缓存不会删除 API Token、管理 Token 或弹幕源配置。
- 支持查看网络状态与服务监听状态，便于排查播放器无法连接的问题。

### 安全与应用设置

- API Token 与管理 Token 分开保存：播放器只使用 API Token，管理操作使用独立 Token。
- API Token 默认遮蔽显示；复制时才会取得完整内容。
- 支持重新生成 API Token；重新生成后，播放器需要更新为新的完整 API 地址。
- 可设置保持前台运行，以及是否在设备开机后自动启动服务。
- 服务信息页展示当前内置服务版本，便于确认应用版本与服务版本。

弹幕源的实际可用性会受平台接口、网络、地区与访问限制影响；一次检测成功不代表持续可用，零条弹幕也不一定表示接口失效。
## 下载与使用

测试版 11.0.0 安装包如下；已发布版本可从 [Releases](https://github.com/maoxiaoc/LogVar/releases) 下载。

| 安装包 | 适用设备 |
| --- | --- |
| `Logvar-11.0.0-beta-arm64-v8a.apk` | 支持 64 位 ARM 应用的 Android 手机 |

最低支持 Android 8.0（API 26）。本次仅提供 arm64-v8a，不提供 32 位 ARM、x86_64 或通用安装包。

本次沿用原签名，versionCode 为 13，可从维护者签名的 arm64-v8a 9.0.0 覆盖升级并保留应用数据。旧架构包仍保留在 6.0.0 Release 中。同签名不代表可以直接降级，Android 仍会检查内部版本号。

1. 安装并打开应用，启动弹幕服务。
2. 点击首页“复制 API 地址”。
3. 在支持自定义弹幕接口的播放器中填写完整地址，包括 Token。
4. 同一部手机上的播放器使用 `127.0.0.1` 地址；其他设备使用时，需要填写首页显示的 Wi-Fi 或热点地址。仅开启移动数据且未开热点时，地址仅供本机使用。
5. 如需后台持续使用，开启“保持前台运行”，并根据系统提示允许相关通知和后台运行权限。

API Token 用于播放器访问；管理 Token 用于管理功能，不应填写到播放器或公开分享。当前 API 使用 HTTP，适合可信的本机或局域网环境，请勿直接暴露到公网。分享截图或日志前，请隐藏完整 API 地址、Token、Cookie 和个人信息。

## 源码与构建

### 反馈与自动检查

遇到问题或有功能建议，请使用 [Issues 模板](https://github.com/maoxiaoc/LogVar/issues/new/choose)，并移除 Token、Cookie、完整 API 地址和个人信息。个人项目不承诺响应或修复时间。

GitHub Actions 会在 main 更新及 Pull Request 时运行缓存、请求隔离、网络地址和拖拽逻辑的基础测试；这不代替 Android 构建或真机验证。自动检查只使用只读仓库权限，不读取签名密钥，也不发布 APK。Dependabot 安全修复需人工检查、测试后合并，不自动合并。

仓库根目录就是 Android 工程：

```text
app/                                  Android 界面、服务及原生桥接
app/src/main/assets/nodejs-project/    APK 内嵌服务代码与入口
app/libnode/                          Node 原生运行库及头文件
server/                               服务端源码、依赖清单与锁文件
scripts/                              构建准备脚本
tests/                                部分功能与资源控制检查
```

构建环境：JDK 17、Android SDK 36、NDK 27.3.13750724、CMake，以及 Node.js/npm 和兼容 Android Gradle Plugin 8.7.3 的 Gradle。当前仓库未提供 Gradle Wrapper，需自行配置 Gradle。

在 Windows PowerShell 中，从工程根目录准备嵌入式服务依赖：

```powershell
./scripts/prepare-android-assets.ps1
gradle :app:assembleDebug
```

依赖通过 `server/package-lock.json` 安装；`node_modules` 不纳入源码管理。APK 实际加载的是 assets 下的服务代码，修改 `server/` 时需同步对应的内嵌代码。

构建签名 release 前，在本地创建 `release-signing.properties`：

```properties
storeFile=path/to/your-release.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=YOUR_KEY_ALIAS
keyPassword=YOUR_KEY_PASSWORD
```

然后执行 `gradle :app:assembleRelease`。以上均为占位值；签名私钥和密码不随仓库提供。自行签名的 APK 通常不能覆盖安装由维护者签名的版本。

## 开源许可与第三方资源

服务端代码依据上游 GNU AGPL v3 许可证使用和修改，许可全文见 [server/LICENSE](server/LICENSE)，项目来源和第三方依赖说明见 [NOTICE.md](NOTICE.md)。分发修改版本或 APK 时，应遵守适用许可证，包括保留版权声明、标明修改并提供对应源码等要求；第三方组件继续适用各自许可证。

当前沿用上游项目使用的 LogVar 名称及图标。本说明仅交代来源和非官方关系，不表示已取得名称、商标或图标的单独授权，也不向使用者授予相关权利。

本项目提供弹幕接口工具，不授予第三方平台内容的使用或再分发权利。使用者及分发者应遵守适用法律和平台规则；“学习交流”用途不豁免相应义务。

如有任何侵权行为，请联系本人删除。

