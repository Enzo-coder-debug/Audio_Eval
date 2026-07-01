# =============================================================================
# audio_evaluation_platform — 京东云 DevCloud 部署镜像
# 说明：本项目使用 pnpm（含 patchedDependencies / overrides），DevCloud 一键
# 流水线的 npm ci 无法正确处理 pnpm 专属特性，故提供自定义 Dockerfile。
#
# DevCloud 预处理器会：
#   1) 把 `node:20-slim` 重写为内网镜像 baseimages/node:lts-slim
#   2) 在每个 node FROM 后自动注入 `npm config set registry npmmirror`
# 因此这里不手动配置 npm/apt 镜像；pnpm 的镜像另行显式设置。
# =============================================================================

# ---------- 构建阶段 ----------
FROM node:20-slim AS builder
WORKDIR /app

# 启用 corepack 以使用项目指定的 pnpm 版本（package.json packageManager 字段）
RUN corepack enable

# 先拷贝依赖清单与补丁，最大化利用构建缓存
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches

# pnpm 走国内镜像加速安装（预处理器只改 npm，不改 pnpm）
RUN pnpm config set registry https://registry.npmmirror.com/ \
  && pnpm install --frozen-lockfile

# 拷贝其余源码并构建（vite build 生成 dist/public，esbuild 生成 dist/index.js）
COPY . .
RUN pnpm run build

# ---------- 运行阶段 ----------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

RUN corepack enable

# 只安装生产依赖（esbuild 用 --packages=external，运行时需 node_modules）
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm config set registry https://registry.npmmirror.com/ \
  && pnpm install --frozen-lockfile --prod

# 拷贝构建产物（前端静态资源 dist/public + 后端 dist/index.js）
COPY --from=builder /app/dist ./dist

# DevCloud 的 K8s ingress 只暴露容器 8080 端口，且须绑定 0.0.0.0
EXPOSE 8080

# 应用内部已默认监听 0.0.0.0:8080（server/_core/index.ts 生产分支）
CMD ["node", "dist/index.js"]