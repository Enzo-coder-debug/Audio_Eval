# 脚手架文档（Architecture）

> 音频盲测评估平台（audio_evaluation_platform）—— 技术栈、目录结构、分层设计、开发与部署流程。

## 1. 项目概述

一个面向语音/TTS 模型效果评估的 **盲测对比平台**。管理员批量上传多个模型对同一段文案（query）的合成音频，系统按「组别 + 模型」自动两两配对；答卷人通过免登录分享链接对每一对音频做「左更好 / 一样 / 右更好」的主观打分；后台用 Wilson 置信区间 + 双侧二项检验做显著性统计，给出模型优劣结论（GSB）。

## 2. 技术栈

| 层次 | 技术 |
| --- | --- |
| 前端框架 | React 19 + TypeScript 5.9 |
| 客户端路由 | wouter 3 |
| UI 组件 | shadcn/ui + Radix UI +lucide-react |
| 图表 | recharts 2 |
| 动画 | framer-motion 12 |
| 表单/校验 | react-hook-form 7 + zod 4 |
| 构建工具 | Vite 7 + esbuild |
| 样式 | Tailwind CSS 4 |
| 后端框架 | Express 4 |
| API 层 | tRPC 11（Superjson 序列化） |
| ORM | Drizzle ORM 0.44 + drizzle-kit |
| 数据库 | MySQL（mysql2 驱动） |
| 对象存储 | 京东云 OSS（@aws-sdk/client-s3，S3 兼容） |
| 认证 | JWT session cookie（jose） |
| AI 能力 | invokeLLM（问卷生成 / 主观题评分） |
| 包管理 | pnpm 10.4.1（Node >= 20） |
| 测试 | vitest 2 |

基础模板：Manus Web App Template（`server/_core`、`client/src/_core` 为框架层，勿改）。

## 3. 目录结构

```
audio_evaluation_platform/
├── client/                     # 前端
│   └── src/
│       ├── App.tsx             # wouter 路由入口（按 role 分流）
│       ├── pages/              # 页面（见下表）
│       ├── components/         # 业务组件 + ui/（shadcn）
│       ├── contexts/           # ThemeContext 等
│       ├── hooks/              # 通用 hooks
│       ├── lib/trpc.ts         # tRPC 客户端
│       └── _core/              # 框架层（勿改）
├── server/                     # 后端
│   ├── routers.ts              # tRPC 业务路由（核心，1398 行）
│   ├── db.ts                   # Drizzle 查询 helper
│   ├── storage.ts              # OSS/本地存储助手
│   └── _core/                  # 框架层（trpc/adminAuth/llm/oauth 等，勿改）
├── drizzle/                    # schema.ts + 迁(0000~0006) + meta 快照
├── shared/                     # 前后端共享常量/类型
├── scripts/                    # 部署辅助（迁移、SSH 隧道）
├── docs/                       # 本文档目录
├── Dockerfile / start.sh       # 容器化与启动
└── .env.production             # 生产环境变量（不入库）
```

## 4. 前端页面路由

| 路由 | 页面 | 角色 |
| --- | --- | --- |
| `/` | Home | 公共 |
| `/q/:shareToken` | PublicQuestionnaire（免登录答题） | 公共 |
| `/admin/login` | AdminLogin（账密登录） | 公共 |
| `/admin/dashboard` | AdminDashboard（问卷列表/新建） | admin |
| `/admin/questionnaire/:id` | AdminQuestionnaireDetail（音频/组别/配对管理） | admin |
| `/admin/questionnaire/:id/analytics` | QuestionnaireAnalytics（盲测统计） | admin |
| `/user/*` | UserDashboard 等（登录用户答题流） | user |

## 5. 后端 API（tRPC 路由分组）

- `auth`：me / logout
- `audio`：upload（建问卷+并行上传）、addToQuestionnaire、removeFromQuestionnaire、updateGroupLabels、generatePairs（重建配对）、list/get/listByQuestionnaire
- `questionnaire`：generateQuestions（AI 出题）、get、listAdmin、listPublished、getByShareToken（公开）、update（发布/下线/生成 shareToken）、delete、duplicate（复制问卷）
- `dimension`：评分维度 CRUD
- `response`：startPublic/start、submitPublic/submit、get、listUser、listQuestionnaire
- `stats`：get（问卷统计）、aggregate（盲测聚合 + Wilson/二项检验显著性）

权限门控：`publicProcedure` / `protectedProcedure` / `adminProcedure`（`users.role = admin`）。

## 6. 核心业务逻辑（server/routers.ts）

- `buildBlindTestPairs`：按 `groupLabel` 分组 → 组内不同 `modelName` 两两配对 → 随机左右消除位置偏见 → Fisher-Yates 打乱顺序。空组别不参与。
- `rebuildQuestionnairePairs`：重建配对前清空旧作答与旧配对（避免答案指向已删配对）。
- `parseScoringStandardToDimensions`：从自由文本「评分标准」解析评分维度，无有效项回退「整体效果」。
- 统计：`wilsonInterval`（Wilson 置信区间）、`twoSidedBinomialTest`（双侧项检验 p 值）、GSB = (aWins - bWins) / total。

## 7. 数据模型（drizzle/schema.ts）

`users`、`audioFiles`（含 questionnaireId/groupLabel/modelName）、`questionnaires`（含 shareToken/status/有效期）、`blindTestPairs`（left/right/pairIndex）、`questions`、`responses`（支持匿名 visitorName/visitorIp）、`answers`（blindTestChoice: left_better|same|right_better）、`evaluationDimensions`、`questionnaireStats`。

## 8. 存储范式（server/storage.ts）

- 开发环境（NODE_ENV=development）：本地磁盘 `.local-storage`。
- 生产：京东云 OSS（S3 兼容 PutObject，`forcePathStyle` 默认 true 走内网 endpoint）。
- key 规则：`audio/<userId>/<YYYYMMDD>/<HHmmss>-<epochMs>-<文件名>`（按日期时间戳归档，避免同前缀堆积）。
- DB 仅存 fileKey / fileUrl，禁止 BLOB；下载走预签名 URL。

## 9. 认证机制

- 答卷人：免登录，走 `/q/:shareToken`，仅填姓名。
- 管理员：`POST /api/admin/login`（`ADMIN_USERNAME`/`ADMIN_PASSWORD`），成功后 upsert role=admin 并下发 JWT cookie（有效期 1 年）。

## 10. 环境变量（生产，不入库）

`DATABASE_URL`、`JWT_SECRET`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`ADMIN_OPEN_ID`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_SECRET_ACCESS_KEY`、`OSS_REGION`、`OSS_ENDPOINT`（内网）、`OSS_FORCE_PATH_STYLE`、`BUILT_IN_FORGE_API_KEY`（LLM）。

## 11. 本地开发流程

```bash
pnpm install
# 配置本地 MySQL 与 .env（DATABASE_URL）
pnpm db:push          # drizzle-kit generate && migrate
pnpm dev              # tsx watch，前后端一体
pnpm check            # tsc --noEmit 类型检查
pnpm test             # vitest
```

开发循环：改 `schema.ts` → `db:push` → 加 `db.ts` helper → 扩 `routers.ts` procedure → 前端 `trpc.*` hooks 消费。

## 12. 构建与部署（京东云 JDOS）

```bash
pnpm build            # vite build + esbuild 打包 server 到 dist/
pnpm start            # PORT=8080 node dist/index.js
```

- 平台强约束：仅监听 **8080** 端口。
- 环境变量在 JDOS 控制台注入，**修改后需重建 Pod 才生效**（`.env` 不入库）。
- 数据库迁移：`scripts/apply-0006-migration.mjs`；本机连京东云 RDS 需经跳板机 SSH 隧道（见 `scripts/ssh-tunnel.exp`）。
- OSS 在容器内须用 **内网 endpoint**（公网 endpoint 会 ETIMEDOUT）。