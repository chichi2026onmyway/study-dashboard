// Vercel Serverless Function — Notion API Proxy
// This runs on Vercel's server so there are no CORS issues

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_2026 = process.env.DB_2026 || "2f9cca2e785a80879f9fdbfd41389410";
const DB_LOG = process.env.DB_LOG;
const DB_CHECKIN = process.env.DB_CHECKIN;

async function notionFetch(endpoint, body) {
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// Helper: fetch all items from 2026 DB (max 10 pages = 1000 items)
async function fetchAllItems() {
  const items = [];
  let cursor = undefined;
  for (let i = 0; i < 10; i++) {  // ✅ 修复：3 → 10
    const res = await notionFetch(`/databases/${DB_2026}/query`, {
      start_cursor: cursor,
      page_size: 100,
    });
    if (!res.results) break;
    items.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return items;
}

// Helper: check if an item has actually been studied
function hasBeenStudied(props) {
  const reviewCount = props["Review Count"]?.rollup?.number || 0;
  const lastReviewed = props["Last Reviewed"]?.rollup?.date?.start;
  return reviewCount > 0 || !!lastReviewed;
}

// Get study items summary by subject
async function getStudySummary() {
  const items = await fetchAllItems();

  const bySubject = {};
  let totalGreen = 0;
  let totalReviewed = 0;  // ✅ 新增
  for (const item of items) {
    const props = item.properties;
    const subject = props.Subject?.select?.name || "Unknown";
    const mastery = props.Mastery?.select?.name || "";

    if (!bySubject[subject]) bySubject[subject] = { total: 0, green: 0, yellow: 0, red: 0, none: 0, reviewed: 0 };
    bySubject[subject].total++;

    // ✅ 新增：只有真正学习过的才算 reviewed
    if (hasBeenStudied(props)) {
      bySubject[subject].reviewed++;
      totalReviewed++;
    }

    if (mastery === "🟢") { bySubject[subject].green++; totalGreen++; }
    else if (mastery === "🟡") bySubject[subject].yellow++;
    else if (mastery === "🔴") bySubject[subject].red++;
    else bySubject[subject].none++;
  }

  return { totalItems: items.length, totalGreen, totalReviewed, bySubject };
}

// Get items due today or overdue
async function getDueToday() {
  const today = new Date().toISOString().split("T")[0];
  const items = await fetchAllItems();

  const due = items
    .filter((item) => {
      const props = item.properties;
      const mastery = props.Mastery?.select?.name;
      if (mastery === "🟢") return false;

      const redoDate = props["Redo Date"]?.date?.start;
      const autoRedo = props["Auto Redo"]?.formula?.date?.start?.split("T")[0];
      const effectiveDate = redoDate || autoRedo;
      if (!effectiveDate) return false;  // ✅ 修复：没有日期不算待复习
      return effectiveDate <= today;
    })
    .map((item) => {
      const props = item.properties;
      return {
        id: item.id,
        name: props.Name?.title?.[0]?.plain_text || "Untitled",
        subject: props.Subject?.select?.name || "",
        mastery: props.Mastery?.select?.name || "",
        type: props.Type?.select?.name || "",
        priority: props.Priority?.select?.name || "",
        url: item.url,
      };
    })
    .sort((a, b) => {
      const order = { "🔴 S 必须掌握": 0, "🟠 A 重要": 1, "🟡 B 建议学": 2, "🟢 C 了解即可": 3 };
      return (order[a.priority] ?? 4) - (order[b.priority] ?? 4);
    })
    .slice(0, 20);

  return { items: due };
}

// Get recent review logs
async function getRecentLogs() {
  if (!DB_LOG) return { logs: [] };
  const res = await notionFetch(`/databases/${DB_LOG}/query`, {
    sorts: [{ property: "Review Date", direction: "descending" }],
    page_size: 50,
  });

  const logs = (res.results || []).map((item) => {
    const props = item.properties;
    const reviewDate = props["Review Date"]?.date?.start || "";
    const minutes =
      props["Duration (min)"]?.formula?.number ||
      props["Time Spent (min)"]?.number ||
      0;
    const title = props.Title?.title?.[0]?.plain_text || "";
    const mastery = props.Mastery?.select?.name || "";
    const method = props.Method?.select?.name || "";

    let subject = "";
    const subjectRollup = props.Subject?.rollup?.array?.[0]?.select?.name;
    if (subjectRollup) {
      subject = subjectRollup;
    } else {
      for (const s of ["CS", "AI", "HCI", "SE", "IR"]) {
        if (title.toUpperCase().includes(s)) { subject = s; break; }
      }
    }

    return { title, date: reviewDate.split("T")[0], minutes: Math.round(minutes), subject, mastery, method };
  });

  return { logs };
}

// Get daily check-in records
async function getCheckins() {
  if (!DB_CHECKIN) return { checkins: [] };
  const res = await notionFetch(`/databases/${DB_CHECKIN}/query`, {
    sorts: [{ property: "Date", direction: "descending" }],
    page_size: 60,
  });

  const checkins = (res.results || []).map((item) => {
    const props = item.properties;
    return {
      date: props.Date?.date?.start || "",
      minutes: props.Minutes?.number || 0,
      mood: props.Mood?.select?.name || "",
      cs: props.CS?.checkbox || false,
      ai: props.AI?.checkbox || false,
      hci: props.HCI?.checkbox || false,
      se: props.SE?.checkbox || false,
      ir: props.IR?.checkbox || false,
      satisfaction: props.Satisfaction?.select?.name || "",
      whatIDid: props["What I Did"]?.rich_text?.[0]?.plain_text || "",
    };
  });

  return { checkins };
}

// Create a review log entry
async function createLog(data) {
  if (!DB_LOG) return { success: false, error: "DB_LOG not configured" };

  const properties = {
    Title: { title: [{ text: { content: data.title || "复习记录" } }] },
    "Review Date": { date: { start: data.date } },
  };

  if (data.method) {
    properties.Method = { select: { name: data.method } };
  }
  if (data.minutes) {
    properties["Time Spent (min)"] = { number: data.minutes };
  }
  if (data.startTime) {
    properties["Start Time"] = { date: { start: data.startTime } };
  }
  if (data.endTime) {
    properties["End Time"] = { date: { start: data.endTime } };
  }

  try {
    const res = await notionFetch("/pages", {
      parent: { database_id: DB_LOG },
      properties,
    });
    return { success: !!res.id, id: res.id, url: res.url };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Create a daily check-in
async function createCheckin(data) {
  if (!DB_CHECKIN) return { success: false, error: "DB_CHECKIN not configured" };

  const properties = {
    Name: { title: [{ text: { content: data.name || `${data.date} 打卡` } }] },
    Date: { date: { start: data.date } },
  };

  if (data.minutes != null) properties.Minutes = { number: data.minutes };
  if (data.mood) properties.Mood = { select: { name: data.mood } };
  if (data.cs) properties.CS = { checkbox: true };
  if (data.ai) properties.AI = { checkbox: true };
  if (data.hci) properties.HCI = { checkbox: true };
  if (data.se) properties.SE = { checkbox: true };
  if (data.ir) properties.IR = { checkbox: true };

  try {
    const res = await notionFetch("/pages", {
      parent: { database_id: DB_CHECKIN },
      properties,
    });
    return { success: !!res.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Get everything in one call (much faster!)
async function getAll() {
  const items = await fetchAllItems();  // ✅ 使用统一的分页函数

  // Build summary from items
  const bySubject = {};
  let totalGreen = 0;
  let totalReviewed = 0;  // ✅ 新增
  for (const item of items) {
    const props = item.properties;
    const subject = props.Subject?.select?.name || "Unknown";
    const mastery = props.Mastery?.select?.name || "";
    if (!bySubject[subject]) bySubject[subject] = { total: 0, green: 0, yellow: 0, red: 0, none: 0, reviewed: 0 };
    bySubject[subject].total++;

    // ✅ 新增：真正学习过的统计
    if (hasBeenStudied(props)) {
      bySubject[subject].reviewed++;
      totalReviewed++;
    }

    if (mastery === "🟢") { bySubject[subject].green++; totalGreen++; }
    else if (mastery === "🟡") bySubject[subject].yellow++;
    else if (mastery === "🔴") bySubject[subject].red++;
    else bySubject[subject].none++;
  }

  // Build due items from same data
  const todayStr = new Date().toISOString().split("T")[0];
  const due = items
    .filter((item) => {
      const props = item.properties;
      const mastery = props.Mastery?.select?.name;
      if (mastery === "🟢") return false;
      const redoDate = props["Redo Date"]?.date?.start;
      const autoRedo = props["Auto Redo"]?.formula?.date?.start?.split("T")[0];
      const effectiveDate = redoDate || autoRedo;
      if (!effectiveDate) return false;  // ✅ 修复
      return effectiveDate <= todayStr;
    })
    .map((item) => {
      const props = item.properties;
      return {
        id: item.id,
        name: props.Name?.title?.[0]?.plain_text || "Untitled",
        subject: props.Subject?.select?.name || "",
        mastery: props.Mastery?.select?.name || "",
        type: props.Type?.select?.name || "",
        priority: props.Priority?.select?.name || "",
        url: item.url,
      };
    })
    .sort((a, b) => {
      const order = { "🔴 S 必须掌握": 0, "🟠 A 重要": 1, "🟡 B 建议学": 2, "🟢 C 了解即可": 3 };
      return (order[a.priority] ?? 4) - (order[b.priority] ?? 4);
    })
    .slice(0, 20);

  // Fetch logs and checkins in parallel
  const [logsRes, checkinsRes] = await Promise.all([
    DB_LOG ? notionFetch(`/databases/${DB_LOG}/query`, {
      sorts: [{ property: "Review Date", direction: "descending" }],
      page_size: 50,
    }) : { results: [] },
    DB_CHECKIN ? notionFetch(`/databases/${DB_CHECKIN}/query`, {
      sorts: [{ property: "Date", direction: "descending" }],
      page_size: 60,
    }) : { results: [] },
  ]);

  const logs = (logsRes.results || []).map((item) => {
    const props = item.properties;
    const minutes = props["Duration (min)"]?.formula?.number || props["Time Spent (min)"]?.number || 0;
    const title = props.Title?.title?.[0]?.plain_text || "";
    let subject = props.Subject?.rollup?.array?.[0]?.select?.name || "";
    if (!subject) { for (const s of ["CS","AI","HCI","SE","IR"]) { if (title.toUpperCase().includes(s)) { subject = s; break; } } }
    return { title, date: (props["Review Date"]?.date?.start || "").split("T")[0], minutes: Math.round(minutes), subject, mastery: props.Mastery?.select?.name || "" };
  });

  const checkins = (checkinsRes.results || []).map((item) => {
    const props = item.properties;
    return {
      date: props.Date?.date?.start || "",
      minutes: props.Minutes?.number || 0,
      mood: props.Mood?.select?.name || "",
      cs: props.CS?.checkbox || false,
      ai: props.AI?.checkbox || false,
      hci: props.HCI?.checkbox || false,
      se: props.SE?.checkbox || false,
      ir: props.IR?.checkbox || false,
    };
  });

  return {
    summary: { totalItems: items.length, totalGreen, totalReviewed, bySubject },
    dueItems: due,
    logs,
    checkins,
  };
}

// Anki CSV export
async function exportAnki(subject) {
  const allItems = [];
  let cursor;
  const filter = subject ? {
    property: "Subject",
    select: { equals: subject },
  } : undefined;

  for (let page = 0; page < 10; page++) {  // ✅ 修复：5 → 10
    const res = await notionFetch(`/databases/${DB_2026}/query`, {
      start_cursor: cursor,
      page_size: 100,
      filter,
    });
    if (!res?.results) break;

    for (const p of res.results) {
      const props = p.properties;
      const name = props.Name?.title?.map(t => t.plain_text).join("") || "";
      const note = props.Note?.rich_text?.map(t => t.plain_text).join("") || "";
      const subject = props.Subject?.select?.name || "";
      const chapter = props.Chapter?.select?.name || "";
      const mastery = props.Mastery?.select?.name || "";
      const type = props.Type?.select?.name || "";

      if (name) {
        allItems.push({
          front: name,
          back: note || "(no note)",
          tags: [subject, chapter, type, mastery].filter(Boolean).join(" "),
        });
      }
    }

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  const lines = allItems.map(item =>
    `${item.front}\t${item.back}\t${item.tags}`
  );

  return {
    count: allItems.length,
    format: "TSV (tab-separated), columns: Front | Back | Tags",
    instructions: "在 Anki 中: File → Import → 选择此文件 → Field separator: Tab → Fields: Front, Back, Tags",
    data: lines.join("\n"),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: "NOTION_TOKEN 环境变量未设置。请在 Vercel Settings → Environment Variables 中添加。" });
  }

  const action = req.query.action;

  try {
    switch (action) {
      case "ping":
        return res.json({
          ok: true,
          token: NOTION_TOKEN ? `${NOTION_TOKEN.substring(0, 8)}...` : "MISSING",
          db2026: DB_2026 || "MISSING",
          dbLog: DB_LOG || "MISSING",
          dbCheckin: DB_CHECKIN || "MISSING",
        });
      case "all":
        return res.json(await getAll());
      case "anki-export":
        const subject = req.query.subject || null;
        const ankiData = await exportAnki(subject);
        if (req.query.download === "1") {
          res.setHeader("Content-Type", "text/tab-separated-values; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="anki-${subject || 'all'}-${new Date().toISOString().split('T')[0]}.txt"`);
          return res.send(ankiData.data);
        }
        return res.json(ankiData);
      case "study-summary":
        return res.json(await getStudySummary());
      case "due-today":
        return res.json(await getDueToday());
      case "recent-logs":
        return res.json(await getRecentLogs());
      case "checkins":
        return res.json(await getCheckins());
      case "create-log":
        return res.json(await createLog(req.body));
      case "create-checkin":
        return res.json(await createCheckin(req.body));
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
