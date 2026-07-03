#!/bin/bash
# =============================================================================
# JDOS 应用停止脚本（必须放在 /home/admin 下，为应用的停止脚本）
# 职责：停止 audio_evaluation_platform 的 Node 应用。
# =============================================================================
[ -f "/home/admin/stop_before.sh" ] && bash /home/admin/stop_before.sh

# 匹配并结束应用进程
if pgrep -f "node dist/index.js" > /dev/null; then
  pkill -f "node dist/index.js" && echo "audio-eval stop success"
  sleep 2
  pkill -9 -f "node dist/index.js" 2>/dev/null || true
else
  echo "audio-eval is not running"
fi

[ -f "/home/admin/stop_after.sh" ] && bash /home/admin/stop_after.sh