# friends-and-sponsors

SVAF 的友链和赞助数据源。

## 申请友链

通过仓库的 **申请友链 Issue Form** 提交。网站、头像、重复条目及双向链接均在 Issue 阶段审核；未通过不会创建数据分支或 PR。

信息有误时编辑原 Issue 正文；站外内容修复后在 Issue 回复 `重新检查`。只允许申请人或有写权限的维护者发起重检。状态评论会原地更新。

全部通过后，独立执行任务才生成限定字段的 `data/friends/issue-<编号>.json`，创建执行 PR 并绑定审核后的提交 SHA 合并；成功后关闭 Issue。PR 是执行记录，不再提供独立审核接口。

**旧的手动 PR 自动审核已停用**：不再监听 `pull_request_target`，PR 下的 `准备完毕` 或 `重新检查` 不会触发审核/合并。GitHub 本身仍允许手动提 PR，维护者可人工处理。已存在的 PR 不会自动关闭或接管。已有友链的修改/删除、赞助数据及 VIP 标记均由维护者管理，不能用新增申请覆盖。

## 自动化边界

- `issue-to-pr.yml` 的 `review` 任务只有 `contents: read` / `issues: write`，不使用 PAT。检查器在独立子进程运行，不继承令牌；HTTP(S) 请求和重定向会检查公开地址，阻止内网目标及非只读请求。
- 输入通过固定表单字段及长度/类型校验，生成新的字段白名单对象，不执行用户文本，不接收任意 JSON、路径、分支、VIP 或工作流字段。
- `execute` 是独立 runner，只消费同一运行的审核输出，不访问申请网站、不执行 PR 代码。创建树以可信主分支为基底，只能新增单个指定 JSON；合并前检查 Issue 快照、主分支版本、PR 来源、差异及文件字节，merge API 显式绑定 head SHA。
- 为保留现有外部部署联动，PAT 只在执行步骤使用；没有 PAT 时退回 GITHUB_TOKEN，此时仓库需要允许 Actions 创建 PR。分支保护仍由 GitHub 执行，不做绕过。若主分支在审核期间变化，执行会停止并要求重新检查。
- Issue 不是天然可信数据；这些边界减少注入和误合并风险，不等于替代浏览器安全更新、网络隔离或仓库权限治理。

## 测试

`npm test` 运行输入、权限、二次审核、快照失效、PR 篡改及网络地址防护回归。`npm run build` 验证数据构建。

## 目录结构

```
data/friends/        — 友链条目（每文件一条）
data/sponsors/       — 赞助条目（每文件一条）
scripts/build.js     — 构建脚本
wrangler.jsonc       — Cloudflare Pages 配置
```

## 构建

`node scripts/build.js` 会扫描 `data/` 下所有 JSON 文件，校验并排序后输出 `dist/friends.json` 和 `dist/sponsors.json`。

## 部署

连接 Cloudflare Pages，配置：
- 构建命令：`node scripts/build.js`
- 输出目录：`dist`

访问 `https://<project>.pages.dev/friends.json` 和 `https://<project>.pages.dev/sponsors.json`。

## 数据格式

### 友链

```json
{
  "name": "站点名",
  "avatar": "头像 URL 或 null",
  "description": "简介（可选）",
  "url": "站点 URL",
  "vip": true,
  "backlink": "友链页 URL（可选）"
}
```

### 赞助

```json
{
  "name": "赞助者名",
  "avatar": "头像 URL 或 null",
  "date": "2025-08-02",
  "amount": "100 ￥"
}
```

`vip` 仅供维护者使用。存量数据格式允许 `avatar: null`，新增 Issue 申请则要求可访问的图片直链和有效的 `backlink`。
