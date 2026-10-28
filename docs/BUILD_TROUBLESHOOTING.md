# 构建依赖下载超时

`ETIMEDOUT` 出现在依赖安装阶段时，先确认是 Corepack 下载 pnpm，还是 pnpm 下载项目依赖。仅设置 pnpm 的 registry 不覆盖 Corepack；更改容器运行时环境变量也不会修复已经失败的镜像构建。

## 仓库内的配置

- `.npmrc` 默认使用 `https://registry.npmmirror.com/`，设置有限的重试、超时和并发，保留 TLS 校验。
- Dockerfile 在首次运行 Corepack/pnpm 前，统一设置 npm 和 Corepack 的 registry，并提前复制 `.npmrc`。Corepack 的源地址去除末尾斜杠，避免请求出现双斜杠导致镜像返回 404。
- pnpm 使用 `package.json` 固定的版本及 SHA-512，不修改锁文件或关闭完整性校验。仅在基础镜像没有 Corepack 时安装兼容 Node 20.19 的固定版本 `corepack@0.31.0`；已有 Corepack 启动失败时直接报错，不隐式升级。
- 镜像中已有 `NODE_ENV=production`，安装时仍显式使用 `--prod=false`，确保 Vite、TypeScript、esbuild 等构建工具不被跳过。容器启动阶段仍不安装依赖。
- 如果构建网络只允许公司内网制品库，在 JDOS 的镜像构建参数中指定 `NPM_REGISTRY` 为已批准、可访问的 registry。不要在仓库或构建参数里写入账号、密码、token。

## 平台在 Dockerfile 之前执行 pnpm install

若失败日志来自平台的独立依赖安装步骤，需要在该步骤运行前设置**构建环境**，而非应用运行时环境：

```sh
export npm_config_registry=https://registry.npmmirror.com/
export COREPACK_NPM_REGISTRY="${npm_config_registry%/}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_DEFAULT_TO_LATEST=0
corepack enable
corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate
pnpm install --frozen-lockfile --prod=false --registry="$npm_config_registry"
pnpm run build
```

以上命令在项目根目录执行，需要基础镜像已提供 Corepack；若未提供，可先通过同一 registry 安装 `corepack@0.31.0`。公司规定必须走内网源时，将 registry 替换为该源。环境变量或平台附加的 `--registry` 参数可能覆盖项目 `.npmrc`，需要一并检查。

## 重新构建前检查

1. 确认构建拉取了包含本次修复的提交，然后重新构建镜像；仅重建旧镜像的容器不会更新安装配置。
2. 在实际构建节点检查 `pnpm config get registry`（先配置 Corepack 的源再执行），核对报错 URL 的主机，不要打印整个配置或数据库连接串。
3. 同时检查 registry 元数据请求与 tarball 下载域名。镜像可能将文件下载重定向到不同域名；构建节点必须允许最终下载地址的 DNS、HTTPS 和代理访问。
4. 如果新源仍然超时，向平台管理员提供失败步骤、目标域名和错误码，调整构建网络或使用可达的内网制品库。增加重试无法修复持续不可达的网络。
5. 本次仅调整构建配置，不需要数据库迁移，也无需更改 `DATABASE_URL` 或 `DB_MIGRATE_ON_START`。
