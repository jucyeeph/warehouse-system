# 生产端快照同步脚本

用于两地群晖双 NAS 测试数据同步。

## 目标

生产端真实运行数据：

```text
/volume1/docker/warehouse-system/data
```

定时生成一致性快照到 ShareSync 同步源：

```text
/volume1/warehouse-system/data
```

ShareSync 再把该目录同步到测试端 NAS。

## 已落地的生产端路径

```text
/volume1/docker/warehouse-system-snapshot-tools/create-snapshot.sh
/volume1/docker/warehouse-system-snapshot-tools/run-snapshot-cron.sh
/volume1/docker/warehouse-system-snapshot-tools/latest-snapshot-meta.json
/volume1/docker/warehouse-system-snapshot-tools/logs/
```

同步文件夹保持清爽，只包含：

```text
/volume1/warehouse-system/data/warehouse.db
/volume1/warehouse-system/data/uploads/
```

## 定时任务

生产 NAS `/etc/crontab` 中添加：

```cron
# OPENCLAW warehouse-system snapshot BEGIN
*/15 * * * * ddqph /volume1/docker/warehouse-system-snapshot-tools/run-snapshot-cron.sh
# OPENCLAW warehouse-system snapshot END
```

含义：每 15 分钟生成一次快照。生产端不需要停机。

## 安全原则

- 脚本只读取 `/volume1/docker/warehouse-system/data`。
- 脚本只写入 `/volume1/warehouse-system/data` 和工具日志目录。
- SQLite 数据库使用 `.backup`，不直接复制运行中的 `warehouse.db`。
- `uploads/` 使用 `rsync --delete`，保证删除/移动/重命名也能反映到快照目录。
- 不提交 SSH 密码、`.env` 或个人桌面一键文件。

## 手动执行

在生产 NAS 上执行：

```bash
/volume1/docker/warehouse-system-snapshot-tools/run-snapshot-cron.sh
```

或直接执行：

```bash
/volume1/docker/warehouse-system-snapshot-tools/create-snapshot.sh
```

## 恢复/重新部署参考

```bash
mkdir -p /volume1/docker/warehouse-system-snapshot-tools/logs
cp scripts/nas/create-production-snapshot.sh \
  /volume1/docker/warehouse-system-snapshot-tools/create-snapshot.sh
cp scripts/nas/run-production-snapshot-cron.sh \
  /volume1/docker/warehouse-system-snapshot-tools/run-snapshot-cron.sh
chmod +x /volume1/docker/warehouse-system-snapshot-tools/*.sh
```

## 测试端沙盒重置

测试端 ShareSync 镜像目录：

```text
/volume1/warehouse-system-test/data
```

测试项目当前 `docker-compose.test-nas.yml` 实际挂载，且统一作为测试沙盒目录：

```text
/volume1/docker/ddq-warehouse-system-test/data-test
```

测试前重置沙盒脚本：

```text
/volume1/docker/ddq-warehouse-system-test/sandbox-tools/reset-test-sandbox.sh
```

脚本逻辑：

1. 检查 `/volume1/warehouse-system-test/data/warehouse.db` 完整性；
2. 自动备份旧沙盒到：
   ```text
   /volume1/docker/ddq-warehouse-system-test/backups/sandbox-reset/
   ```
3. 清空并重建：
   ```text
   /volume1/docker/ddq-warehouse-system-test/data-test
   ```
4. 从同步镜像复制最新数据；
5. 删除测试端 SQLite 运行临时文件 `warehouse.db-wal`、`warehouse.db-shm`；
6. 再次检查沙盒数据库完整性。

手动执行：

```bash
/volume1/docker/ddq-warehouse-system-test/sandbox-tools/reset-test-sandbox.sh
```

恢复/重新部署参考：

```bash
mkdir -p /volume1/docker/ddq-warehouse-system-test/sandbox-tools/logs
cp scripts/nas/reset-test-sandbox.sh \
  /volume1/docker/ddq-warehouse-system-test/sandbox-tools/reset-test-sandbox.sh
chmod +x /volume1/docker/ddq-warehouse-system-test/sandbox-tools/reset-test-sandbox.sh
```
