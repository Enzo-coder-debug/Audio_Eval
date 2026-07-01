# 语音模型对比盲测平台 - 项目 TODO

## 第一阶段：数据库结构调整
- [x] 调整 `audioFiles` 表，添加 `modelName` 和 `asrText` 字段
- [x] 新增 `blindTestPairs` 表，存储随机配对的音频（左边音频ID，右边音频ID，问卷ID）
- [x] 调整 `responses` 表，记录用户姓名和关联 `blindTestPairs`
- [x] 盲测维度通过 `evaluationDimensions` 表定义，`answers` 表记录选择
- [x] 生成数据库迁移 SQL
- [x] 执行数据库迁移

## 第二阶段：后端功能开发
- [x] 实现批量音频上传接口（支持多文件同时上传）
- [x] 集成 ASR 自动转写功能（Whisper API）
- [x] 实现盲测配对生成算法（仅配对不同模型音频，Fisher-Yates 随机打乱顺序，随机分配左右位置）
- [x] 实现盲测结果提交接口（response.startPublic + response.submitPublic）

## 第三阶段：前端重构
- [x] 重构管理员音频上传页面（支持批量上传、指定模型名称、显示ASR转写结果）
- [x] 重构用户盲测页面（进度条、左右音频对比播放、维度评分按钮、姓名输入）
- [x] 适配统计分析页面（得分分布、完成率、答卷详情）

## 第四阶段：测试与优化
- [x] 功能测试（19个单元测试全部通过，TypeScript 0错误）
- [x] 安全性检查（Manus OAuth 管理员认证、匿名答题 IP 记录）
- [x] 管理员进展查看（5秒自动刷新答题进展）
- [x] 最终交付

## Bug 修复
- [x] 修复问卷无法发布的问题（AdminQuestionnaireDetail 页面缺少发布按钮）

## 可选增强功能
- [ ] 实现主观评价 AI 文本分析功能（LLM 集成分析主观题答案）
- [ ] 答题频控防护（限制同一IP重复提交）
- [ ] 分页查询优化（大量答卷时的性能优化）
