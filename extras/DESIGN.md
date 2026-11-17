# 设计语言规范（Design Language）

本文件是给 **AI 和开发者** 看的"该怎么写这个项目的 UI"。
配色、间距、圆角、动效一律从 `design-tokens.css` 取，**不要在组件里写死色值**。

---

## 0. 来源

`design-tokens.css` 里的变量抽取自 **DeepSeek 官网公开样式表**（`www.deepseek.com/_next/static/css/*.css`），
不是凭感觉调的。明暗两套值都在官方 CSS 里成对出现过。

**允许借鉴**：设计语言、色板、间距网格、圆角、缓动曲线、组件组织方式。
**不要复制**：Logo、品牌字体文件、专有插图、业务代码。

---

## 1. 五条核心原则

| # | 原则 | 具体做法 |
|---|---|---|
| 1 | **克制用色** | 整页只有 1 个品牌蓝 + 1 个语义色（本项目的「已撤回」橙）+ 中性灰阶 |
| 2 | **4px 网格** | 所有间距取 `--ds-space-*`（4/8/12/16/24/32…），不写 13px、17px |
| 3 | **大留白** | 卡片内边距 24px，区块间距 32–56px，不要挤 |
| 4 | **字重对比** | 标题 600 / 正文 400 / 辅助 12px，靠字重和字号分层，不靠颜色 |
| 5 | **轻描边 + 软阴影** | 1px `border-subtle`，阴影极淡；不要粗边框和强投影 |

---

## 2. 层级（结构）

```
页面 bg-page
└ 顶栏（玻璃拟态，sticky，blur 12px）
└ 主体容器（max-width 1040，居中，padding 24）
   ├ 统计条（4 个等宽卡片）
   └ 记录列表
      └ 每条记录 = 一张卡片
         ├ 元信息行（chips + 时间）
         ├ 正文
         └ 媒体区（图片/文件）
```

**HTML = 结构，CSS = 样式，JS = 行为。** 三者不要混写。

---

## 3. 组件规范

### 卡片
```css
background: var(--ds-bg-surface-1);
border: 1px solid var(--ds-border-subtle);
border-radius: var(--ds-radius-panel);   /* 16px */
padding: var(--ds-space-5);              /* 24px */
box-shadow: var(--ds-shadow-card);
transition: border-color var(--ds-duration-fast) var(--ds-ease);
```

### 按钮
```css
主按钮：--ds-btn-primary-bg / --ds-btn-primary-text，圆角 --ds-radius-input
次按钮：透明底 + --ds-border-default
hover：--ds-bg-hover，过渡 150ms
```

### Chip / 标签
```css
border-radius: var(--ds-radius-pill);
padding: 2px 10px;
font-size: 11.5px;
「已撤回」用 --ds-accent-warn* 三件套（字/底/边）
```

### 图片
```css
border-radius: var(--ds-radius-media);  /* 12px */
border: 1px solid var(--ds-border-subtle);
max-height: 230px;
```

### 顶栏
```css
position: sticky; top: 0;
backdrop-filter: blur(var(--ds-blur-glass));
background: color-mix(in srgb, var(--ds-bg-page) 78%, transparent);
border-bottom: 1px solid var(--ds-border-subtle);
```

---

## 4. 动效

```css
--ds-ease: cubic-bezier(.4, 0, .2, 1);   /* 官方唯一曲线 */
--ds-duration-fast: 150ms;               /* hover、颜色 */
--ds-duration: 240ms;                    /* 位移、展开 */
```

**只做三件事**：hover 变色、卡片轻微上浮（1px）、图片放大预览。
**不要**：弹跳、旋转、闪烁、渐变动画、滚动视差。

---

## 5. 明暗主题

| 模式 | 触发 |
|---|---|
| 跟随系统 | `@media (prefers-color-scheme: dark)` |
| 强制亮色 | `<html data-theme="light">` |

切换时**只换变量值，不改任何组件 CSS**。这是 tokens 存在的意义。

---

## 6. 给 AI 的提示词模板

以后让任何 AI 改这个页面时，把这段贴进去：

```
请按 qq-antirecall-min/DESIGN.md 与 design-tokens.css 的规范修改 viewer.html。
要求：
1. 只用 var(--ds-*) 变量，不写死色值
2. 间距取 4px 网格（--ds-space-*）
3. 明暗两套主题都要正常（跟随系统 + data-theme 手动覆盖）
4. 动效只用 --ds-ease，hover 150ms
5. 保持结构：顶栏 / 统计条 / 记录卡片（元信息 + 正文 + 媒体）
6. 不引入外部 CDN、不联网
```

---

## 7. 参考仓库（真实存在，已核实）

| 仓库 | 用途 |
|---|---|
| `anthropics/skills` | 官方 Agent Skills（含前端/设计规范类） |
| `obra/superpowers` | 社区 agentic skills 框架 |
| `shadcn-ui/ui` | 可复制的组件集合 |
| `tailwindlabs/tailwindcss` | 原子化 CSS |
| `vercel/geist-font` | Geist 字体 / 设计语言 |
| Apple HIG（官网文档） | 交互与可访问性规范 |
