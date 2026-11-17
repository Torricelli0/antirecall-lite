# AntiRecall Lite

> 一个只做一件事的 QQNT 插件：**把被撤回的消息留在原地，并标出来**。
> 文字、图片、文件都保留；带本地查看页；不联网、不上传、不改发出去的消息。

![license](https://img.shields.io/badge/license-MIT-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

---

## 它做什么

| 能力 | 说明 |
|---|---|
| **防撤回** | 收到消息时缓存快照，撤回时原地还原 |
| **标记** | 在消息上显示橙色「已撤回」小标签（文字跟在正文后，图片浮在角上） |
| **图片/文件保留** | 收到即复制图片/文件到本地，改写路径，避免撤回后原文件被清理 |
| **查看页** | 内置本地服务，浏览器里搜索、筛选、看图片、下载文件、切换明暗主题 |
| **轻量** | 只注入 `main` 一处；不注入 preload/renderer（不碰 LiteLoader 的渲染通道） |

**它不做什么：** 不伪造消息、不修改发出去的内容、不自动戳一戳、不联网、不上传任何数据。

---

## 前置依赖

**必须先装 [LiteLoaderQQNT](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT)** —— QQ 官方没有插件系统，LiteLoader 是让插件能加载进 QQ 的加载器。

```
QQ 本体
  └ LiteLoaderQQNT（插件加载器）
       └ anti_recall_lite（本插件）
```

**测试环境：** QQNT `7.0.2-53644` / LiteLoader `1.4.1` / Electron 40 / macOS。
其他版本可能可用，但 DOM 结构或 IPC 字段可能不同，需要调整（见「排错」）。

---

## 安装

### 1. 装 LiteLoaderQQNT

按它的官方文档安装。装完后 QQ 的 `app_launcher/index.js` 里会出现一行
`require('./LiteLoader.js');`，这就是注入点。

### 2. 放插件

把 `plugin/` 整个复制为 LiteLoader 插件目录下的 `anti_recall_lite/`：

| 系统 | LiteLoader 插件目录 |
|---|---|
| **macOS** | `~/Library/Containers/com.tencent.qq/Data/Library/Application Support/LiteLoaderQQNT/plugins/` |
| **Windows** | `%APPDATA%\LiteLoaderQQNT\plugins\` 或 QQ 安装目录下（以 `LITELOADERQQNT_PROFILE` 为准） |
| **Linux** | `~/.config/LiteLoaderQQNT/plugins/` |

最终结构：

```
LiteLoaderQQNT/
└ plugins/
   └ anti_recall_lite/
      ├ main.js
      └ manifest.json
```

### 3. 放辅助文件

把 `extras/` 里的这些放到 **插件数据目录**
（`<LiteLoaderQQNT>/data/anti_recall_lite/`）：

```
viewer.html
design-tokens.css
打开撤回记录.command      （macOS 双击用）
```

### 4. 重启 QQ

完全退出（⌘Q）再打开。插件会自动：
- 启动本地查看服务（默认 `http://127.0.0.1:8788/viewer.html`）
- 把地址写到 `data/anti_recall_lite/查看地址.txt`

**浏览器收藏这个地址即可。**

---

## 配置

`data/anti_recall_lite/config.json`（首次启动自动生成）：

```json
{
  "mark": true,             // 是否显示「已撤回」标签
  "markTextFallback": false,// true = 退回文字前缀（徽章失效时用）
  "log": true,              // 是否写 recalled.jsonl
  "localizeImages": true,   // 复制图片到本地
  "localizeFiles": true,    // 复制文件（<50MB）
  "serverPort": 8788,       // 端口被占就改这个
  "autoServer": true        // 随 QQ 启动查看服务
}
```

改完重启 QQ 生效。

---

## 已知限制

| 限制 | 原因 |
|---|---|
| **重启 QQ 后历史消息无法还原内容** | 消息快照存在内存里；QQ 重启会从服务器重拉，撤回的消息服务器端已没有 |
| 重启后徽章仍在 | 已撤回 id 从 `recalled.jsonl` 恢复 |
| 图片原图可能打不开 | 只复制了当时已缓存到本地的文件；未下载的原图无法凭空得到 |
| QQ 更新后插件失效 | 热更新会覆盖 `app_launcher/index.js` 的注入点，需要重新装 LiteLoader |
| **QQ 热更新会导致掉登录** | 与插件无关，是 QQ 切版本时会话失效 |

### 关于掉登录

`extras/阻止QQ更新.command` 会把 `versions/` 里已下载但非当前版本的更新包移到备份目录（不删除），避免 QQ 反复切版本。双击运行即可，可加入登录项。
恢复：把 `~/Library/Application Support/liteloader-guard/qq-updates-blocked/` 里的文件放回 `versions/`。

---

## 排错

**看日志：** `data/anti_recall_lite/debug.log`

| 现象 | 检查 |
|---|---|
| 插件没加载 | `debug.log` 里有没有 `=== plugin loaded`；`manifest.json` 是否在 `plugins/anti_recall_lite/` 下 |
| 徽章不显示 | QQ 版本改了 DOM 结构，看 `debug.log` 里的 `BADGE SELFCHECK`；或把 `markTextFallback` 设 true |
| 查看页打不开 | 端口被占 → 改 `serverPort`；或 `autoServer: false` 时手动跑 `打开撤回记录.command` |
| 页面样式是旧的 | ⌘⇧R 强制刷新；tokens 已内嵌在 HTML 里，不该被缓存 |
| 图片没复制 | 看 `assets/images/`；检查 `localizeImages` 是否为 true |

---

## 项目结构

```
antirecall-lite/
├ plugin/                  ← 放进 LiteLoader plugins/ 目录
│  ├ main.js               主进程：hook IPC、缓存/还原消息、本地化图片、内置 HTTP 服务
│  └ manifest.json
├ extras/                  ← 放进 data/anti_recall_lite/ 目录
│  ├ viewer.html           查看页（tokens 已内嵌，明暗主题）
│  ├ design-tokens.css     从 DeepSeek 官网公开 CSS 抽出的设计变量
│  ├ DESIGN.md             设计规范 + 给 AI 的提示词模板
│  ├ 打开撤回记录.command
│  └ 阻止QQ更新.command
├ docs/
│  ├ ARCHITECTURE.md       实现原理
│  └ MIGRATION.md          换电脑 / 跨平台
└ LICENSE
```

---

## 隐私

- 所有数据只写在本机 `data/anti_recall_lite/`
- 内置服务只监听 `127.0.0.1`，不出站
- 不收集、不上传、不发送任何消息

---

## 免责声明

本插件仅用于**个人备份自己已收到的消息**。请勿用于侵犯他人隐私或违反当地法律法规、
QQ 用户协议的用途。使用产生的后果由使用者自行承担。

---

## License

MIT
