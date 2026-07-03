#!/bin/bash
[ -f "/home/admin/stop_before.sh" ] && bash /home/admin/stop_before.sh
# 此脚本必须在/home/admin下，为应用的停止脚本
SERVER_NAME="redis-server"
pgrep $SERVER_NAME && { pkill $SERVER_NAME && echo "$SERVER_NAME stop success"; } || echo "$SERVER_NAME is not running"
[ -f "/home/admin/stop_after.sh" ] && bash /home/admin/stop_after.sh