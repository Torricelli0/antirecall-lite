#!/bin/bash
# 阻止 QQ 热更新切换版本（避免掉登录）
# 做法：把 versions/ 里"非当前版本"的包移到备份目录，不删除。
# 双击运行一次即可；也可加入「登录项」每次开机执行。
set -eu

V="$HOME/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/versions"
CFG="$V/config.json"
BK="$HOME/Library/Application Support/liteloader-guard/qq-updates-blocked"
mkdir -p "$BK"

CUR=$(python3 -c "
import json,os
p=os.path.expanduser('~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/versions/config.json')
try: print(json.load(open(p,encoding='utf-8')).get('curVersion',''))
except: print('')
")

echo "当前版本: ${CUR:-未知}"
echo "检查目录: $V"
echo

moved=0
for item in "$V"/*; do
    [ -e "$item" ] || continue
    name=$(basename "$item")
    case "$name" in
        config.json|channel.json|setting.json|qqhelper.json) continue ;;
    esac
    # 只处理形如 7.0.3-54395 的版本目录/zip
    case "$name" in
        [0-9]*.[0-9]*-[0-9]*|[0-9]*.[0-9]*-[0-9]*.zip) ;;
        *) continue ;;
    esac
    # 当前版本跳过
    [ "$name" = "$CUR" ] && continue
    [ "$name" = "$CUR.zip" ] && continue

    dest="$BK/$name"
    [ -e "$dest" ] && dest="$BK/$name-$(date +%Y%m%d-%H%M%S)"
    mv "$item" "$dest"
    echo "  已移走: $name"
    moved=$((moved+1))
done

# 清掉 QQ 记住的待装版本
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/versions/config.json')
try:
    d = json.load(open(p, encoding='utf-8'))
    d['readyVersion'] = ''
    d['readyInstaller'] = ''
    json.dump(d, open(p,'w',encoding='utf-8'), ensure_ascii=False, indent=2)
except Exception as e:
    print('  配置更新失败（可忽略）:', e)
PY

if [ "$moved" -eq 0 ]; then
    echo "没有发现待切换的更新包，当前已是干净状态 ✅"
else
    echo "共移走 $moved 项，已备份到："
    echo "  $BK"
fi

echo
echo "恢复方法：把备份目录里的文件放回 $V 即可。"
echo
read -r -p "按回车关闭..." _ || true
