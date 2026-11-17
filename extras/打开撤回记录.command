#!/bin/bash
# 打开撤回记录查看页
# 用法：双击运行，或在终端执行 ./打开撤回记录.command
set -eu

DATA="$HOME/Library/Containers/com.tencent.qq/Data/Library/Application Support/LiteLoaderQQNT/data/anti_recall_lite"
RECORD="$DATA/recalled.jsonl"
PORT=8788

echo "======================================"
echo " 撤回记录查看器"
echo "======================================"
echo

if [ ! -d "$DATA" ]; then
    echo "❌ 找不到数据目录："
    echo "   $DATA"
    echo
    echo "可能插件还没生效。请先重启 QQ。"
    read -r -p "按回车关闭..." _
    exit 1
fi

if [ ! -f "$RECORD" ]; then
    echo "⚠️  还没有撤回记录文件。"
    echo "   收到撤回消息后会自动生成。"
    echo
    echo "   如果确认已经有过撤回，请检查："
    echo "   $DATA/debug.log"
    echo
fi

COUNT=$( [ -f "$RECORD" ] && wc -l < "$RECORD" | tr -d ' ' || echo 0 )
echo "记录条数：$COUNT"
echo "数据目录：$DATA"
echo

# 复制一份 viewer 到数据目录（确保是最新）
VIEWER_SRC="$(cd "$(dirname "$0")" && pwd)/viewer.html"
if [ -f "$VIEWER_SRC" ]; then
    cp "$VIEWER_SRC" "$DATA/viewer.html" 2>/dev/null || true
fi

# 启动本地 HTTP 服务（避免 file:// 无法读本地文件的限制）
cd "$DATA"
echo "正在启动本地服务 http://localhost:$PORT ..."

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!

sleep 1
open "http://localhost:$PORT/viewer.html"

echo
echo "✅ 已在浏览器打开"
echo "   地址：http://localhost:$PORT/viewer.html"
echo
echo "关闭这个终端窗口即可停止服务。"
echo "（服务进程 PID: $SERVER_PID）"
echo

# 保持终端开着，方便用户关闭
wait $SERVER_PID 2>/dev/null || true
