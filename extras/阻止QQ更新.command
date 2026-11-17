#!/bin/bash
# 阻止 QQ 后台下载热更新包（配合 QQ 设置里「有新版本时自动安装」= 关）
# 原理：把已下载的包移走备份，再放同名只读占位文件，让后续下载写不进去。
# 不动 QQ 主程序、不改签名。双击运行一次即可。
set -eu
V="$HOME/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/versions"
BK="$HOME/Library/Application Support/liteloader-guard/qq-updates-blocked"
mkdir -p "$BK"

CUR=$(python3 -c "
import json,os
p=os.path.expanduser('~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/versions/config.json')
try: print(json.load(open(p,encoding='utf-8')).get('curVersion',''))
except: print('')
")
echo "当前版本: ${CUR:-未知}"

moved=0
for item in "$V"/*; do
  [ -e "$item" ] || continue
  n=$(basename "$item")
  case "$n" in config.json|channel.json|setting.json|qqhelper.json) continue;; esac
  case "$n" in
    *.zip|*.zip.zip|[0-9]*.[0-9]*-[0-9]*) ;;
    *) continue;;
  esac
  # 已经是只读占位就跳过
  [ ! -w "$item" ] && continue
  # 非空才是真包
  sz=$(stat -f "%z" "$item" 2>/dev/null || echo 0)
  if [ "$sz" -gt 1024 ]; then
    d="$BK/$n"; [ -e "$d" ] && d="$BK/$n-$(date +%Y%m%d-%H%M%S)"
    mv "$item" "$d"; echo "  备份: $n"; moved=$((moved+1))
  fi
  # 放只读占位，阻止重新下载
  : > "$V/$n"
  chmod 444 "$V/$n"
  echo "  只读占位: $n"
done

python3 - <<'PY'
import json, os
p = os.path.expanduser('~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/versions/config.json')
try:
    d = json.load(open(p, encoding='utf-8'))
    d['readyVersion'] = ''; d['readyInstaller'] = ''
    json.dump(d, open(p,'w',encoding='utf-8'), ensure_ascii=False, indent=2)
except Exception as e:
    print('  配置更新失败(可忽略):', e)
PY

echo
echo "完成。备份在: $BK"
echo "恢复: 删掉占位文件并把备份放回 $V"
echo "注意: 请同时保持 QQ 设置 → 「有新版本时自动安装」= 关"
echo
read -r -p "按回车关闭..." _ || true
