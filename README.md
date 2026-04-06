# Team Time

移动端优先的团队排期 Web 应用，现已包含：

- 前端（`index.html + app.js + styles.css`）
- 后端 API（`server.js`）
- SQLite 数据库（`data/team-time.db`，自动创建）

## 主要能力

- 创建团队 / 加入团队（口令制）
- 成员可用时段标记（30 分钟粒度）
- 热力图与最佳连续时段推荐
- 成员补录（写入数据库）
- 导出 `.ics` 日历文件

## 本地运行

```bash
node server.js
```

建议 Node.js 版本：`v24+`（需要内置 `node:sqlite`）。

默认访问：

- Web: `http://localhost:4173`
- 健康检查: `http://localhost:4173/api/health`

## 数据库说明

- 使用 Node 内置 `node:sqlite`（SQLite 文件数据库）
- 数据文件路径：`data/team-time.db`
- 表结构：`teams`、`members`、`availabilities`
