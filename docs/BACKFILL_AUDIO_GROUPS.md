# 历史音频补齐组别

新版本在新建和追加上传时默认使用文件名（去掉最后一个扩展名）作为组别；管理员仍可手动修改或清空。组别推导只读取文件名，不调用语音识别服务。

## 页面操作

发布新版本后，打开目标问卷 → 音频管理 → 按文件名补齐空组别。先保存表格中的未保存修改，再确认补齐。操作仅处理空组别，保留人工设置、参考音频、配对、答卷与评分维度。补齐后按需核查情绪指标的组别配置；不要在已有答卷时未经确认就重建配对。

## 容器定向修复

本机连接生产库失败时，不代表服务数据库不可用。可在实际目标环境的 `/opt/app` 下执行；不要将预发和生产连接串混用。

需要当前版本的 `scripts/backfill-audio-group-labels.mjs`、`shared/audioGroupLabels.ts` 和项目依赖 `mysql2`、`tsx`。无需数据库表结构迁移。脚本不自动读取 `.env`，避免 WebShell 用户读取配置文件权限不足的问题。

在 Bash 中单独执行，然后在提示后输入完整目标环境连接串（不回显，不把密钥写入命令历史）：

```bash
IFS= read -r -s -p 'DATABASE_URL（不回显）: ' DATABASE_URL && export DATABASE_URL; printf '\n'
```

先预览，核对问卷 ID、完整名称、音频数量和前 10 个推导结果：

```bash
cd /opt/app
/usr/local/node-v20.19.0/bin/node --import tsx scripts/backfill-audio-group-labels.mjs \
  --title '金刚I、II型机器人情绪测评问卷' --expected-count 800
```

确认目标库和样例无误后，同一终端显式执行写入：

```bash
/usr/local/node-v20.19.0/bin/node --import tsx scripts/backfill-audio-group-labels.mjs \
  --title '金刚I、II型机器人情绪测评问卷' --expected-count 800 --apply
```

再次执行预览，待补齐数量应为 0，最后 `unset DATABASE_URL`。刷新页面核查组别，无需重新上传音频。

脚本要求完整标题唯一匹配、测评音频数恰为 800（不含参考音频），不满足则停止，不猜测目标问卷。重复执行仅处理仍为空的组别；已有组别不覆盖。写入在事务中执行，失败整体回滚。若出现失败，不要跳过检查或自动重建配对，应核查日志和权限。
