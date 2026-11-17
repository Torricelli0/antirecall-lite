'use strict';

/**
 * AntiRecall Lite v1.3
 *
 * 把被撤回的消息留在原地、标记出来，并把图片/文件复制到本地避免失效。
 * 内置一个只监听 127.0.0.1 的小服务，用于打开查看页。
 *
 * 设计约束（降低被 QQ 风控/更新搞掉的概率）：
 *   1. 只注入 main 进程，不注入 preload / renderer，不碰 DOM
 *   2. 只包装 webContents.send / ipcMain.emit，只关心 RM_IPCFROM_MAIN*
 *   3. 不出站联网、不上传、不修改要发出去的消息
 *   4. 全程 try/catch，任何异常都不影响 QQ 收发消息
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain } = require('electron');

const CHANNEL_RE = /^RM_IPCFROM_MAIN\d*$/;
const MAX_CACHED = 4000;
const MAX_DEPTH = 8;
const MAX_SCAN = 800;
const MAX_ROTATE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_COPY = 50 * 1024 * 1024;

/* ───────────────────── 路径（必须在 QQ 沙箱容器内）───────────────────── */

const PROFILE_DIR = process.env.LITELOADERQQNT_PROFILE
    || path.join(os.homedir(), 'Library', 'Containers', 'com.tencent.qq',
        'Data', 'Library', 'Application Support', 'LiteLoaderQQNT');

const DATA_DIR = path.join(PROFILE_DIR, 'data', 'anti_recall_lite');
const LOG_FILE = path.join(DATA_DIR, 'debug.log');
const RECORD_FILE = path.join(DATA_DIR, 'recalled.jsonl');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const URL_FILE = path.join(DATA_DIR, '查看地址.txt');

const DEFAULT_CONFIG = {
    mark: true,
    // 默认不往消息正文写文字标记，改用 renderer 徽章；
    // 若徽章因 QQ 改版失效，可把它设为 true 回退到文字标记
    markTextFallback: false,
    log: true,
    localizeImages: true,
    localizeFiles: true,
    serverPort: 8788,
    autoServer: true
};

/* ───────────────────────── 日志 ───────────────────────── */

let logStream = null;
function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); }
    }).join(' ')}\n`;
    try { process.stdout.write('[AntiRecallLite] ' + line); } catch { /* noop */ }
    try {
        if (!logStream) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
            logStream.on('error', () => { logStream = null; });
        }
        logStream.write(line);
    } catch { /* noop */ }
}

/* ───────────────────────── 配置 ───────────────────────── */

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(CONFIG_FILE)) {
            config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
        } else {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 4), 'utf-8');
        }
    } catch {
        config = { ...DEFAULT_CONFIG };
    }
}

/* ───────────────────────── 基础工具 ───────────────────────── */

function text(v) {
    const s = v === undefined || v === null ? '' : String(v).trim();
    return s && s !== 'undefined' && s !== 'null' && s !== '0' ? s : '';
}

function collectKeys(record, extra) {
    const keys = new Set();
    const push = v => { const s = text(v); if (s) keys.add(s); };
    push(record && record.msgId);
    push(record && record.msgSeq);
    push(record && record.msgRandom);
    push(extra && extra.origMsgId);
    push(extra && extra.origMsgSeq);
    push(extra && extra.msgId);
    push(extra && extra.msgSeq);
    return keys;
}

function detectRecall(record) {
    if (!record || !Array.isArray(record.elements)) return null;
    for (const el of record.elements) {
        const tip = el && el.grayTipElement;
        if (!tip) continue;
        if (tip.revokeElement) return tip.revokeElement;
        if (tip.subElementType === 1) return {};
    }
    return null;
}

function hasContent(record) {
    if (!record || !Array.isArray(record.elements) || !record.elements.length) return false;
    return record.elements.some(el => el && !el.grayTipElement);
}

function clone(value, depth = 0, map = new WeakMap()) {
    if (depth > 14) return undefined;
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) {
        try { return new value.constructor(value); } catch { return undefined; }
    }
    if (value instanceof Date) return new Date(value.getTime());
    if (map.has(value)) return map.get(value);

    if (Array.isArray(value)) {
        const out = [];
        map.set(value, out);
        for (const item of value) {
            const c = clone(item, depth + 1, map);
            if (c !== undefined) out.push(c);
        }
        return out;
    }
    if (value instanceof Map) {
        const out = new Map();
        map.set(value, out);
        for (const [k, v] of value) out.set(k, clone(v, depth + 1, map));
        return out;
    }
    const out = {};
    map.set(value, out);
    let keys = [];
    try { keys = Object.keys(value); } catch { return out; }
    for (const k of keys) {
        let raw;
        try { raw = value[k]; } catch { continue; }
        if (typeof raw === 'function') continue;
        const c = clone(raw, depth + 1, map);
        if (c !== undefined) out[k] = c;
    }
    return out;
}

/* ────────────────── 资源本地化（参考 Toolbox 的多字段回退）────────────────── */

function normalizePathText(v) {
    const s = text(v);
    return s ? s.replace(/^file:\/\//, '') : '';
}

function thumbPathValues(thumbPath) {
    let values = [];
    try {
        if (typeof thumbPath === 'string') values = [thumbPath];
        else if (thumbPath instanceof Map) values = Array.from(thumbPath.values());
        else if (Array.isArray(thumbPath)) values = thumbPath;
        else if (thumbPath && typeof thumbPath === 'object') values = Object.values(thumbPath);
    } catch { /* noop */ }
    return Array.from(new Set(values.map(normalizePathText).filter(Boolean)));
}

function findExistingFile(candidates) {
    for (const candidate of candidates) {
        const p = normalizePathText(candidate);
        if (!p) continue;
        try {
            if (path.isAbsolute(p)) {
                const st = fs.statSync(p);
                if (st.isFile() && st.size > 0) return p;
            }
        } catch { /* noop */ }
    }
    return '';
}

function picSourcePath(pic) {
    return findExistingFile([
        pic && pic.sourcePath, pic && pic.filePath, pic && pic.originPath,
        pic && pic.localPath, pic && pic.path, ...thumbPathValues(pic && pic.thumbPath)
    ]);
}

function fileSourcePath(el) {
    return findExistingFile([
        el && el.filePath, el && el.sourcePath, el && el.originPath,
        el && el.localPath, el && el.path
    ]);
}

function copyInto(srcPath, subdir) {
    try {
        const st = fs.statSync(srcPath);
        if (!st.isFile() || st.size <= 0) return '';
        if (subdir === 'files' && st.size > MAX_FILE_COPY) return '';

        const ext = path.extname(srcPath).toLowerCase() || '';
        const hash = crypto.createHash('sha1')
            .update(srcPath + '|' + st.size).digest('hex').slice(0, 20);
        const dir = path.join(ASSET_DIR, subdir);
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, hash + ext);

        if (!fs.existsSync(target) || fs.statSync(target).size < st.size) {
            fs.copyFileSync(srcPath, target);
        }
        return target;
    } catch (error) {
        log('copyInto error:', error && error.message);
        return '';
    }
}

function rewritePicPaths(pic, target) {
    if (!pic || !target) return false;
    pic.sourcePath = target;
    pic.filePath = target;
    pic.originPath = target;
    pic.localPath = target;
    pic.path = target;
    try {
        if (pic.thumbPath instanceof Map) {
            const keys = pic.thumbPath.size ? [...pic.thumbPath.keys()] : [0];
            for (const k of keys) pic.thumbPath.set(k, target);
        } else if (Array.isArray(pic.thumbPath)) {
            pic.thumbPath = pic.thumbPath.length ? pic.thumbPath.map(() => target) : [target];
        } else if (pic.thumbPath && typeof pic.thumbPath === 'object') {
            const keys = Object.keys(pic.thumbPath);
            for (const k of (keys.length ? keys : ['0'])) pic.thumbPath[k] = target;
        } else {
            pic.thumbPath = target;
        }
    } catch { /* noop */ }
    return true;
}

function rewriteFilePaths(el, target) {
    if (!el || !target) return false;
    el.filePath = target;
    el.sourcePath = target;
    el.originPath = target;
    el.localPath = target;
    el.path = target;
    return true;
}

function localizeAssets(record) {
    const images = [];
    const files = [];
    if (!record || !Array.isArray(record.elements)) return { images, files };

    for (const el of record.elements) {
        if (!el || typeof el !== 'object') continue;

        if (el.picElement && config.localizeImages) {
            const src = picSourcePath(el.picElement);
            if (src) {
                const target = copyInto(src, 'images');
                if (target) {
                    rewritePicPaths(el.picElement, target);
                    images.push(path.basename(target));
                }
            }
        }
        if (el.fileElement && config.localizeFiles) {
            const src = fileSourcePath(el.fileElement);
            if (src) {
                const target = copyInto(src, 'files');
                if (target) {
                    rewriteFilePaths(el.fileElement, target);
                    files.push(path.basename(target));
                }
            }
        }
        if (el.videoElement && config.localizeFiles) {
            const src = fileSourcePath(el.videoElement);
            if (src) {
                const target = copyInto(src, 'files');
                if (target) {
                    rewriteFilePaths(el.videoElement, target);
                    files.push(path.basename(target));
                }
            }
        }
    }
    return { images, files };
}

/* ─────────────────── 摘要提取（供查看页）─────────────────── */

function summarizeElements(elements) {
    const parts = [];
    let kind = 'unknown';
    const bump = k => { kind = kind === 'unknown' ? k : 'mixed'; };

    for (const el of Array.isArray(elements) ? elements : []) {
        if (!el || typeof el !== 'object') continue;
        const elementId = text(el.elementId);
        if (el.textElement) {
            bump('text');
            const c = text(el.textElement.content);
            if (c) parts.push({ type: 'text', content: c, elementId });
        } else if (el.picElement) {
            bump('image');
            parts.push({ type: 'image', fileName: text(el.picElement.fileName) || '图片', elementId });
        } else if (el.fileElement) {
            bump('file');
            parts.push({
                type: 'file',
                fileName: text(el.fileElement.fileName) || '文件',
                fileSize: Number(el.fileElement.fileSize) || 0,
                elementId
            });
        } else if (el.videoElement) {
            bump('video');
            parts.push({ type: 'video', fileName: text(el.videoElement.fileName) || '视频', elementId });
        } else if (el.pttElement) {
            bump('voice');
            parts.push({ type: 'voice', duration: Number(el.pttElement.duration) || 0, elementId });
        } else if (el.faceElement) {
            bump('face');
            parts.push({ type: 'face', faceIndex: el.faceElement.faceIndex, elementId });
        } else if (el.replyElement) {
            parts.push({ type: 'reply', elementId });
        }
    }
    return { kind, parts };
}

function getPeerLabel(record) {
    if (!record) return { peerUid: '', peerUin: '', chatType: 0, senderUin: '', senderUid: '', senderName: '' };
    const peer = record.peer || record.header || {};
    const sender = record.sender || record.sendMember || {};
    const pick = (...vals) => {
        for (const v of vals) { const s = text(v); if (s) return s; }
        return '';
    };
    return {
        peerUid: pick(record.peerUid, record.peer?.peerUid, record.header?.peerUid, peer.peerUid, peer.uid),
        peerUin: pick(record.peerUin, record.peer?.peerUin, record.header?.peerUin, peer.peerUin, peer.uin),
        chatType: Number(record.chatType) || Number(record.peer?.chatType) ||
                  Number(record.header?.chatType) || Number(peer.chatType) || 0,
        senderUin: pick(record.senderUin, record.sender?.uin, record.sender?.peerUin, sender.uin, sender.peerUin),
        senderUid: pick(record.senderUid, record.sender?.uid, record.sender?.peerUid, sender.uid, sender.peerUid),
        senderName: pick(record.sendMemberName, record.sendNickName,
                         record.sender?.nick, record.sender?.remark, record.sender?.nickName,
                         sender.nick, sender.remark, sender.nickName)
    };
}

/* ───────────────────── 记录落盘 ───────────────────── */

function rotateRecordFile() {
    try {
        if (!fs.existsSync(RECORD_FILE)) return;
        if (fs.statSync(RECORD_FILE).size <= MAX_ROTATE_BYTES) return;
        const old = RECORD_FILE + '.old';
        try { fs.unlinkSync(old); } catch { /* noop */ }
        fs.renameSync(RECORD_FILE, old);
        log('record file rotated');
    } catch (error) {
        log('rotate error:', error && error.message);
    }
}

function appendRecord(entry) {
    if (!config.log) return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        rotateRecordFile();
        fs.appendFileSync(RECORD_FILE, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (error) {
        log('appendRecord error:', error && error.message);
    }
}

/* ───────────────────────── 标记 ───────────────────────── */

function hhmm(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 构造一个 QQ 能正常渲染的文本元素（字段必须齐全，否则图片消息里不显示） */
function makeMarkerElement(content) {
    return {
        elementType: 1,
        elementId: `arl-mark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        elementGroupId: 0,
        extBufForUI: {},
        textElement: {
            content,
            atType: 0,
            atUid: '0',
            atTinyId: '0',
            atNtUid: '',
            subElementType: 0,
            atChannelId: '0'
        }
    };
}

/**
 * 早期版本往消息内容里塞「【已撤回 HH:MM】」文本。
 * 现在改为由 renderer 侧画徽章，这里只返回时间戳，不改消息内容。
 * 保留函数以便 config.markTextFallback 时回退。
 */
function applyMark(record, when) {
    if (config.markTextFallback !== true) return false;
    if (!config.mark) return false;
    const stamp = hhmm(when);
    const elements = Array.isArray(record.elements) ? record.elements : [];

    for (const el of elements) {
        const te = el && el.textElement;
        if (!te || typeof te.content !== 'string') continue;
        if (te.content.includes('【已撤回')) return false;
        te.content = `【已撤回 ${stamp}】${te.content}`;
        return true;
    }
    elements.unshift(makeMarkerElement(`【已撤回 ${stamp}】`));
    record.elements = elements;
    return true;
}

/* ───────────────────── 缓存与还原 ───────────────────── */

const cache = new Map();
const seen = new WeakSet();
const restoredKeys = new Set();

function evict() {
    if (cache.size <= MAX_CACHED) return;
    const drop = Math.max(1, Math.floor(MAX_CACHED * 0.1));
    let i = 0;
    for (const k of cache.keys()) {
        cache.delete(k);
        if (++i >= drop) break;
    }
}

function cacheRecord(record) {
    if (seen.has(record)) return false;
    if (!hasContent(record)) return false;
    const keys = collectKeys(record);
    if (!keys.size) return false;
    for (const k of keys) if (cache.has(k)) return false;

    const snapshot = clone(record);
    if (!snapshot) return false;

    // 收到就立刻复制图片/文件，避免撤回后原文件被清理
    try { localizeAssets(snapshot); } catch (error) {
        log('localize on cache failed:', error && error.message);
    }

    for (const k of keys) cache.set(k, snapshot);
    seen.add(record);
    evict();
    return true;
}

function findCached(record, recallInfo) {
    const keys = collectKeys(record, recallInfo);
    for (const k of keys) {
        const hit = cache.get(k);
        if (hit) return { snapshot: hit, key: k };
    }
    return null;
}

function restore(record, recallInfo) {
    const found = findCached(record, recallInfo);
    if (!found) return null;

    const fresh = clone(found.snapshot);
    if (!fresh) return null;

    const when = new Date();
    const firstTime = !restoredKeys.has(found.key);
    if (firstTime) {
        restoredKeys.add(found.key);
        try {
            // DOM 里的 data-element-id 是「元素的 elementId」，不是 msgId。
            // 两者通常差 1（见日志：msgId=...745，elementId=...744），
            // 所以必须把整条消息里所有 element 的 elementId 都纳入匹配集合。
            recalledIdSet.add(String(found.key));
            recalledIdSet.add(text(fresh && fresh.msgId));
            try {
                for (const el of Array.isArray(fresh && fresh.elements) ? fresh.elements : []) {
                    const te = el && el.textElement;
                    if (te && typeof te.content === 'string' && te.content.trim()) {
                        recalledFingerprints.add('t:' + te.content.trim().slice(0, 120));
                    }
                    const pic = el && (el.picElement || el.fileElement || el.videoElement);
                    if (pic) {
                        // 图片/文件名可能为空，补上本地路径的 basename 和 md5
                        const cands = [pic.fileName, pic.md5HexStr, pic.fileUuid,
                                       pic.sourcePath, pic.filePath, pic.originPath];
                        for (const c of cands) {
                            const s = text(c);
                            if (!s) continue;
                            const base = s.includes('/') ? s.split('/').pop() : s;
                            if (base) recalledFingerprints.add('f:' + base.slice(0, 120));
                        }
                    }
                }
            } catch { /* noop */ }
            recalledIdSet.add(text(fresh && fresh.msgSeq));
            if (Array.isArray(fresh && fresh.elements)) {
                for (const el of fresh.elements) {
                    if (el && typeof el === 'object') {
                        recalledIdSet.add(text(el.elementId));
                    }
                }
            }
            // 立刻推送到渲染层，避免等轮询
            Promise.resolve().then(publishRecalledIds).catch(() => {});
        } catch { /* noop */ }
        if (restoredKeys.size > 5000) {
            [...restoredKeys].slice(0, 1000).forEach(x => restoredKeys.delete(x));
        }
    }

    let assets = { images: [], files: [] };
    try { assets = localizeAssets(fresh); } catch { /* noop */ }

    const marked = applyMark(fresh, when);
    // renderer 侧据此画徽章（不依赖 UI 文本）
    try {
        fresh.__arl_recalled = Date.now();
        fresh.__arl_recall_time = `${hhmm(when)}`;
    } catch { /* noop */ }

    try {
        for (const k of Object.keys(record)) delete record[k];
    } catch { /* noop */ }
    Object.assign(record, fresh);
    try { record.__arl_recalled = fresh.__arl_recalled; record.__arl_recall_time = fresh.__arl_recall_time; } catch { /* noop */ }

    if (firstTime) {
        const { kind, parts } = summarizeElements(fresh.elements);
        const rawText = parts
            .filter(p => p.type === 'text')
            .map(p => p.content)
            .join('\n')
            .replace(/^【已撤回[^】]*】\s*/, '');

        let imageIdx = 0;
        let fileIdx = 0;
        for (const p of parts) {
            if (p.type === 'image' && assets.images[imageIdx]) p.local = assets.images[imageIdx++];
            else if ((p.type === 'file' || p.type === 'video') && assets.files[fileIdx]) p.local = assets.files[fileIdx++];
        }

        appendRecord({
            time: when.toISOString(),
            timeLocal: `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${hhmm(when)}`,
            key: found.key,
            msgId: text(fresh.msgId),
            msgSeq: text(fresh.msgSeq),
            msgTime: text(fresh.msgTime),
            kind,
            text: rawText.slice(0, 4000),
            parts: parts.slice(0, 20),
            peer: getPeerLabel(fresh),
            marked,
            fingerprints: (() => {
                const fp = [];
                for (const p of parts) {
                    if (p.type === 'text' && p.content) fp.push('t:' + String(p.content).trim().slice(0, 120));
                    else if (p.fileName) fp.push('f:' + String(p.fileName).trim().slice(0, 120));
                }
                return fp;
            })()
        });
    }

    return found.key;
}

/* ───────────────────────── 扫描 ───────────────────────── */

function scan(value, depth, out, visited) {
    if (depth > MAX_DEPTH || out.length >= MAX_SCAN) return;
    if (value === null || typeof value !== 'object') return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
        for (const item of value) scan(item, depth + 1, out, visited);
        return;
    }
    if (Array.isArray(value.elements) &&
        (value.msgId !== undefined || value.msgSeq !== undefined)) {
        out.push(value);
    }
    let keys = [];
    try { keys = Object.keys(value); } catch { return; }
    for (const k of keys) {
        let child;
        try { child = value[k]; } catch { continue; }
        if (child && typeof child === 'object') scan(child, depth + 1, out, visited);
    }
}

let stats = { channels: 0, records: 0, cached: 0, restored: 0 };
let lastSummary = 0;
const channelCensus = new Map();
let censusLogged = 0;

function census(channel) {
    const ch = String(channel || '');
    if (!ch) return;
    channelCensus.set(ch, (channelCensus.get(ch) || 0) + 1);
    const now = Date.now();
    if (now - censusLogged > 60000) {
        censusLogged = now;
        log('channel census:',
            [...channelCensus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12));
    }
}

function processArgs(args) {
    const records = [];
    scan(args, 0, records, new WeakSet());
    if (!records.length) return;

    stats.records += records.length;
    for (const record of records) {
        const recallInfo = detectRecall(record);
        if (recallInfo) {
            const key = restore(record, recallInfo);
            if (key) { stats.restored += 1; log('RESTORED', key); }
        } else if (cacheRecord(record)) {
            stats.cached += 1;
        }
    }

    const now = Date.now();
    if (now - lastSummary > 60000) {
        lastSummary = now;
        log('stats', stats);
    }
}

/* ───────────────────────── Hook ───────────────────────── */

const hookedContents = new WeakSet();

function hookWebContents(contents) {
    if (!contents || contents.isDestroyed()) return;
    if (hookedContents.has(contents)) return;

    const originalSend = contents.send.bind(contents);
    contents.send = function arlSend(channel, ...args) {
        try {
            census(channel);
            if (CHANNEL_RE.test(String(channel || ''))) {
                stats.channels += 1;
                processArgs(args);
            }
        } catch (error) {
            log('send hook error:', error && error.message);
        }
        return originalSend(channel, ...args);
    };
    hookedContents.add(contents);
    log('hooked webContents', contents.id);
}

const injectedWc = new WeakSet();

/**
 * 直接把徽章脚本注入渲染层（Electron 原生 executeJavaScript），
 * 不依赖 LiteLoader 的 renderer 通道 —— 那条路已验证不可靠。
 */
async function injectBadgeScript(win) {
    try {
        if (!win || win.isDestroyed()) return;
        const wc = win.webContents;
        if (!wc || wc.isDestroyed()) return;
        if (injectedWc.has(wc)) return;

        const url = wc.getURL();
        if (!url.includes('/main/message')) return;   // 只注入聊天窗口

        injectedWc.add(wc);

        const payload = JSON.stringify([...recalledIdSet].slice(-800).join(','));

        await wc.executeJavaScript(`(() => {
            if (window.__arlBadgeInstalled) {
                document.documentElement.setAttribute('data-arl-recalled-ids', ${payload});
                return 'already';
            }
            window.__arlBadgeInstalled = true;

            const SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 12a9 9 0 1 0 3-6.7L3 8'/%3E%3Cpath d='M3 3v5h5'/%3E%3C/svg%3E";

            if (!document.getElementById('arl-style')) {
                const st = document.createElement('style');
                st.id = 'arl-style';
                st.textContent = [
                    '.arl-tip{display:inline-block;padding:1px 7px;margin-left:6px;',
                    'font-size:11px;line-height:15px;border-radius:9px;',
                    'background:rgba(240,168,87,.16);color:#e79a41;',
                    'border:1px solid rgba(240,168,87,.34);font-weight:600;',
                    'white-space:nowrap;pointer-events:none;vertical-align:1px}',
                    '.arl-tip--media{position:absolute;top:5px;right:8px;z-index:5;',
                    'margin:0;background:rgba(28,22,14,.80);color:#ffc074;',
                    'border-color:rgba(255,192,116,.45);',
                    'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}'
                ].join('');
                document.head.appendChild(st);
            }

            const getIds = () => {
                const raw = document.documentElement.getAttribute('data-arl-recalled-ids') || '';
                return new Set(raw.split(',').map(x => x.trim()).filter(Boolean));
            };
            const getFps = () => {
                const raw = document.documentElement.getAttribute('data-arl-fingerprints') || '';
                return new Set(raw.split('\u0001').map(x => x.trim()).filter(Boolean));
            };

            // 找消息根
            const messageRoot = (el) => {
                let p = el;
                for (let i = 0; i < 12 && p; i++) {
                    if (p.classList && p.classList.contains('message')) return p;
                    p = p.parentElement;
                }
                return null;
            };

            // 严格去重：一条消息最多一个标记（用属性锁）
            // 只用一个橙色「已撤回」小标签；文字消息跟在正文后，图片消息浮在气泡角上
            const addBadge = (root) => {
                if (!root) return false;
                if (root.getAttribute('data-arl-done') === '1') return false;
                if (root.querySelector('.arl-tip')) {
                    root.setAttribute('data-arl-done', '1');
                    return false;
                }

                const tip = document.createElement('span');
                tip.className = 'arl-tip';
                tip.textContent = '已撤回';
                tip.title = '这条消息已被撤回（本地保留）';

                // 判断是不是图片/视频/文件消息（有 img 或 image 容器，没有 text-element）
                const isMedia = !!root.querySelector('img, .image-element, [class*="pic-element"], video')
                                && !root.querySelector('.text-element');

                if (isMedia) {
                    // 浮在气泡右上角，不撑破布局
                    tip.classList.add('arl-tip--media');
                    const anchor = root.querySelector('.message-content__wrapper')
                                || root.querySelector('.msg-content-container')
                                || root;
                    try {
                        const cur = getComputedStyle(anchor).position;
                        if (cur === 'static') anchor.style.position = 'relative';
                        anchor.appendChild(tip);
                        root.setAttribute('data-arl-done', '1');
                        return true;
                    } catch (e) { return false; }
                }

                // 文字消息：跟在文本后面（行内），不换行
                const host = root.querySelector('.text-element')
                          || root.querySelector('.message-content')
                          || root;
                try {
                    host.appendChild(tip);
                    root.setAttribute('data-arl-done', '1');
                    return true;
                } catch (e) { return false; }
            };

            const scan = () => {
                const ids = getIds();
                const fps = getFps();
                if (!ids.size && !fps.size) return 0;
                let hit = 0;

                // 路径 1：按 data-element-id 匹配
                for (const el of document.querySelectorAll('[data-element-id]')) {
                    const id = (el.getAttribute('data-element-id') || '').trim();
                    if (!id || !ids.has(id)) continue;
                    const root = messageRoot(el);
                    if (root && addBadge(root)) hit++;
                }

                // 路径 2：按内容指纹匹配（图片/文件消息、以及重启后的历史消息）
                if (fps.size) {
                    for (const root of document.querySelectorAll('.message')) {
                        if (root.getAttribute('data-arl-done') === '1') continue;
                        const txt = (root.textContent || '').trim();
                        let matched = false;
                        for (const fp of fps) {
                            const needle = fp.slice(2);
                            if (!needle) continue;
                            if (fp.startsWith('t:') && txt.includes(needle)) { matched = true; break; }
                            if (fp.startsWith('f:') && (root.innerHTML || '').includes(needle)) { matched = true; break; }
                        }
                        if (matched && addBadge(root)) hit++;
                    }
                }
                return hit;
            };

            window.__arlScan = scan;
            new MutationObserver(() => { try { scan(); } catch (e) {} })
                .observe(document.body, { childList: true, subtree: true });
            setInterval(() => { try { scan(); } catch (e) {} }, 3000);
            scan();
            return 'installed';
        })()`, true);

        log('badge script injected for', url.slice(-25));
    } catch (error) {
        log('injectBadgeScript error:', error && error.message);
    }
}

function hookWindow(win) {
    try {
        if (!win || win.isDestroyed()) return;
        hookWebContents(win.webContents);
        injectBadgeScript(win);
    } catch (error) {
        log('hookWindow error:', error && error.message);
    }
}

let diagnosed = false;
async function diagnoseRenderer(win) {
    if (diagnosed) return;
    diagnosed = true;
    try {
        const wc = win.webContents;
        if (!wc || wc.isDestroyed()) return;
        const info = await wc.executeJavaScript(`(() => {
            const out = { url: location.href, ready: document.readyState,
                          arlAttr: document.documentElement.getAttribute('data-arl-renderer'),
                          badges: document.querySelectorAll('.arl-recall-badge').length };

            // 找到所有带有 __vueParentComponent 且 props 里有 msgId 的元素，反推类名
            const classHits = {};
            const sample = [];
            let scanned = 0;
            const all = document.querySelectorAll('*');
            for (const el of all) {
                if (++scanned > 60000) break;
                const inst = el.__vueParentComponent;
                if (!inst) continue;
                let cur = inst, depth = 0, hit = null;
                while (cur && depth++ < 12) {
                    const pr = cur.props || {};
                    for (const k of Object.keys(pr)) {
                        const v = pr[k];
                        if (v && typeof v === 'object' && (v.msgId !== undefined || v.msgSeq !== undefined)) {
                            hit = k; break;
                        }
                    }
                    if (hit) break;
                    cur = cur.parent;
                }
                if (!hit) continue;
                const cls = (el.className && typeof el.className === 'string') ? el.className : '';
                for (const c of cls.split(/\\s+/).filter(Boolean)) {
                    classHits[c] = (classHits[c] || 0) + 1;
                }
                if (sample.length < 6) {
                    sample.push({ cls: cls.slice(0, 120), propKey: hit, tag: el.tagName });
                }
            }
            out.propKeyHits = classHits;
            out.sample = sample;
            out.totalElems = all.length;
            return out;
        })()`, true);
        log('=== RENDERER DIAG ===', JSON.stringify(info));
    } catch (error) {
        log('diagnoseRenderer failed:', error && error.message);
    }
}

function hookAll() {
    try { for (const win of BrowserWindow.getAllWindows()) hookWindow(win); } catch { /* noop */ }
}

function hookIpcMain() {
    try {
        if (ipcMain.__arlHooked) return;
        const originalEmit = ipcMain.emit;
        ipcMain.emit = function arlEmit(channel, ...args) {
            try {
                census(channel);
                if (CHANNEL_RE.test(String(channel || ''))) {
                    stats.channels += 1;
                    processArgs(args.slice(1));
                }
            } catch (error) {
                log('ipcMain hook error:', error && error.message);
            }
            return originalEmit.call(this, channel, ...args);
        };
        ipcMain.__arlHooked = true;
        log('hooked ipcMain.emit');
    } catch (error) {
        log('hookIpcMain error:', error && error.message);
    }
}

/** 已撤回的 msgId 集合（供渲染层打徽章） */
const recalledIdSet = new Set();
/** 已撤回消息的「内容指纹」（文本 / 图片文件名），供渲染层兜底匹配 */
const recalledFingerprints = new Set();

/**
 * 从 recalled.jsonl 恢复历史撤回记录的 key / msgId / elementId，
 * 这样重启 QQ 后，历史消息仍能显示徽章。
 */
function restoreRecalledIdsFromDisk() {
    try {
        if (!fs.existsSync(RECORD_FILE)) return;
        const content = fs.readFileSync(RECORD_FILE, 'utf-8');
        for (const line of content.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try {
                const entry = JSON.parse(t);
                recalledIdSet.add(text(entry && entry.key));
                recalledIdSet.add(text(entry && entry.msgId));
                recalledIdSet.add(text(entry && entry.msgSeq));
                for (const p of Array.isArray(entry && entry.parts) ? entry.parts : []) {
                    if (p && p.elementId) recalledIdSet.add(text(p.elementId));
                }
                for (const fp of Array.isArray(entry && entry.fingerprints) ? entry.fingerprints : []) {
                    if (fp) recalledFingerprints.add(String(fp));
                }
            } catch { /* 跳过坏行 */ }
        }
        log('restored recalled ids from disk:', recalledIdSet.size);
    } catch (error) {
        log('restoreRecalledIdsFromDisk error:', error && error.message);
    }
}

async function publishRecalledIds() {
    if (!recalledIdSet.size) return;
    const payload = [...recalledIdSet].slice(-800).join(',');
    const fpPayload = [...recalledFingerprints].slice(-800).join('\u0001');
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    for (const w of wins) {
        try {
            const url = w.webContents.getURL();
            if (!url.includes('/main/message')) continue;
            await w.webContents.executeJavaScript(`(() => {
                document.documentElement.setAttribute('data-arl-recalled-ids', ${JSON.stringify(payload)});
                document.documentElement.setAttribute('data-arl-fingerprints', ${JSON.stringify(fpPayload)});
                try { if (window.__arlScan) window.__arlScan(); } catch (e) {}
                return true;
            })()`, true);
        } catch { /* 单个窗口失败不影响其他 */ }
    }
}

/* ───────────────── 本地查看服务（仅 127.0.0.1，不出站）───────────────── */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jsonl': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
    '.pdf': 'application/pdf', '.webm': 'video/webm'
};

let server = null;
let serverUrl = '';

function startServer() {
    if (server) return;
    const port = Number(config.serverPort) || 8788;

    server = http.createServer((req, res) => {
        try {
            const url = decodeURIComponent((req.url || '/').split('?')[0]);
            const rel = url === '/' ? 'viewer.html' : url.replace(/^\/+/, '');
            const target = path.join(DATA_DIR, rel);
            const resolved = path.resolve(target);
            const root = path.resolve(DATA_DIR);

            if (!resolved.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
                res.writeHead(404).end('not found');
                return;
            }

            const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
            const buf = fs.readFileSync(resolved);
            res.writeHead(200, {
                'Content-Type': type,
                'Cache-Control': 'no-store',
                'Content-Length': buf.length
            });
            res.end(buf);
        } catch (error) {
            log('server error:', error && error.message);
            try { res.writeHead(500).end('error'); } catch { /* noop */ }
        }
    });

    server.on('error', error => {
        log('server listen error:', error && error.message);
        server = null;
    });

    server.listen(port, '127.0.0.1', () => {
        serverUrl = `http://127.0.0.1:${port}/viewer.html`;
        log('viewer server listening:', serverUrl);
        try {
            fs.writeFileSync(URL_FILE,
                `撤回记录查看地址：\n\n  ${serverUrl}\n\n（只在本机可访问；关掉 QQ 后失效。）\n`,
                'utf-8');
        } catch { /* noop */ }
    });
}

/* ───────────────────────── 启动 ───────────────────────── */

exports.onBrowserWindowCreating = () => hookAll();

try {
    loadConfig();
    fs.mkdirSync(DATA_DIR, { recursive: true });

    log('=== plugin loaded | v1.3 | electron', process.versions.electron,
        '| mark:', config.mark, '| images:', config.localizeImages, '===');

    hookIpcMain();
    app.on('browser-window-created', (_e, win) => hookWindow(win));

    const boot = () => {
        hookAll();
        if (config.autoServer) startServer();
        restoreRecalledIdsFromDisk();
        const timer = setInterval(hookAll, 4000);
        if (timer.unref) timer.unref();
        log('ready | data dir:', DATA_DIR);

        // 周期性地：确保聊天窗口被注入 + 同步已撤回 id
        // 持续自检：用户打开会话后再看，每到 8 秒报告一次
        let selfCheckRounds = 0;
        const selfCheck = setInterval(async () => {
            if (++selfCheckRounds > 12) { clearInterval(selfCheck); return; }
            for (const w of BrowserWindow.getAllWindows()) {
                if (w.isDestroyed()) continue;
                let url = '';
                try { url = w.webContents.getURL(); } catch { continue; }
                if (!url.includes('/main/message')) continue;
                try {
                    const r = await w.webContents.executeJavaScript(`(() => ({
                        installed: !!window.__arlBadgeInstalled,
                        idCount: (document.documentElement.getAttribute('data-arl-recalled-ids') || '').split(',').filter(Boolean).length,
                        elementIds: document.querySelectorAll('[data-element-id]').length,
                        msgs: document.querySelectorAll('.message').length,
                        badges: document.querySelectorAll('.arl-tip').length
                    }))()`, true);
                    if (r.elementIds > 0 || r.badges > 0) {
                        log('=== BADGE SELFCHECK ===', JSON.stringify(r));
                    }
                } catch { /* noop */ }
            }
        }, 8000);
        if (selfCheck.unref) selfCheck.unref();

        const tick = () => {
            try {
                for (const w of BrowserWindow.getAllWindows()) {
                    if (w.isDestroyed()) continue;
                    injectBadgeScript(w);
                }
                publishRecalledIds();
            } catch { /* noop */ }
        };
        setTimeout(tick, 3000);
        const pubTimer = setInterval(tick, 2500);
        if (pubTimer.unref) pubTimer.unref();
    };
    if (app.isReady()) boot();
    else app.whenReady().then(boot).catch(() => { /* noop */ });

    app.on('will-quit', () => {
        try { if (server) server.close(); } catch { /* noop */ }
    });
} catch (error) {
    log('startup error:', error && error.message);
}
