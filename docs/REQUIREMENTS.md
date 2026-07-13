# 需求文档（Requirements）

> 音频盲测评估平台 —— 产品目标、角色、功能、数据模型与业务规则。

## 1. 产品目标

为语音/TTS 模型效果评估提供一套 **盲测对比** 工具：同一段文案由多个模型合成音频，评审人在不知晓模型身份的情况下逐对比较，系统据此统计各模型胜率与显著性，输出客观的优劣结论。

## 2. 角色

| 角色 | 说明 | 认证方式 |
| --- | --- | --- |
| 管理员（admin） | 创建问卷、上传音频、配置组别、生成配对、发布/复制问卷、查看统计 | 账号密码登录 |
| 答卷人（评审人） | 通过分享链接打分，无需注册 | 免登录（仅填姓名） |
| 登录用户（user） | 保留的登录答题流（次要场景） | JWT 登录 |

## 3. 核心功能

### 3.1 创建盲测问卷（管理员）
- 填写问卷名称、评测文案（evaluationCopywriting）、评分标准（scoringStandard）。
- 批量上传音频，每个音频指定 **模型名（modelName）** 和可选 **组别（groupLabel）**。
- 支持格式：audio/mpeg、audio/wav、audio/mp4。
- 系统据评分标准文本自动解析 **评分维度**（解析失败回退为「整体效果」）。

### 3.2 音频与组别管理（管理员）
- 向已有问卷新增/移除音频。
- 批量设置音频组别（同一 query/文案归为一组）。
- 手动「生成盲测配对」：**同组内不同模型两两配对**，同模型不比较，空组别不参与。
- 上传/增删/改组别均 **不自动配对**，需管理员显式触发生成。

### 3.3 盲测配对规则
- 分组：按 `groupLabel` 归组。
- 配对：组内不同 `modelName` 两两组合。
- 消除偏见：随机左右位置 + Fisher-Yates 打乱整体展示顺序。
- 重建配对会 **清空该问卷旧作答与旧配对**（旧答案已失去意义）。

### 3.4 发布与分享
- 问卷状态：`draft` / `published` / `offline`。
- 发布时自动生成唯一 `shareToken`，形成免登录链接 `/q/:shareToken`。
- 可设置有效期（validFrom / validUntil）。

### 3.5 答题（答卷人，免登录）
- 打开分享链接，填写姓名开始作答。
- 对每一对音频（左/右）分维度选择：**左更好 / 一样 / 右更好**。
- 提交后记录 visitorName 与 visitorIp。
- 有效期外或未发布的问卷无法作答。

### 3.6 统计分析（管理员）
- **问卷统计**：答卷数、平均/最高/最低分、完成率。
- **盲测聚合**：按「模型对比 × 评分维度」聚合所有判断，计算：
  - win / tie / loss 计数与占比；
  - **GSB 分数** = (aWins - bWins) / total，范围 [-1, 1]；
  - **Wilson 95% 置信区间**（决定性对比，剔除平局）；
  - **双侧二项检验 p 值**（原假设 p=0.5），`p < 0.05` 判显著；
  - 显著时给出 winner 模型。
- 模型对比按字典序规范化（modelA < modelB），消除左右差异。

### 3.7 复制问卷（管理员）
- 一键复制：问卷基本信息、音频记录（共享 OSS 对象）、评分维度，并按组别重建盲测配对。
- 副本为 draft 状态、shareToken 置空（避免唯一约束冲突）。

### 3.8 AI 辅助（保留能力）
- `generateQuestions`：据文案与评分标准自动生成单选/多选/主观题（次要场景）。
- 主观题 AI 评分 + 客观题自动判分 + 整体 AI 评语。

## 4. 数据模型（关键表）

| 表 | 用途 | 关键字段 |
| --- | --- | --- |
| `users` | 用户/管理员 | openId、role(user\|admin) |
| `questionnaires` | 问卷 | title、status、shareToken、evaluationCopywriting、scoringStandard、validFrom/Until |
| `audioFiles` | 音频 | fileKey、fileUrl、modelName、groupLabel、questionnaireId |
| `blindTestPairs` | 盲测配对 | leftAudioFileId、rightAudioFileId、pairIndex |
| `evaluationDimensions` | 评分维度 | dimensionName、weight、maxScore |
| `responses` | 答卷 | visitorName、visitorIp、status |
| `answers` | 单条作答 | blindTestPairId、evaluationDimensionId、blindTestChoice |
| `questions` / `questionnaireStats` | AI 题目 / 缓存统计 | — |

## 5. 业务规则汇总

1. 仅 **同组、不同模型** 的音频才配对；同模型、空组别不参与。
2. 配对左右位置随机、展示顺序打乱，保证盲测公正性。
3. 音频/组别变更后必须重新「生成配对」，且会清空旧作答。
4. 答卷人免登录，问卷须为 `published` 且在有效期内方可作答。
5. 统计仅对非平局的「决定性对比」做显著性检验。
6. 复制问卷共享 OSS 对象（不重复上传），副本独立于原问卷。
7. DB 只存音频 key/url，实体文件在 OSS；生产容器走 OSS 内网 endpoint。

## 6. 非功能性需求

- **性能**：多音频上传并行化（Promise.all），OSS key 按日期时间戳归档避免同前缀堆积。
- **安全**：管理端接口 `adminProcedure` 门控；答卷链接仅暴露音频与维度，不泄露模型名。
- **可移植**：脱离 Manus 平台，用京东云 OSS + 账密登录独立部署（JDOS，端口 8080）。
- **可测试**：vitest 覆盖 auth/questionnaire/public-questionnaire 关键路径。

## 7. 典型使用流程

```
管理员登录 → 新建问卷（填文案/评分标准，批量传音频+模型名）
→ 设置组别 → 生成盲测配对 → 发布得到分享链接
→ 分发链接给评审人 → 评审人免登录逐对打分
→ 管理员查看 Analytics（GSB + Wilson + 显著性）→ 得出模型优劣结论
（可复制问卷用于下一轮评测）
```