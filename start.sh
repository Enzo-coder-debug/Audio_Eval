#!/bin/bash
# =============================================================================
# JDOS 应用启动脚本（必须放在 /home/admin 下，由 start_container.sh 以 admin 调用）
# 职责：启动 audio_evaluation_platform 的 Node 应用（对应模板里启动 server 的位置）。
#
# 关键修复：
#  1) node 路径自适应：su -m admin 后 PATH 可能不含 node，这里主动探测常见安装路径，
#     用绝对路径调用，避免 "nohup: failed to run command 'node': No such file or directory"。
#  2) 环境变量透传：JDOS 注入的容器级环境变量在 su 切换后可能丢失，这里显式加载
#     /etc/profile 与 /export/env 里的注入变量，确保 DATABASE_URL/JWT_SECRET 等能被应用读到。
# =============================================================================

APP_DIR=/opt/app
LOG_DIR=/export/log/audio-eval
mkdir -p "$LOG_DIR"

# ---- 1) 加载容器级环境变量（JDOS 注入变量可能在 su 后丢失）----
# 尝试从常见位置加载已注入的环境变量
[ -f /etc/profile ] && . /etc/profile 2>/dev/null || true
[ -f /export/env ] && set -a && . /export/env 2>/dev/null && set +a || true
[ -f /home/admin/.jdos_env ] && set -a && . /home/admin/.jdos_env 2>/dev/null && set +a || true

# ---- 2) 定位 node 二进制（PATH 优先，失败则探测常见安装路径）----
NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  for p in \
    /usr/local/nodejs/bin/node \
    /usr/local/node-v*/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /usr/local/node/bin/node \
    /opt/node/bin/node \
    /home/admin/.nvm/versions/node/*/bin/node; do
   if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  # 最后手段：全盘搜一次
  NODE_BIN="$(find / -maxdepth 6 -name node -type f -perm -u+x 2>/dev/null | head -n1)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "[start.sh] $(date '+%F %T') FATAL: node binary not found in container. PATH=$PATH" >> "$LOG_DIR/app.log"
  echo "audio-eval start FAILED: node not found"
  exit 1
fi
# 把 node 所在目录补进 PATH
export PATH="$(dirname "$NODE_BIN"):$PATH"

[ -f "/home/admin/start_before.sh" ] && bash /home/admin/start_before.sh

cd "$APP_DIR" || { echo "[start.sh] FATAL: $APP_DIR not found" >> "$LOG_DIR/app.log"; exit 1; }

# 幂等：已在运行则不重复拉起
if pgrep -f "node dist/index.js" > /dev/null; then
  echo "audio-eval is running"
else
  echo "[start.sh] $(date '+%F %T') launching: $NODE_BIN dist/index.js (v$("$NODE_BIN" -v 2>/dev/null))" >> "$LOG_DIR/app.log"
  echo "[start.sh] env check: DATABASE_URL=$([ -n "$DATABASE_URL" ] && echo set || echo MISSING) JWT_SECRET=$([ -n "$JWT_SECRET" ] && echo set || echo MISSING) ADMIN_USERNAME=$([ -n "$ADMIN_USERNAME" ] && echo set || echo MISSING)" >> "$LOG_DIR/app.log"
  # 后台启动，日志落盘；应用内部固定监听 0.0.0.0:8080
  NODE_ENV=production PORT=8080 nohup "$NODE_BIN" dist/index.js >> "$LOG_DIR/app.log" 2>&1 &
  echo "[start.sh] app pid: $!" >> "$LOG_DIR/app.log"
  echo "audio-eval start success"
fi

[ -f "/home/admin/start_after.sh" ] && bash /home/admin/start_after.sh