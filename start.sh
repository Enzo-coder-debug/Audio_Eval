#!/bin/bash
[ -f "/home/admin/start_before.sh" ] && bash /home/admin/start_before.sh
# 此脚本必须在/home/admin下，为应用的启动脚本
SERVER_NAME="redis-server"
RUNCMD="/opt/redis/bin/$SERVER_NAME /opt/redis/etc/redis.conf"
pgrep $SERVER_NAME && echo "$SERVER_NAME is running" || { $RUNCMD && echo "$SERVER_NAME start success"; }
[ -f "/home/admin/start_after.sh" ] && bash /home/admin/start_after.sh