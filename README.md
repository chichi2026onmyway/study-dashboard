# 🎯 Study Dashboard

打开 Notion 就能看到的精美学习仪表板，带计时器、热力图、进度追踪。

## 📁 项目结构 (只有4个文件!)

```
kyodai-dashboard/
├── api/notion.js        ← 后端 (连接 Notion API)
├── public/index.html    ← 前端 (整个 Dashboard)
├── vercel.json          ← 路由配置
└── package.json         ← 项目信息
```

---

## 🚀 部署步骤 (大约10分钟)

### Step 1: 创建 Notion Integration (3分钟)

1. 打开 https://www.notion.so/my-integrations
2. 点 **"New integration"**
3. 名称: `Study Dashboard`，选你的 workspace
4. 权限: 勾选 **Read content** + **Insert content**
5. 点 Create → 复制 **Internal Integration Secret** (以 `ntn_` 开头)
6. **重要!** 回到 Notion → 打开 **Chi** 页面 → 右上角 `···` → `Connections` → 添加 `Study Dashboard`

### Step 2: 上传到 GitHub (2分钟)

1. 在 GitHub 新建一个仓库，名字随便 (如 `kyodai-dashboard`)
2. 把这4个文件上传上去

### Step 3: 部署到 Vercel (3分钟)

1. 打开 https://vercel.com → 用 GitHub 登录
2. 点 **"Import Project"** → 选择你刚创建的仓库
3. 在 **Environment Variables** 中添加:

   | Key | Value |
   |-----|-------|
   | `NOTION_TOKEN` | `ntn_你的token` |
   | `DB_2026` | `2f9cca2e785a80879f9fdbfd41389410` |
   | `DB_LOG` | `a3ae626bb8104d8f9ecdad284e31e9e6` |
   | `DB_CHECKIN` | `d27d846f97c845f5a50e74529b6d4845` |

4. 点 **Deploy** → 等1分钟 → 完成!
5. 你会得到一个链接: `https://你的项目.vercel.app`

### Step 4: 嵌入 Notion (1分钟)

1. 打开你的 Notion Study Dashboard 页面
2. 输入 `/embed`
3. 粘贴你的 Vercel 链接
4. 完成! 现在 Notion 里就能看到完整的 Dashboard 了

### Step 5: 手机快捷访问

**方法A (推荐): 直接在 Notion App 里看**
嵌入后，Notion 手机 App 里也能看到 Dashboard

**方法B: 添加到主屏幕**
用 Safari 打开你的 Vercel 链接 → 分享 → "添加到主屏幕"

---

## ✨ 功能一览

- ⏱ **计时器**: 选科目 → 开始 → 结束 → 自动记录到 Notion
- 📊 **掌握度进度条**: 实时显示每科的 🟢🟡🔴 分布
- 📋 **今日待复习**: 显示所有 Redo Date 到期的项目
- 📆 **学习日历热力图**: 像 GitHub 一样的打卡记录
- 🔥 **连续天数**: 追踪你的学习 streak
- 📅 **每周计划**: 高亮今天该学什么
- 🎯 **Phase 进度**: 4个阶段的进度可视化
- 📝 **最近复习记录**: 最新的学习活动

---

## ❓ 常见问题

**Q: 数据不显示?**
A: 确认你已经在 Notion 的 Chi 页面添加了 Integration 的 Connection。

**Q: 计时器记录失败?**
A: 检查 Vercel 的环境变量是否正确，特别是 DB_LOG。

**Q: 嵌入到 Notion 后显示不完整?**
A: 在 Notion 里拖大 embed 框的高度即可。
