# 🎯 京大社情 Study Dashboard v2

## 📁 项目结构
```
study-dashboard/
├── api/notion.js        ← 后端 (连接 Notion API)
├── public/index.html    ← 前端 (整个 Dashboard)
├── vercel.json          ← 路由配置
└── package.json         ← 项目信息
```

## 🆕 v2 新功能
- ✅ **累计时间修复**: 不再重复计算 Review Log + Check-in 的时间
- ✅ **AI Terminology 复习**: 支持按 Lec 分组浏览 + 闪卡模式
- ✅ **自由选择区**: 過去問(按年份) / AI術語(按Lec) / 教材阅读 三合一
- ✅ **间隔重复**: 每日自动推送只推送之前复习过且到期的内容
- ✅ **教材阅读**: 选中教材即开始计时，读完自动记录
- ✅ **闪卡模式**: AI术语翻卡复习，支持即时评分

## 🔧 Vercel 环境变量

在原有基础上新增一个:

| Key | Value |
| --- | --- |
| `NOTION_TOKEN` | `ntn_你的token` |
| `DB_2026` | `2f9cca2e785a80879f9fdbfd41389410` |
| `DB_LOG` | `a3ae626bb8104d8f9ecdad284e31e9e6` |
| `DB_CHECKIN` | `d27d846f97c845f5a50e74529b6d4845` |
| `DB_AI_TERM` | `30fcca2e785a80f68dbec6b8693276d5` |

部署后需要在 Vercel Dashboard → Settings → Environment Variables 中添加 `DB_AI_TERM`，然后重新部署。
