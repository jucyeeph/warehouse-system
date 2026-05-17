# NAS-B（办公室端）部署指南

## 第一步：确认 Synology Drive 同步路径

1. 在 NAS-A（仓库）的 **Synology Drive Admin Console** 中，新建同步任务：
   - 来源目录：`/volume1/docker/warehouse-system/data`
   - 同步方式：**双向同步**（让你在 NAS-B 的审核操作能同步回 NAS-A）
   - 同步到 NAS-B 的路径（自定，建议）：`warehouse-data`

2. 在 NAS-B 上，打开 File Station，找到 Drive 同步文件夹。
   - 一般在：`/volume1/homes/admin/Drive/warehouse-data/`
   - 或者在：`/volume1/Synology Drive/warehouse-data/`
   - **记下这个完整路径**，下一步要用到。

---

## 第二步：在 NAS-B 上创建部署目录

1. 在 NAS-B 的 File Station 中，创建目录：
   `/volume1/docker/warehouse-nasb/`

2. 在这个目录下创建子目录：
   - `server/`
   - `public/`

3. 将以下文件上传到对应目录（和 NAS-A 上的文件完全一样）：
   - `server/Dockerfile`
   - `server/package.json`
   - `server/server.js`
   - `public/index.html`
   - `public/employee.html`
   - `public/admin.html`

4. 将 `docker-compose.nasb.yml` 上传到 `/volume1/docker/warehouse-nasb/`，
   **重命名为 `docker-compose.yml`**。

---

## 第三步：修改 docker-compose.yml 中的 data 路径

用文本编辑器（或群晖的 Text Editor 套件）打开 `docker-compose.yml`，
找到这一行：

```
- /volume1/homes/admin/Drive/warehouse-data:/data
```

把 `/volume1/homes/admin/Drive/warehouse-data` 改成你在第一步记下的实际路径。

---

## 第四步：SSH 进 NAS-B 启动容器

```bash
ssh admin@NAS-B的IP地址
cd /volume1/docker/warehouse-nasb
sudo docker compose up -d --build
```

首次构建约 2-5 分钟。

---

## 第五步：验证

浏览器访问：`http://NAS-B的IP:3001/admin.html`

如果看到数据，说明读取同步目录成功。

---

## 日常使用流程

```
早上开始工作
    ↓
打开 http://NAS-B的IP:3001/admin.html
    ↓
等 1 分钟让 Drive 同步最新数据（或在 Drive 里手动触发同步）
    ↓
正常审核、关联错误单、查找箱子
    ↓
你的操作会写入 NAS-B 的 data/warehouse.db
    ↓
Drive 自动同步回 NAS-A（约 1-5 分钟）
    ↓
仓库员工的系统也能看到最新审核状态
```

---

## 常见问题

**Q：NAS-B 看不到最新到货记录？**
A：Drive 同步有延迟，等 1-5 分钟，或在群晖 Drive 界面手动点"立即同步"。

**Q：我在 NAS-B 改了审核状态，NAS-A 的员工端看不到？**
A：同上，等 Drive 同步回去即可。员工端看状态一般不是实时需求。

**Q：两边同时操作会不会数据丢失？**
A：极低风险。NAS-A 只有员工在工作时间提交，NAS-B 只有你在审核。
   只要避免在仓库员工密集提交时（比如刚卸完货扫码的那几分钟）同时进行大量审核操作，
   实际使用中基本不会出现冲突。

**Q：Drive 同步的是整个 data 目录，照片文件会不会太大？**
A：会随着使用增长。建议每月在 Drive 设置中检查同步大小，
   日常每张照片约 1-3MB，100 箱/月大概同步 200-600MB。
