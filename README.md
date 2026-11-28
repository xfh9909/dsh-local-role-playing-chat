# 角色扮演模式 · dsh-roleplay

把角色扮演聊天伴侣收进 DeepSeek Harness（下称 DSH）的一个插件：左侧导航多一行
「角色扮演」，点开在主区域进入角色扮演界面；点标题栏最右的「回到对话」（或左侧点任意会话）
回到 DSH 对话。两套数据互不相干。

## 里面是什么

- **一个入口**：`sidebar.panellist` 里的「角色扮演」，排在「插件」「自动化任务」后面（order 40）。
  新装的条目按 DSH 的规则先收在侧栏的「更多」菜单里——第一次打开它时点旁边的图钉，
  它就会固定在左侧导航里，之后一直可见；折叠成窄轨时显示面具图标，悬停出名字。
- **一个面板**：`main` 键槽里的 `roleplay`，整块主区域装一个同源 iframe，加载 `/rp/`。
- **两条服务端路由**：
  - `/rp/`：角色扮演应用本体（`static/` 里的构建产物，`index.html` 会在返回时注入适配层 `boot.js`）；
  - `/rp/api/*`：`status` / `chat`（SSE 透传）/ `migrate`（旧数据暂存）/ `settings` / `backup`。
- **一套隔离存储**：适配层把 `localStorage` 的键统一加 `rp_` 前缀，把 IndexedDB 的
  `dsh_chat_db` 改名成 `rp_chat_db`。DSH 自己的会话数据一个字节都碰不到。
- **面板固定深色**：不管 DSH 现在是亮是暗，面板里一直是应用的暗色配色；字体仍跟随宿主。

## 装

```powershell
# 在 DSH 里：插件 → 添加插件 → 选这个目录
# 或者让 agent 用 plugin_manager 的 install_bundle 装
```

装完**完全退出桌面端再启动**（插件注册的路由与客户端 bundle 都在启动时装配）。
装之前在跑着的页面也能用：宿主路由是热注册的，客户端那一半可由页面的模块同步接上。

## 维护与发布

仓库是独立的 git 仓库，`main` 分支 + 语义化标签（`v1.0.0`）。
`node scripts/check.mjs` 是出厂门，`node --test test/api.test.mjs test/static.test.mjs` 是回归。

推到 GitHub（先在网页上建一个**空仓库**，不要勾 README / .gitignore / license）：

```powershell
./scripts/publish.ps1 -Remote <owner>/<repo>
```

脚本会把 `origin` 指过去，推 `main` 和全部标签。默认分支记得设成 `main`，
`.github/workflows/ci.yml` 会在 Ubuntu / Windows + Node 20/22 上跑校验与测试。

**HTTPS 443 不通的时候**（国内常见，表现为 `Recv failure: Connection was reset`
而 `api.github.com` 还能访问）：git 协议走不了，但 REST API 能。用
`git credential fill` 取出现有凭据，再走 Git Data API 建 commit：
`_tools/push-api.mjs` 与 `_tools/sync-local-sha.mjs` 就是干这个的（不随仓库发布）。
注意 API 侧建的 commit 是 GitHub 自己署名的，本地那个等价 commit 的 sha 会对不上，
网络恢复后执行 `git fetch origin && git reset --hard origin/main` 对齐即可——内容完全一致。

应用本体更新后同步产物：

```powershell
node scripts/sync-static.mjs --app <应用仓库路径> --build
git add static && git commit -m "同步应用构建产物"
```


## 数据从旧版本搬过来

旧版角色扮演应用有两个入口（`file://` 双击 index.html、或启动器选 [1] 的
`http://127.0.0.1:5180`），它们的浏览器存储和插件里的 `/rp/` 是三个独立抽屉。
三条路，任选：

1. **自动桥（推荐）**：在**旧页面**地址后面加 `#migrate=<DSH 端口>`，例如
   `http://127.0.0.1:5180/#migrate=52210` 或 `file:///.../migrate.html#migrate=52210`。
   页面会把本机数据推到 `/rp/api/migrate` 暂存；之后打开插件的「角色扮演」，
   应用发现本地是空库就自动取回导入。发送端两个路由都会试
   （`/rp/api/migrate` 优先，再 `/api/migrate`），所以同一套页面既能推给插件也能推给自带服务。
2. **手动导出/导入**：旧页面「⚙️ 设置 → ⬇ 导出全部数据」得到 JSON，插件页面「⚙️ 设置 →
   ⬆ 从备份恢复」。
3. **服务端备份**：`POST /rp/api/backup` 把页面数据另存到 `data/backups/`，随时可回。

迁移前先备份、迁移幂等（重复导入结果一致）——这是应用原本 `exportAll`/`importAll` 的行为。

## Key 放哪

优先级：**页面上填的** > **插件 `data/settings.json` 的 `keys`** > **环境变量**
（`DEEPSEEK_API_KEY`、`KIMI_API_KEY`、`GLM_API_KEY`、`RELAY88_API_KEY`、`XIN_API_KEY`、`CUSTOM_API_KEY`）。

服务端 Key 用这条写（端口换成你现在这个面板的端口）：

```powershell
curl.exe -X POST http://127.0.0.1:52210/rp/api/settings `
  -H "content-type: application/json" `
  -H "origin: http://127.0.0.1:52210" `
  -d '{\"keys\":{\"deepseek\":\"sk-...\"}}'
```

> 所有 `/rp/api/*` 路由只认同源请求：浏览器自己就会带对来源，命令行要手动补 `origin`，
> 端口写错会拿到 403。这样本机别的程序没法借插件里存的 Key 发请求。

`GET /rp/api/settings` 只回掩码，不回明文。

## 改应用本身

应用在另一个仓库（零框架、esbuild）。插件只放构建产物：

```powershell
node scripts/sync-static.mjs --app <应用仓库路径> --build
```

`static/boot.js` 是**插件自己写的适配层**，同步不会覆盖它；`index.html` 里的
`<script src="/rp/boot.js">` 是服务端注入的，构建产物本身保持干净。

## 排查

- 面板空白：先直接开 `http://127.0.0.1:<端口>/rp/`，看是路由没注册还是应用报错。
- `/rp/api/status` 回 403：请求 Host 不是 loopback，或者 Origin 与 Host 不一致。
- 发消息报 `NO_KEY`：三条 Key 来源都没填。
- 迁移没反应：`GET /rp/api/migrate` 看有没有暂存项；旧页面必须带 `#migrate=端口`。

## 卸载

插件管理器里禁用/移除即可。`data/` 里的设置、备份、暂存数据在仓库目录里，
删不删都行；角色与会话在浏览器 origin 里，清浏览器数据才会没。
