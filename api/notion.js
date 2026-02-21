const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_2026 = process.env.DB_2026;
const DB_LOG = process.env.DB_LOG;
const DB_CHECKIN = process.env.DB_CHECKIN;

// ---------- helpers ----------
function todayJST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}
function dateStrJST() {
  const d = todayJST();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Paginate through all results (up to 1000)
async function queryAll(dbId, filter, sorts) {
  let results = [];
  let cursor = undefined;
  let pages = 0;
  do {
    const resp = await notion.databases.query({
      database_id: dbId,
      filter: filter || undefined,
      sorts: sorts || undefined,
      start_cursor: cursor,
      page_size: 100
    });
    results = results.concat(resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
    pages++;
  } while (cursor && pages < 10); // max 1000
  return results;
}

// ---------- parse helpers ----------
function parseStudyItem(p) {
  const props = p.properties;
  return {
    id: p.id,
    name: props.Name?.title?.[0]?.plain_text || '',
    subject: props.Subject?.select?.name || '',
    type: props.Type?.select?.name || '',
    mastery: props.Mastery?.select?.name || '',
    priority: props.Priority?.select?.name || '',
    chapter: props.Chapter?.select?.name || '',
    year: props.Year?.select?.name || '',
    difficulty: props.Difficulty?.select?.name || '',
    redoDate: props['Redo Date']?.date?.start || '',
    note: props.Note?.rich_text?.[0]?.plain_text || '',
    relatedKnowledge: props['Related Knowledge']?.rich_text?.[0]?.plain_text || '',
    timeSpent: props['Time Spent']?.number || 0,
    num: props.Num?.rich_text?.[0]?.plain_text || '',
  };
}

function parseLog(p) {
  const props = p.properties;
  return {
    id: p.id,
    title: props.Title?.title?.[0]?.plain_text || '',
    subject: props.Subject?.rollup?.array?.[0]?.select?.name || '',
    mastery: props.Mastery?.select?.name || '',
    method: props.Method?.select?.name || '',
    timeSpent: props['Time Spent (min)']?.number || 0,
    reviewDate: props['Review Date']?.date?.start || '',
    startTime: props['Start Time']?.date?.start || '',
    endTime: props['End Time']?.date?.start || '',
    notes: props.Notes?.rich_text?.[0]?.plain_text || '',
    studyItemIds: (props['Study Item']?.relation || []).map(r => r.id),
  };
}

function parseCheckin(p) {
  const props = p.properties;
  return {
    id: p.id,
    name: props.Name?.title?.[0]?.plain_text || '',
    date: props.Date?.date?.start || '',
    minutes: props.Minutes?.number || 0,
    phase: props.Phase?.select?.name || '',
    mood: props.Mood?.select?.name || '',
    satisfaction: props.Satisfaction?.select?.name || '',
    dayType: props['Day Type']?.select?.name || '',
    whatIDid: props['What I Did']?.rich_text?.[0]?.plain_text || '',
    pomodoros: props.Pomodoros?.number || 0,
    cs: props.CS?.checkbox || false,
    ai: props.AI?.checkbox || false,
    hci: props.HCI?.checkbox || false,
    se: props.SE?.checkbox || false,
    ir: props.IR?.checkbox || false,
    earlyRise: props['早起']?.checkbox || false,
    earlySleep: props['早睡']?.checkbox || false,
    exercise: props['运动']?.checkbox || false,
    reading: props['阅读']?.checkbox || false,
    meditation: props['冥想']?.checkbox || false,
    noTakeout: props['不点外卖']?.checkbox || false,
  };
}

// ---------- API handlers ----------
async function getAll() {
  const today = dateStrJST();

  const [items, logs, checkins] = await Promise.all([
    queryAll(DB_2026),
    queryAll(DB_LOG, undefined, [{ property: 'Review Date', direction: 'descending' }]),
    queryAll(DB_CHECKIN, undefined, [{ property: 'Date', direction: 'descending' }]),
  ]);

  const parsedItems = items.map(parseStudyItem);
  const parsedLogs = logs.map(parseLog).filter(l => {
    // Only include logs with actual review activity
    if (!l.reviewDate) return false;
    if (l.reviewDate > today) return false;
    return true;
  });
  const parsedCheckins = checkins.map(parseCheckin).filter(c => {
    // Filter out fake/future data
    if (!c.date) return false;
    if (c.date > today) return false;
    if (c.minutes <= 0 && !c.cs && !c.ai && !c.hci && !c.se && !c.ir) return false;
    return true;
  });

  // --- Mastery stats (only count items that have actually been studied) ---
  // Items with mastery AND (has a log OR has timeSpent > 0 OR has a redoDate) are "studied"
  // Items with no mastery are "not studied yet" (don't count 🔴 as studied if it was pre-set)
  const itemsWithLogs = new Set();
  parsedLogs.forEach(l => l.studyItemIds.forEach(id => itemsWithLogs.add(id)));

  const masteryStats = { total: parsedItems.length, green: 0, yellow: 0, red: 0, notStudied: 0 };
  const subjectStats = {};

  parsedItems.forEach(item => {
    if (!subjectStats[item.subject]) {
      subjectStats[item.subject] = { total: 0, green: 0, yellow: 0, red: 0, notStudied: 0 };
    }
    subjectStats[item.subject].total++;

    const hasBeenStudied = itemsWithLogs.has(item.id) || item.timeSpent > 0 || (item.redoDate && item.redoDate <= today);

    if (item.mastery === '🟢' && hasBeenStudied) {
      masteryStats.green++;
      subjectStats[item.subject].green++;
    } else if (item.mastery === '🟡' && hasBeenStudied) {
      masteryStats.yellow++;
      subjectStats[item.subject].yellow++;
    } else if (item.mastery === '🔴' && hasBeenStudied) {
      masteryStats.red++;
      subjectStats[item.subject].red++;
    } else {
      masteryStats.notStudied++;
      subjectStats[item.subject].notStudied++;
    }
  });

  // --- Due today (only items with redo date <= today, not empty dates) ---
  const dueToday = parsedItems.filter(item => {
    if (!item.redoDate) return false;
    return item.redoDate <= today;
  }).sort((a, b) => {
    // Priority sort: S > A > B > C > empty
    const pOrder = { '🔴 S 必须掌握': 0, '🟠 A 重要': 1, '🟡 B 建议学': 2, '🟢 C 了解即可': 3 };
    const pa = pOrder[a.priority] ?? 4;
    const pb = pOrder[b.priority] ?? 4;
    if (pa !== pb) return pa - pb;
    // Then by mastery: 🔴 > 🟡 > 🟢
    const mOrder = { '🔴': 0, '🟡': 1, '🟢': 2 };
    return (mOrder[a.mastery] ?? 3) - (mOrder[b.mastery] ?? 3);
  });

  // --- Phase progress ---
  const phaseItems = {};
  parsedCheckins.forEach(c => {
    if (c.phase && !phaseItems[c.phase]) {
      phaseItems[c.phase] = { count: 0, totalMinutes: 0 };
    }
    if (c.phase) {
      phaseItems[c.phase].count++;
      phaseItems[c.phase].totalMinutes += c.minutes;
    }
  });

  // --- Streak calculation (real data only) ---
  const studyDates = new Set();
  parsedCheckins.forEach(c => {
    if (c.minutes > 0) studyDates.add(c.date);
  });
  parsedLogs.forEach(l => {
    if (l.timeSpent > 0) studyDates.add(l.reviewDate);
  });

  let streak = 0;
  const d = todayJST();
  // Check if studied today
  if (studyDates.has(today)) {
    streak = 1;
    d.setDate(d.getDate() - 1);
  }
  while (true) {
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (studyDates.has(ds)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }

  // --- Total hours ---
  let totalMinutes = 0;
  parsedCheckins.forEach(c => { totalMinutes += c.minutes; });
  parsedLogs.forEach(l => { totalMinutes += l.timeSpent; });

  // --- Countdown ---
  const examDate = new Date('2026-08-01T00:00:00+09:00');
  const nowJST = todayJST();
  const daysLeft = Math.ceil((examDate - nowJST) / (1000 * 60 * 60 * 24));

  // --- Heatmap data (last 6 months) ---
  const heatmap = {};
  parsedCheckins.forEach(c => {
    if (c.date && c.minutes > 0) {
      heatmap[c.date] = (heatmap[c.date] || 0) + c.minutes;
    }
  });
  parsedLogs.forEach(l => {
    if (l.reviewDate && l.timeSpent > 0) {
      heatmap[l.reviewDate] = (heatmap[l.reviewDate] || 0) + l.timeSpent;
    }
  });

  return {
    items: parsedItems,
    logs: parsedLogs.slice(0, 20),
    checkins: parsedCheckins.slice(0, 60),
    masteryStats,
    subjectStats,
    dueToday,
    phaseItems,
    streak,
    totalHours: Math.round(totalMinutes / 60 * 10) / 10,
    daysLeft,
    today,
    heatmap,
    studyDates: Array.from(studyDates),
  };
}

// Create a review log and optionally update the study item
async function completeReview({ studyItemId, studyItemName, subject, timeSpent, mastery, method, notes, startTime, endTime }) {
  const today = dateStrJST();

  // 1. Create review log entry
  const logProps = {
    Title: { title: [{ text: { content: studyItemName || `Review ${today}` } }] },
    'Review Date': { date: { start: today } },
    'Time Spent (min)': { number: timeSpent || 0 },
  };

  if (mastery) {
    logProps.Mastery = { select: { name: mastery } };
  }
  if (method) {
    logProps.Method = { select: { name: method } };
  }
  if (notes) {
    logProps.Notes = { rich_text: [{ text: { content: notes } }] };
  }
  if (startTime) {
    logProps['Start Time'] = { date: { start: startTime } };
  }
  if (endTime) {
    logProps['End Time'] = { date: { start: endTime } };
  }
  if (studyItemId) {
    logProps['Study Item'] = { relation: [{ id: studyItemId }] };
  }

  const logPage = await notion.pages.create({
    parent: { database_id: DB_LOG },
    properties: logProps,
  });

  // 2. Update the study item's mastery & redo date if provided
  if (studyItemId) {
    const updateProps = {};

    if (mastery) {
      // Map log mastery to item mastery
      const masteryMap = {
        '🟢 掌握': '🟢',
        '🟡 半熟': '🟡',
        '🔴 不会': '🔴',
      };
      if (masteryMap[mastery]) {
        updateProps.Mastery = { select: { name: masteryMap[mastery] } };
      }
    }

    // Calculate next redo date based on mastery (spaced repetition)
    const nextDate = new Date(todayJST());
    if (mastery === '🟢 掌握') {
      nextDate.setDate(nextDate.getDate() + 14); // 2 weeks
    } else if (mastery === '🟡 半熟') {
      nextDate.setDate(nextDate.getDate() + 3); // 3 days
    } else {
      nextDate.setDate(nextDate.getDate() + 1); // tomorrow
    }
    const nextDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth()+1).padStart(2,'0')}-${String(nextDate.getDate()).padStart(2,'0')}`;
    updateProps['Redo Date'] = { date: { start: nextDateStr } };

    if (Object.keys(updateProps).length > 0) {
      await notion.pages.update({
        page_id: studyItemId,
        properties: updateProps,
      });
    }
  }

  // 3. Update or create today's checkin
  try {
    const existingCheckins = await notion.databases.query({
      database_id: DB_CHECKIN,
      filter: {
        property: 'Date',
        date: { equals: today }
      }
    });

    if (existingCheckins.results.length > 0) {
      const existing = existingCheckins.results[0];
      const currentMin = existing.properties.Minutes?.number || 0;
      const updateP = {
        Minutes: { number: currentMin + (timeSpent || 0) },
      };
      // Set subject checkbox
      if (subject) {
        const subjectMap = { CS: 'CS', AI: 'AI', HCI: 'HCI', SE: 'SE', IR: 'IR' };
        if (subjectMap[subject]) {
          updateP[subjectMap[subject]] = { checkbox: true };
        }
      }
      await notion.pages.update({
        page_id: existing.id,
        properties: updateP,
      });
    } else {
      const newP = {
        Name: { title: [{ text: { content: `Day ${today}` } }] },
        Date: { date: { start: today } },
        Minutes: { number: timeSpent || 0 },
        Phase: { select: { name: 'Phase 1 基础' } },
        'Day Type': { select: { name: new Date(today).getDay() % 6 === 0 ? '周末' : '工作日' } },
      };
      if (subject) {
        const subjectMap = { CS: 'CS', AI: 'AI', HCI: 'HCI', SE: 'SE', IR: 'IR' };
        if (subjectMap[subject]) {
          newP[subjectMap[subject]] = { checkbox: true };
        }
      }
      await notion.pages.create({
        parent: { database_id: DB_CHECKIN },
        properties: newP,
      });
    }
  } catch (e) {
    console.error('Checkin update error:', e.message);
  }

  return { success: true, logId: logPage.id };
}

// ---------- Vercel handler ----------
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action } = req.query;

    if (action === 'getAll') {
      const data = await getAll();
      return res.status(200).json(data);
    }

    if (action === 'complete-review' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const result = await completeReview(body);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Unknown action. Use ?action=getAll or ?action=complete-review' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
