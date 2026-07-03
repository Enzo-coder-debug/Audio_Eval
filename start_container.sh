#!/bin/bash
# =============================================================================
# JDOS 容器入口脚本（平台标准模板，勿删初始化逻辑）
# 由 Dockerfile ENTRYPOINT 调用：先做平台环境初始化，再切 admin 用户启动应用。
# =============================================================================

#mirror_server='172.25.134.109'
mirror_server='mirrors.jdfin.local'
docker_init_script='docker_initialize.sh'
uname -m |grep -q aarch64 && docker_init_script='docker_initialize_arm.sh'
grep -qi ubuntu /etc/issue && mkdir -p /run/sshd && docker_init_script='docker_initialize_ubuntu.sh'
docker_init_url="http://${mirror_server}/docker/${docker_init_script}"

while true;do
  if ping -c 1 $mirror_server > /dev/null 2>&1;then
    echo "network is normal"
    if [[ `curl -I -m 1 -o /dev/null -s -w %{http_code} $docker_init_url` == 200 ]];then
      echo 'http test success'
      break
    else
      echo 'http test error'
    fi
  else
    echo "network is unnormal"
    ip ad sh
    ip ro sh
  fi
  sleep 2
done

curl -sL  $docker_init_url | bash
[[ -d /export/Logs ]] || { mkdir -p /export/Logs && chown admin:admin /export/Logs; }

[ -f "/home/admin/start_before.sh" ] && su -m admin -c "bash /home/admin/start_before.sh"
# 应用代码在 /opt/app，运行日志在 /export/log/audio-eval，创建并赋权
mkdir -p /export/log/audio-eval/
chown -R admin:admin /opt/ /export/log/audio-eval/

# ---- 关键：把容器级环境变量固化到 /opt/app/.env ----
# 原因：JDOS 通过 K8s 把业务环境变量注入到本入口进程(PID1)，但 `su -m admin`
# 切换用户后这些变量会丢失，导致应用内 DATABASE_URL/JWT_SECRET/ADMIN_* 全 MISSING。
# 应用入口 server/_core/index.ts 顶部有 `import "dotenv/config"`，会自动读取
# 工作目录(/opt/app)下的 .env。因此在切 admin 前，把注入变量 dump 成 .env，
# dotenv 即可稳定加载，彻底规避 su 丢环境的问题。
ENV_FILE=/opt/app/.env
: > "$ENV_FILE"
for KEY in DATABASE_URL JWT_SECRET \
           OSS_ENDPOINT OSS_REGION OSS_BUCKET OSS_ACCESS_KEY_ID OSS_SECRET_ACCESS_KEY \
           ADMIN_USERNAME ADMIN_PASSWORD ADMIN_OPEN_ID \
           OAUTH_SERVER_URL VITE_APP_ID OWNER_OPEN_ID OWNER_NAME; do
  VAL=$(eval "printf '%s' \"\${$KEY}\"")
  if [ -n "$VAL" ]; then
    printf '%s=%s\n' "$KEY" "$VAL" >> "$ENV_FILE"
  fi
done
chown admin:admin "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "[start_container.sh] dumped $(grep -c '=' "$ENV_FILE" 2>/dev/null || echo 0) env vars to $ENV_FILE"

# 必须切换到 admin 用户启动应用
su -m admin -c "bash /home/admin/start.sh"