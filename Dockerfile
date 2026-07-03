# =============================================================================
# audio_evaluation_platform — 京东云 JDOS 部署镜像
#
# 【JDOS 范式说明】
#   - 不写 FROM：JDOS 构建时用控制台选择的“基础镜像”作为 FROM
#     （请选带 Node v20 的镜像，如 nodejs-jdt-centos8.4-node-v20.19.0）
#   - 容器需常驻并跑 sshd/crond，平台通过 SSH 进容器管理（这也是之前
#     ssh <pod>:22 refused 的原因：旧镜像没跑 sshd）
#   - 应用由 /home/admin/start_container.sh 拉起，容器靠 sleep 常驻
#   - 不要拷贝文件到 /export：JDOS 拉起实例时会把本地盘挂载到 /export
#
# 【构建策略】在镜像内完成 pnpm 依赖安装与构建，产物打进镜像；
#   容器启动时直接 node dist/index.js，无需联网重装依赖。
# =============================================================================

# 环境变量（应用运行需要，业务敏感变量在 JDOS 控制台注入）
ENV LANG=en_US.UTF-8
ENV NODE_ENV=production
ENV PORT=8080

# 应用代码目录（勿用 /export，该目录会被平台挂载覆盖）
WORKDIR /opt/app

# 启用 corepack 以使用 package.json 指定的 pnpm 版本
RUN corepack enable || npm i -g corepack && corepack enable

# 先拷贝依赖清单与补丁，最大化利用构建缓存
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches

# 安装全部依赖（含 devDependencies，构建需要 vite/esbuild）
RUN pnpm config set registry https://registry.npmmirror.com/ \
  && pnpm install --frozen-lockfile

# 拷贝其余源码并构建（vite build -> dist/public，esbuild -> dist/index.js）
COPY . .
RUN pnpm run build

# 目录赋权给 admin（JDOS 容器以 admin 用户运行应用）
RUN chown -R admin:admin /opt/app || true

# 拷贝启动/停止脚本到镜像（JDOS 必须）
ADD start.sh stop.sh /home/admin/
ADD start_container.sh /home/admin/

# 脚本赋权（必须）
RUN chown admin:admin /home/admin/start.sh /home/admin/stop.sh /home/admin/start_container.sh \
  && chmod +x /home/admin/start.sh /home/admin/stop.sh /home/admin/start_container.sh

# 下载 tini，防止僵尸进程（JDOS 提供的内网地址）
ADD --chmod=0755 http://s3-internal.cn-north-1.jdcloud-oss.com/jdos-build-public/tools/tini/tini-amd64-v0.19.0 /home/admin/tini

# 应用监听 8080（server/_core/index.ts 生产分支绑定 0.0.0.0:8080）
EXPOSE 8080

# ENTRYPOINT 必须保留 sshd/crond + start_container.sh + sleep 常驻（JDOS 必须）
ENTRYPOINT /home/admin/tini -- sh -c "/usr/sbin/sshd && /usr/sbin/crond && bash /home/admin/start_container.sh && sleep 9999999d"