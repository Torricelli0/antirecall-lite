# 换电脑 / 跨平台

## 最短清单

```
① 装 LiteLoaderQQNT
② 把本仓库 plugin/ 放到它的 plugins/anti_recall_lite/
③ 把 extras/ 放到 data/anti_recall_lite/
④ 重启 QQ
⑤ 浏览器开 http://127.0.0.1:8788/viewer.html
```

**LiteLoader 是必须的** —— 本插件自己没有注入 QQ 的能力。

---

## 平台现状

| 平台 | 状态 | 说明 |
|---|---|---|
| **macOS** | ✅ 已实测 | QQNT 7.0.2-53644 / LiteLoader 1.4.1 |
| **Windows** | ⚠️ 应可用，未实测 | `manifest.json` 已写 `win32`；路径靠 `LITELOADERQQNT_PROFILE` 环境变量回退 |
| **Linux** | ⚠️ 应可用，未实测 | 同上 |
| **iPhone** | ❌ 几乎不可能 | 需越狱 + 重签名，且 QQ 无插件机制 |
| **Android** | ✅ 有别的方案 | 用 Xposed/LSPosed 模块（QNotified 等），不是本插件 |

### 代码里已经做的跨平台处理

```javascript
const PROFILE_DIR = process.env.LITELOADERQQNT_PROFILE   // LiteLoader 自动设置
    || path.join(os.homedir(), 'Library', 'Containers', ... /* macOS 兜底 */);
```

```json
"platform": ["darwin", "win32", "linux"]
```

**所以理论上 Windows/Linux 能跑**，但没实测过，尤其是：
- `data-element-id` 这个 DOM 属性名
- `.message` / `.text-element` 类名
- `RM_IPCFROM_MAIN*` 频道名

**如果别的平台不生效，看 `debug.log` 里的 `BADGE SELFCHECK`，按实际 DOM 改选择器即可。**

---

## 路径速查

| 系统 | LiteLoader 插件目录 | 数据目录 |
|---|---|---|
| macOS | `~/Library/Containers/com.tencent.qq/Data/Library/Application Support/LiteLoaderQQNT/plugins/` | 同级 `data/anti_recall_lite/` |
| Windows | `%APPDATA%\LiteLoaderQQNT\plugins\`（或 QQ 目录下） | 同级 `data\anti_recall_lite\` |
| Linux | `~/.config/LiteLoaderQQNT/plugins/` | 同级 `data/anti_recall_lite/` |

**最可靠的方法：** 看 LiteLoader 设置页里显示的「本体目录位置」，或打印 `process.env.LITELOADERQQNT_PROFILE`。

---

## 迁移已有记录

把旧机器的这些文件复制过来即可：

```
data/anti_recall_lite/
├ recalled.jsonl        ← 撤回记录（查看页数据源）
├ recalled.jsonl.old
├ assets/images/        ← 已复制的图片
├ assets/files/         ← 已复制的文件
└ config.json
```

**不需要复制** `debug.log`（诊断日志）。

---

## QQ 更新后插件失效

QQ 热更新会覆盖 `app_launcher/index.js` 里的注入点。表现：
- 插件列表里插件消失，或 `debug.log` 不再更新

**处理：重新按 LiteLoader 的安装步骤装一次（它会重写注入点），插件文件不用动。**

### 避免反复掉登录

QQ 切版本会重启并让会话失效。`extras/阻止QQ更新.command` 会把已下载的非当前版本包移出 `versions/`（不删除），双击运行即可。

---

## 卸载

1. 把 `plugins/anti_recall_lite/` 移出插件目录（或删掉）
2. 想彻底回到原厂 QQ：删掉 `app_launcher/LiteLoader.js`，并还原 `index.js` 第一行
3. 数据目录 `data/anti_recall_lite/` 可留可删

**本插件不改动任何 QQ 主程序文件**，只有 LiteLoader 本身改了 `index.js`。
