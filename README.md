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
- 甲地（仓库）：群晖 NAS-A
- 乙地（办公室）：群晖 NAS-B
- 已有 **Synology Drive** 进行文件同步

### 推荐方案：主从模式

**应用只运行在 NAS-A（仓库）**，数据通过 Synology Drive 同步到 NAS-B，
你在办公室通过外网访问 NAS-A 的管理端。

```
仓库员工 (手机)
    │
    ↓ 局域网
NAS-A (仓库) ← 运行 Docker 应用
    │
    │ Synology Drive Sync 同步 /data 目录
    ↓
NAS-B (办公室) ← 备份数据，无需运行应用
    │
    ↑ 你通过浏览器访问
    你 (办公室电脑)
```

### 配置步骤

#### 步骤一：在 NAS-A（仓库）部署应用

同上述"单台部署"步骤。

#### 步骤二：配置 Synology Drive 同步

在 NAS-A 的 **Synology Drive Admin Console** 中：

1. 创建同步任务，**将以下目录同步到 NAS-B**：
   ```
   /volume1/docker/warehouse-system/data
   ```
2. 同步方向：**NAS-A → NAS-B（单向同步）**
3. 同步频率：实时或每5分钟
4. 这样数据库和照片都会备份到 NAS-B

#### 步骤三：配置外网访问 NAS-A

有两种方案，推荐方案 A：

**方案 A：Synology QuickConnect（最简单）**

1. 群晖控制面板 → QuickConnect → 启用
2. 记下你的 QuickConnect ID，如 `mywarehouse`
3. 在群晖 **应用程序门户** 中为端口 3000 添加反向代理：
   - 控制面板 → 登录门户 → 高级 → 反向代理
   - 新增：
     - 来源协议：HTTPS，主机名：`warehouse.quickconnect.to`
     - 目标：`localhost:3000`
4. 办公室访问地址：`https://你的QuickConnect.quickconnect.to:443`（或设置子域名）

**方案 B：路由器端口转发**

1. 在仓库路由器上将外网端口（如 13000）转发到 NAS-A:3000
2. 访问地址：`http://仓库公网IP:13000`
3. 推荐搭配 DDNS（群晖控制面板 → 外部访问 → DDNS）

#### 步骤四：HTTPS 配置（重要！手机扫码需要）

手机摄像头扫码需要 HTTPS。在群晖 **安全证书** 中：

1. 控制面板 → 安全性 → 证书
2. 使用 **Let's Encrypt** 申请免费证书（需要有域名）
3. 或购买域名 + 申请证书

> 如果只在局域网使用，HTTP 也可以（Android 正常，iPhone 需 HTTPS）

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
