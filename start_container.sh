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
# 必须切换到 admin 用户启动应用
su -m admin -c "bash /home/admin/start.sh"