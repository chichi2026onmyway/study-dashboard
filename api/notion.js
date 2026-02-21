// Vercel Serverless Function — Notion API Proxy
// All bugs fixed: pagination, fake data, countdown, streak, mastery logic

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_2026 = process.env.DB_2026 || "2f9cca2e785a80879f9fdbfd41389410";
const DB_LOG = process.env.DB_LOG;
const DB_CHECKIN = process.env.DB_CHECKIN;
const EXAM_DATE = "2026-08-01";

// ── Helpers ──────────────────────────────────────────────

function todayJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split("T")[0];
}

function daysUntilExam() {
  const today = new Date(todayJST());
  const exam = new Date(EXAM_DATE);
  return Math.ceil((exam - today) / (1000 * 60 * 60 * 24));
}

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

// Fetch all items from 2026 DB (max 10 pages = 1000 items)
async function fetchAllItems() {
  const items = [];
  let cursor = undefined;
  for (let i = 0; i < 10; i++) {
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

// Check if an item has actually been studied (not just pre-set 🔴)
function hasBeenStudied(props) {
  const reviewCount = props["Review Count"]?.rollup?.number || 0;
  const lastReviewed = props["Last Reviewed"]?.rollup?.date?.start;
  return reviewCount > 0 || !!lastReviewed;
}

// ── Study Summary ────────────────────────────────────────

async function getStudySummary() {
  const items = await fetchAllItems();
  const bySubject = {};
  let totalGreen = 0, totalYellow = 0, totalReviewed = 0;

  for (const item of items) {
    const props = item.properties;
    const subject = props.Subject?.select?.name || "Unknown";
    const mastery = props.Mastery?.select?.name || "";

    if (!bySubject[subject]) bySubject[subject] = { total: 0, green: 0, yellow: 0, red: 0, none: 0, reviewed: 0 };
    bySubject[subject].total++;

    if (hasBeenStudied(props)) {
      bySubject[subject].reviewed++;
      totalReviewed++;
    }

    if (mastery === "🟢") { bySubject[subject].green++; totalGreen++; }
    else if (mastery === "🟡") { bySubject[subject].yellow++; totalYellow++; }
    else if (mastery === "🔴") bySubject[subject].red++;
    else bySubject[subject].none++;
  }

  return { totalItems: items.length, totalGreen, totalYellow, totalReviewed, bySubject, daysUntilExam: daysUntilExam(), examDate: EXAM_DATE };
}

// ── Due Today ────────────────────────────────────────────

async function getDueToday() {
  const todayStr = todayJST();
  const items = await fetchAllItems();

  const due = items
    .filter((item) => {
      const props = item.properties;
      const mastery = props.Mastery?.select?.name;
      if (mastery === "🟢") return false;
      const redoDate = props["Redo Date"]?.date?.start;
      const autoRedo = props["Auto Redo"]?.formula?.date?.start?.split("T")[0];
      const effectiveDate = redoDate || autoRedo;
      if (!effectiveDate) return false; // No date = not due
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
        chapter: props.Chapter?.select?.name || "",
        url: item.url,
      };
    })
    .sort((a, b) => {
      const order = { "🔴 S 必须掌握": 0, "🟠 A 重要": 1, "🟡 B 建议学": 2, "🟢 C 了解即可": 3 };
      return (order[a.priority] ?? 4) - (order[b.priority] ?? 4);
    })
    .slice(0, 30);

  return { items: due };
}

// ── Recent Logs ──────────────────────────────────────────

async function getRecentLogs() {
  if (!DB_LOG) return { logs: [] };
  const res = await notionFetch(`/databases/${DB_LOG}/query`, {
    sorts: [{ property: "Review Date", direction: "descending" }],
    page_size: 50,
  });

  const logs = (res.results || []).map((item) => {
    const props = item.properties;
    const minutes = props["Duration (min)"]?.formula?.number || props["Time Spent (min)"]?.number || 0;
    const title = props.Title?.title?.[0]?.plain_text || "";
    let subject = props.Subject?.rollup?.array?.[0]?.select?.name || "";
    if (!subject) { for (const s of ["CS","AI","HCI","SE","IR"]) { if (title.toUpperCase().includes(s)) { subject = s; break; } } }
    return {
      title,
      date: (props["Review Date"]?.date?.start || "").split("T")[0],
      minutes: Math.round(minutes),
      subject,
      mastery: props.Mastery?.select?.name || "",
      method: props.Method?.select?.name || "",
    };
  });

  return { logs };
}

// ── Checkins (filtered: only real data) ──────────────────

async function getCheckins() {
  if (!DB_CHECKIN) return { checkins: [], calendarStats: { streak: 0, monthMinutes: 0, monthDays: 0, totalDays: 0 } };
  
  // Fetch ALL checkins (paginated)
  const allResults = [];
  let cursor = undefined;
  for (let i = 0; i < 10; i++) {
    const res = await notionFetch(`/databases/${DB_CHECKIN}/query`, {
      start_cursor: cursor,
      sorts: [{ property: "Date", direction: "descending" }],
      page_size: 100,
    });
    if (!res.results) break;
    allResults.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  const todayStr = todayJST();
  
  const checkins = allResults
    .map((item) => {
      const props = item.properties;
      return {
        id: item.id,
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
        name: props.Name?.title?.[0]?.plain_text || "",
      };
    })
    .filter(c => {
      // Filter out fake/future data
      if (!c.date) return false;
      if (c.date > todayStr) return false; // Future dates are fake
      if (c.minutes <= 0) return false; // No actual study time
      return true;
    });

  // Calculate streak
  let streak = 0;
  const dateSet = new Set(checkins.map(c => c.date));
  let checkDate = new Date(todayStr);
  // If no entry today, start from yesterday
  if (!dateSet.has(todayStr)) {
    checkDate.setDate(checkDate.getDate() - 1);
  }
  while (true) {
    const ds = checkDate.toISOString().split("T")[0];
    if (dateSet.has(ds)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  // Month stats
  const monthPrefix = todayStr.slice(0, 7); // "2026-02"
  const monthCheckins = checkins.filter(c => c.date.startsWith(monthPrefix));
  const monthMinutes = monthCheckins.reduce((s, c) => s + c.minutes, 0);
  const monthDays = new Set(monthCheckins.map(c => c.date)).size;
  const totalDays = dateSet.size;

  return {
    checkins,
    calendarStats: {
      streak,
      monthMinutes,
      monthDays,
      totalDays,
      todayMinutes: checkins.filter(c => c.date === todayStr).reduce((s, c) => s + c.minutes, 0),
    },
  };
}

// ── Create Log ───────────────────────────────────────────

async function createLog(data) {
  if (!DB_LOG) return { success: false, error: "DB_LOG not configured" };
  const properties = {
    Title: { title: [{ text: { content: data.title || "復習記録" } }] },
    "Review Date": { date: { start: data.date } },
  };
  if (data.method) properties.Method = { select: { name: data.method } };
  if (data.minutes) properties["Time Spent (min)"] = { number: data.minutes };
  if (data.startTime) properties["Start Time"] = { date: { start: data.startTime } };
  if (data.endTime) properties["End Time"] = { date: { start: data.endTime } };

  try {
    const res = await notionFetch("/pages", { parent: { database_id: DB_LOG }, properties });
    return { success: !!res.id, id: res.id, url: res.url };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Create Checkin ───────────────────────────────────────

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
    const res = await notionFetch("/pages", { parent: { database_id: DB_CHECKIN }, properties });
    return { success: !!res.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Complete Review (update mastery + redo date) ─────────

async function completeReview(data) {
  const { pageId, mastery } = data;
  if (!pageId || !mastery) return { success: false, error: "pageId and mastery required" };

  const props = {};
  props.Mastery = { select: { name: mastery } };

  // Set redo date based on mastery
  if (mastery === "🟢") {
    props["Redo Date"] = { date: null }; // No need to redo
  } else {
    const today = new Date(todayJST());
    const days = mastery === "🔴" ? 2 : mastery === "🟡" ? 7 : 14;
    today.setDate(today.getDate() + days);
    props["Redo Date"] = { date: { start: today.toISOString().split("T")[0] } };
  }

  try {
    const res = await notionFetch(`/pages/${pageId}`, { properties: props });
    return { success: !!res.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Get All (combined endpoint) ──────────────────────────

async function getAll() {
  const items = await fetchAllItems();

  // Build summary
  const bySubject = {};
  let totalGreen = 0, totalYellow = 0, totalReviewed = 0;
  for (const item of items) {
    const props = item.properties;
    const subject = props.Subject?.select?.name || "Unknown";
    const mastery = props.Mastery?.select?.name || "";
    if (!bySubject[subject]) bySubject[subject] = { total: 0, green: 0, yellow: 0, red: 0, none: 0, reviewed: 0 };
    bySubject[subject].total++;

    if (hasBeenStudied(props)) {
      bySubject[subject].reviewed++;
      totalReviewed++;
    }

    if (mastery === "🟢") { bySubject[subject].green++; totalGreen++; }
    else if (mastery === "🟡") { bySubject[subject].yellow++; totalYellow++; }
    else if (mastery === "🔴") bySubject[subject].red++;
    else bySubject[subject].none++;
  }

  // Due items
  const todayStr = todayJST();
  const due = items
    .filter((item) => {
      const props = item.properties;
      const mastery = props.Mastery?.select?.name;
      if (mastery === "🟢") return false;
      const redoDate = props["Redo Date"]?.date?.start;
      const autoRedo = props["Auto Redo"]?.formula?.date?.start?.split("T")[0];
      const effectiveDate = redoDate || autoRedo;
      if (!effectiveDate) return false;
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
        chapter: props.Chapter?.select?.name || "",
        url: item.url,
      };
    })
    .sort((a, b) => {
      const order = { "🔴 S 必须掌握": 0, "🟠 A 重要": 1, "🟡 B 建议学": 2, "🟢 C 了解即可": 3 };
      return (order[a.priority] ?? 4) - (order[b.priority] ?? 4);
    })
    .slice(0, 30);

  // Fetch logs and checkins in parallel
  const [logsRes, checkinsData] = await Promise.all([
    DB_LOG ? notionFetch(`/databases/${DB_LOG}/query`, {
      sorts: [{ property: "Review Date", direction: "descending" }],
      page_size: 50,
    }) : { results: [] },
    getCheckins(),
  ]);

  const logs = (logsRes.results || []).map((item) => {
    const props = item.properties;
    const minutes = props["Duration (min)"]?.formula?.number || props["Time Spent (min)"]?.number || 0;
    const title = props.Title?.title?.[0]?.plain_text || "";
    let subject = props.Subject?.rollup?.array?.[0]?.select?.name || "";
    if (!subject) { for (const s of ["CS","AI","HCI","SE","IR"]) { if (title.toUpperCase().includes(s)) { subject = s; break; } } }
    return { title, date: (props["Review Date"]?.date?.start || "").split("T")[0], minutes: Math.round(minutes), subject, mastery: props.Mastery?.select?.name || "" };
  });

  return {
    summary: { totalItems: items.length, totalGreen, totalYellow, totalReviewed, bySubject, daysUntilExam: daysUntilExam(), examDate: EXAM_DATE },
    dueItems: due,
    logs,
    checkins: checkinsData.checkins,
    calendarStats: checkinsData.calendarStats,
  };
}

// ── Anki Export ──────────────────────────────────────────

async function exportAnki(subject) {
  const allItems = [];
  let cursor;
  const filter = subject ? { property: "Subject", select: { equals: subject } } : undefined;

  for (let page = 0; page < 10; page++) {
    const res = await notionFetch(`/databases/${DB_2026}/query`, { start_cursor: cursor, page_size: 100, filter });
    if (!res?.results) break;
    for (const p of res.results) {
      const props = p.properties;
      const name = props.Name?.title?.map(t => t.plain_text).join("") || "";
      const note = props.Note?.rich_text?.map(t => t.plain_text).join("") || "";
      const subj = props.Subject?.select?.name || "";
      const chapter = props.Chapter?.select?.name || "";
      const mastery = props.Mastery?.select?.name || "";
      const type = props.Type?.select?.name || "";
      if (name) allItems.push({ front: name, back: note || "(no note)", tags: [subj, chapter, type, mastery].filter(Boolean).join(" ") });
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  const lines = allItems.map(item => `${item.front}\t${item.back}\t${item.tags}`);
  return { count: allItems.length, format: "TSV", data: lines.join("\n") };
}

// ── Handler ──────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: "NOTION_TOKEN not set" });
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
          today: todayJST(),
          daysUntilExam: daysUntilExam(),
        });
      case "all":
        return res.json(await getAll());
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
      case "complete-review":
        return res.json(await completeReview(req.body));
      case "anki-export": {
        const subj = req.query.subject || null;
        const ankiData = await exportAnki(subj);
        if (req.query.download === "1") {
          res.setHeader("Content-Type", "text/tab-separated-values; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="anki-${subj || 'all'}-${todayJST()}.txt"`);
          return res.send(ankiData.data);
        }
        return res.json(ankiData);
      }
      default:
        return res.status(400).json({ error: "Unknown action: " + action });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
