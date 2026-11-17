# 实现原理（ARCHITECTURE）

## 三层链路

```
QQ 主进程
  └ app_launcher/index.js 第一行 require('./LiteLoader.js')   ← LiteLoader 注入点
       └ LiteLoader src/main.js
            └ 扫描 plugins/*/manifest.json
                 └ require(anti_recall_lite/main.js)          ← 本插件（唯一注入点）
```

## main.js 做什么

### 1. 拦截 IPC

LiteLoader 已经代理了 `webContents.send`。本插件再包一层：

```javascript
const originalSend = contents.send.bind(contents);
contents.send = function (channel, ...args) {
    if (/^RM_IPCFROM_MAIN\d*$/.test(channel)) processArgs(args);
    return originalSend(channel, ...args);
};
```

同时也 hook `ipcMain.emit` 兜底。

### 2. 缓存消息

`RM_IPCFROM_MAIN*` 的 payload 里递归找形如「消息记录」的对象
（有 `elements` 数组且带 `msgId`/`msgSeq`）。

**收到就立刻：**
- 深拷贝一份快照（跳过函数、处理循环引用）
- 把图片/文件复制到 `assets/images/`、`assets/files/`，并把
  `picElement` 的 `sourcePath/filePath/originPath/localPath/path/thumbPath`
  全部改指向本地副本（借鉴 QQNT-Toolbox 的多字段回退思路，去掉了远端下载）

### 3. 识别撤回并还原

撤回在 QQ 里是一条只有 `grayTipElement` 的记录：

```javascript
function detectRecall(record) {
    for (const el of record.elements) {
        const tip = el?.grayTipElement;
        if (tip?.revokeElement) return tip.revokeElement;
        if (tip?.subElementType === 1) return {};   // 兼容无 revokeElement 的版本
    }
    return null;
}
```

**还原方式：原地覆盖**，不新增消息：

```javascript
for (const k of Object.keys(record)) delete record[k];
Object.assign(record, fresh);   // fresh = 缓存的快照
```

> 原地覆盖是关键：QQ 渲染层持有的是同一个对象引用，改它比插入新消息轻。

### 4. 匹配键（踩过的坑）

`data-element-id` 存的是 **elementId**，不是 **msgId**，两者通常差 1：

```
msgId     = 7709031357924481745
elementId = 7709031357924481744
```

所以匹配集合里同时放入：
- `msgId` / `msgSeq` / `msgRandom`
- 消息里**每个 element 的 `elementId`**
- 内容指纹（`t:文本`、`f:文件名/md5/路径basename`）—— 供图片消息和重启后的历史消息兜底

### 5. 徽章（渲染层）

**不依赖 LiteLoader 的 renderer 通道**（实测 `import('local:///...')` 那条路不可靠，
且 QQNT 7.0.2 里 `__vueParentComponent` 数量为 0）。

改用 Electron 原生 `webContents.executeJavaScript()` 直接注入一段自包含脚本：

```javascript
// main 进程
await wc.executeJavaScript(badgeBootstrap, true);
await wc.executeJavaScript(`
  document.documentElement.setAttribute('data-arl-recalled-ids', ${ids});
  document.documentElement.setAttribute('data-arl-fingerprints', ${fps});
`, true);
```

渲染层脚本：
- 读这两个属性得到已撤回集合
- 按 `data-element-id` 或内容指纹找到 `.message` 根
- 插入一个 `.arl-tip`（橙色「已撤回」）
- **文字消息**：行内跟在 `.text-element` 后
- **图片/文件消息**：绝对定位到气泡右上角（不撑破布局）
- `data-arl-done` 属性锁，保证一条消息最多一个标签
- MutationObserver + 3 秒轮询应对虚拟列表

> 只注入聊天窗口（URL 含 `/main/message`），其他窗口不动。

### 6. 记录落盘

`recalled.jsonl`，每行一个 JSON：时间、类型、文本、parts（含 elementId / local 文件名）、会话信息。
超过 4MB 轮转为 `.old`。启动时从磁盘恢复 id 集合，保证重启后徽章仍在。

### 7. 内置查看服务

`http.createServer()` 只监听 `127.0.0.1:8788`，服务 `data/anti_recall_lite/` 下的静态文件，
带目录穿越防护。随 QQ 启动，退出时关闭。

---

## 为什么不用 preload / renderer 注入

| 方案 | 问题 |
|---|---|
| LiteLoader renderer | `import('local:///...')` 需 ESM；实测加载不稳定 |
| Vue 组件实例找 record | QQNT 7.0.2 里 `__vueParentComponent` = 0 |
| **executeJavaScript** | ✅ Electron 原生，必可用，且只在聊天窗口生效 |

这也让插件保持**只注入 main 一处**（manifest 里只有 `"main"`），风险面最小。

---

## 数据流图

```
消息到达 ──→ 缓存快照 ──→ 复制图片/文件 ──→ 改写路径
                                              │
撤回发生 ──→ 命中缓存 ──→ 原地还原 ←──────────┘
                 │
                 ├─→ 写 recalled.jsonl ──→ viewer.html（搜索/筛选/看图/下载）
                 └─→ 加入 id 集合 ──→ executeJavaScript ──→ 渲染层「已撤回」标签
```
