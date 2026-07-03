#!/bin/bash
# =============================================================================
# JDOS 应用启动脚本（必须放在 /home/admin 下，由 start_container.sh 以 admin 调用）
# 职责：启动 audio_evaluation_platform 的 Node 应用（对应模板里启动 server 的位置）。
# =============================================================================
[ -f "/home/admin/start_before.sh" ] && bash /home/admin/start_before.sh

APP_DIR=/opt/app
LOG_DIR=/export/log/audio-eval
mkdir -p "$LOG_DIR"
cd "$APP_DIR"

# 幂等：已在运行则不重复拉起
if pgrep -f "node dist/index.js" > /dev/null; then
  echo "audio-eval is running"
else
  echo "[start.sh] $(date '+%F %T') launching node dist/index.js (node $(node -v))" >> "$LOG_DIR/app.log"
  # 后台启动，日志落盘；应用内部固定监听 0.0.0.0:8080
  NODE_ENV=production PORT=8080 nohup node dist/index.js >> "$LOG_DIR/app.log" 2>&1 &
  echo "[start.sh] app pid: $!" >> "$LOG_DIR/app.log"
  echo "audio-eval start success"
fi

[ -f "/home/admin/start_after.sh" ] && bash /home/admin/start_after.sh