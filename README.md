# 仓库到货扫码管理系统

## 系统架构

```
warehouse-system/
├── docker-compose.yml       # Docker 编排文件
├── server/
│   ├── Dockerfile           # Node.js 镜像
│   ├── package.json
│   └── server.js            # Express 后端 API
├── public/
│   ├── index.html           # 入口页（链接员工/管理端）
│   ├── employee.html        # 员工手机端
│   └── admin.html           # 管理电脑端
└── data/                    # ⭐ 运行后自动创建，需要同步的目录
    ├── warehouse.db         # SQLite 数据库
    └── uploads/             # 照片文件
```

---

## 部署方案 A：生产端 / 群晖 NAS（单台）

### 前提
- 群晖 NAS 已安装 **Container Manager**（DSM 7.2+）
- 开启了 SSH 访问

### 步骤

**1. 上传项目文件**

将整个 `warehouse-system` 目录上传到 NAS。
推荐路径：`/volume1/docker/warehouse-system`

可以用群晖 **File Station** 上传，或用 SCP：
```bash
scp -r warehouse-system/ admin@你的NAS地址:/volume1/docker/
```

**2. SSH 进入 NAS 构建并启动**

```bash
ssh admin@你的NAS地址
cd /volume1/docker/warehouse-system
sudo docker compose up -d --build
```

**3. 等待构建完成（首次约 2-5 分钟）**

```bash
# 查看日志确认启动
sudo docker compose logs -f
# 出现 "仓库系统 服务启动于端口 3000" 即成功
```

**4. 访问系统**

- 员工手机（同一局域网）：`http://NAS的IP:3000`
- 管理电脑：`http://NAS的IP:3000/admin.html`

> 查找 NAS IP 地址：群晖控制面板 → 网络 → 网络界面

---

## 部署方案 B：个人 NAS 测试端（192.168.31.89）

用途：把当前项目部署到你另一台个人 NAS 上，作为**测试端**使用。
这样测试环境和生产环境同样都是 NAS Docker，更接近真实运行状态，但测试数据独立存放，不影响生产端。

### 目标环境

- 测试 NAS：`192.168.31.89`
- SSH 账号：`openclawtest`
- NAS 项目目录：`/volume1/docker/ddq-warehouse-system-test`
- 测试端口：`3010`
- 容器名：`warehouse-system-test`
- 测试数据目录：`/volume1/docker/ddq-warehouse-system-test/data-test`

### 访问地址

部署完成后访问：

- 测试端入口：`http://192.168.31.89:3010`
- 员工端：`http://192.168.31.89:3010/employee.html`
- 管理端：`http://192.168.31.89:3010/admin.html`
- 健康检查：`http://192.168.31.89:3010/api/health`

### 和生产端的区别

- 生产端使用：`docker-compose.yml`，通常端口 `3000`，数据目录 `data/`
- 测试端使用：`docker-compose.test-nas.yml`，端口 `3010`，数据目录 `data-test/`
- 测试端不会连接生产端 `data/`，不会写入生产数据库和生产上传目录
- 测试端适合先验收页面、扫码流程、上传目录结构，再决定是否同步到生产端

### 部署测试端

在本地项目目录执行：

```bash
cd /Users/ddqph/Documents/gitee/ddq-warehouse-system-branch
NAS_PASSWORD='你的NAS密码' ./scripts/deploy-nas-test.sh
```

脚本会做这些事：

1. 打包当前项目代码
2. 上传到 NAS 的 `/tmp/ddq-warehouse-system-test.tar.gz`
3. 解压到 `/volume1/docker/ddq-warehouse-system-test`
4. 保留 NAS 上已有的 `data-test/` 测试数据
5. 使用 `docker-compose.test-nas.yml` 重新构建并启动测试容器
   - 这个测试端会复用个人 NAS 上已有的 `warehouse-nasb-warehouse-admin:latest` 镜像作为基础镜像，只覆盖最新 `server.js`，避免每次在 NAS 上重新编译 `better-sqlite3`
6. 检查 `http://192.168.31.89:3010/api/health`

### 查看状态 / 日志

```bash
ssh openclawtest@192.168.31.89
cd /volume1/docker/ddq-warehouse-system-test
/usr/local/bin/docker-compose -f docker-compose.test-nas.yml ps
/usr/local/bin/docker-compose -f docker-compose.test-nas.yml logs --tail=80 -f
```

如果 Docker 需要 sudo，就在 NAS 上改用：

```bash
sudo /usr/local/bin/docker-compose -f docker-compose.test-nas.yml ps
sudo /usr/local/bin/docker-compose -f docker-compose.test-nas.yml logs --tail=80 -f
```

### 停止测试端

```bash
cd /Users/ddqph/Documents/gitee/ddq-warehouse-system-branch
NAS_PASSWORD='你的NAS密码' ./scripts/stop-nas-test.sh
```

### 清空测试数据（谨慎）

只在你想重新开始测试时使用。这个命令只删除测试端 `data-test/`，不碰生产端：

```bash
ssh openclawtest@192.168.31.89
cd /volume1/docker/ddq-warehouse-system-test
/usr/local/bin/docker-compose -f docker-compose.test-nas.yml down
rm -rf data-test
```

---

## ⭐ 两地群晖双 NAS 部署方案

### 你的情况

- 生产端 NAS：运行正式仓库系统，员工日常扫码、拍照、入库都在这里发生。
- 测试端 NAS：用于测试新功能，不允许反向影响生产端数据。
- 已通过 **Synology Drive ShareSync** 建立同步任务：生产端上传到测试端。
- 目标：测试端可以使用接近生产端的真实数据测试，但测试产生的数据可以随时清空，不污染生产端。

### 最终方案：生产快照 → 同步镜像 → 测试沙盒

不要直接同步生产端正在运行的 `data` 目录，也不要让测试系统直接使用同步目录。

最终数据链路如下：

```text
生产端真实运行数据
/volume1/docker/warehouse-system/data

    ↓ 生成一致性快照

生产端同步源目录
/volume1/warehouse-system/data

    ↓ Synology Drive ShareSync 上传到测试端

测试端同步镜像目录
/volume1/warehouse-system-test/data

    ↓ 测试前复制一份

测试端沙盒运行目录
/volume1/docker/ddq-warehouse-system-test/data-test
```

### 三个 data 目录的职责

#### 1. 生产端真实运行目录

```text
/volume1/docker/warehouse-system/data
```

这是正式系统正在使用的数据目录，包含数据库和上传图片。
**不要直接用 Synology Drive 同步这个目录。**

原因：数据库运行中直接同步可能拿到不一致文件，尤其是 SQLite 数据库可能存在 `warehouse.db`、`warehouse.db-wal`、`warehouse.db-shm` 等运行状态文件。

#### 2. 生产端同步源 / 快照目录

```text
/volume1/warehouse-system/data
```

这个目录只保存从生产真实数据生成出来的一致性快照，作为 ShareSync 的上传源。

生产系统本身不读取、不写入这里。
即使这个目录被同步工具改动，也不应该影响生产端真实运行数据。

#### 3. 测试端同步镜像目录

```text
/volume1/warehouse-system-test/data
```

这个目录只接收生产端上传过来的快照数据。
测试系统不要直接挂载、读取或写入这里。

#### 4. 测试端沙盒运行目录

```text
/volume1/docker/ddq-warehouse-system-test/data-test
```

测试系统真正使用这个目录。
测试过程中新增、修改、删除的数据都只发生在这里。

如果测试数据乱了，停止测试容器后清空这个目录，再从同步镜像目录复制一份即可恢复。

### Synology Drive ShareSync 方向

因为是 **生产端 NAS 主动连接测试端 NAS**，ShareSync 方向应选择：

```text
仅将数据上传到远程 Synology Drive 服务器
```

同步关系：

```text
生产端 /volume1/warehouse-system/data
    ↓ 上传
测试端 /volume1/warehouse-system-test/data
```

注意：如果界面有类似选项：

```text
在远程 NAS 上保存已从本地删除的文件
```

一般不要勾选。否则生产端删除、移动、重命名过的图片，测试端可能继续保留旧文件，导致测试镜像只增不减、数据不一致。

### 生产端一致性快照原则

生产端生成快照时，不需要停止正式系统。

数据库如果是 SQLite，不要直接 `cp warehouse.db`，应使用 SQLite backup 机制生成一致性副本，例如：

```bash
sqlite3 /volume1/docker/warehouse-system/data/warehouse.db \
  ".backup '/volume1/warehouse-system/data/warehouse.db'"
```

图片和上传文件可以从生产真实目录同步到快照目录，但要保证快照目录能跟随生产端的删除、移动、重命名保持一致。

推荐思路：

```text
数据库：用 SQLite backup 生成一致快照
图片/uploads：用镜像同步方式同步到快照目录，允许删除目标端多余文件
```

### 测试前重置沙盒流程

每次准备测试时：

1. 停止测试端容器；
2. 清空测试端沙盒目录：
   ```text
   /volume1/docker/ddq-warehouse-system-test/data-test
   ```
3. 从测试端同步镜像目录复制一份到沙盒目录：
   ```text
   /volume1/warehouse-system-test/data
   →
   /volume1/docker/ddq-warehouse-system-test/data-test
   ```
4. 启动测试端容器；
5. 测试系统只使用沙盒目录。

这样可以保证：

- 生产端不需要停机；
- 测试端可以使用生产端快照数据；
- 测试产生的数据不会污染生产端；
- 测试产生的数据也不会污染测试端同步镜像；
- 每次测试前都可以重新复制一份干净沙盒。

### 配置步骤

#### 步骤一：生产端生成快照目录

在生产端准备同步源目录：

```text
/volume1/warehouse-system/data
```

从正式运行目录生成一致性快照：

```text
/volume1/docker/warehouse-system/data
→
/volume1/warehouse-system/data
```

#### 步骤二：配置 Synology Drive ShareSync

在生产端 NAS 创建 ShareSync 任务，连接测试端 NAS。

同步方向选择：

```text
仅将数据上传到远程 Synology Drive 服务器
```

同步路径：

```text
生产端：/volume1/warehouse-system/data
测试端：/volume1/warehouse-system-test/data
```

如果有“在远程 NAS 上保存已从本地删除的文件”选项，默认不要勾选，避免测试端镜像保留生产端已经删除的旧图片。

#### 步骤三：测试端使用沙盒目录运行测试系统

测试系统容器挂载：

```text
/volume1/docker/ddq-warehouse-system-test/data-test
```

不要挂载：

```text
/volume1/warehouse-system-test/data
```

`/volume1/warehouse-system-test/data` 只作为同步镜像目录，不能给测试应用直接使用。

---

## 日常管理

### 查看运行状态
```bash
sudo docker compose ps
sudo docker compose logs --tail=50
```

### 更新系统
```bash
cd /volume1/docker/warehouse-system
git pull  # 或重新上传文件
sudo docker compose up -d --build
```

### 备份数据库
```bash
# 数据已通过 Synology Drive 同步，也可手动备份
cp /volume1/docker/warehouse-system/data/warehouse.db \
   /volume1/backups/warehouse-$(date +%Y%m%d).db
```

### 停止系统
```bash
sudo docker compose down
```

---

## 员工使用说明

### 手机扫码注意事项
- 使用 Chrome（Android）或 Safari（iOS）浏览器
- 首次访问需允许摄像头权限
- 如无法自动扫码，可手动输入箱码

### 三个功能模块
1. **到货扫码**：货到仓库，扫箱子外包装码，登记到货
2. **开箱拍照**：开箱后，扫箱码 + 对每张采购单扫码+拍照
3. **错误记录**：电脑端无法入库时，扫码+拍照+描述问题

---

## 管理端说明

### 错误订单核对
1. 顶部表格显示所有错误记录
2. 点击某条记录 → 底部三栏展开：
   - **左栏**：该错误采购单的照片和详情
   - **中栏**：同一采购单号的所有开箱记录和其他错误记录
   - **右栏**：点击中栏任意记录可预览照片和查看到货/开箱时间
3. 在中栏勾选多条错误记录 → 点击"🔗 关联"可将同一问题归组
4. 左栏底部可更改审核状态和填写备注

---

## 技术信息
- 后端：Node.js + Express + SQLite
- 前端：原生 HTML/CSS/JS（无需构建）
- 扫码：html5-qrcode 库
- 部署：Docker + docker-compose
- 数据存储：`./data/` 目录（数据库 + 照片）
