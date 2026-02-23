const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_2026 = process.env.DB_2026;
const DB_LOG = process.env.DB_LOG;
const DB_CHECKIN = process.env.DB_CHECKIN;
const DB_AI_TERM = process.env.DB_AI_TERM;

function todayJST() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })); }
function dateStrJST() { const d = todayJST(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function notionUrl(id) { return `https://notion.so/${id.replace(/-/g, '')}`; }

async function queryAll(dbId, filter, sorts) {
  let results = [], cursor, pages = 0;
  do {
    const resp = await notion.databases.query({ database_id: dbId, filter: filter || undefined, sorts: sorts || undefined, start_cursor: cursor, page_size: 100 });
    results = results.concat(resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
    pages++;
  } while (cursor && pages < 10);
  return results;
}

// ===== PARSE: Study Item (2026 DB) =====
function parseStudyItem(p) {
  const props = p.properties;
  return {
    id: p.id, url: notionUrl(p.id),
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
    source: '2026', // tag source
  };
}

// ===== PARSE: AI Terminology =====
function parseAITerm(p) {
  const props = p.properties;
  return {
    id: p.id, url: notionUrl(p.id),
    name: props.Terminology?.title?.[0]?.plain_text || '',
    definition: props.Definition?.rich_text?.[0]?.plain_text || '',
    lec: props.Lec?.select?.name || '',
    part: props.Part?.select?.name || '',
    priority: props.Priority?.select?.name || '',
    mastery: props.Mastery?.select?.name || '',
    redoDate: props['Redo Date']?.date?.start || '',
    status: props['']?.status?.name || '',
    subject: 'AI', // always AI
    source: 'aiTerm', // tag source
  };
}

// ===== PARSE: Review Log =====
function parseLog(p) {
  const props = p.properties;
  let timeSpent = 0;
  const durFormula = props['Duration (min)'];
  if (durFormula?.formula?.number != null) {
    timeSpent = Math.round(durFormula.formula.number);
  }
  const startTime = props['Start Time']?.date?.start || '';
  const endTime = props['End Time']?.date?.start || '';
  if (timeSpent <= 0 && startTime && endTime) {
    const diff = new Date(endTime) - new Date(startTime);
    if (diff > 0) timeSpent = Math.round(diff / 60000);
  }
  return {
    id: p.id, url: notionUrl(p.id),
    title: props.Title?.title?.[0]?.plain_text || '',
    subject: props.Subject?.rollup?.array?.[0]?.select?.name || '',
    mastery: props.Mastery?.select?.name || '',
    method: props.Method?.select?.name || '',
    timeSpent, reviewDate: props['Review Date']?.date?.start || '',
    startTime, endTime,
    notes: props.Notes?.rich_text?.[0]?.plain_text || '',
    studyItemIds: (props['Study Item']?.relation || []).map(r => r.id),
    aiTermIds: (props['AI Term']?.relation || []).map(r => r.id),
  };
}

// ===== PARSE: Check-in =====
function parseCheckin(p) {
  const props = p.properties;
  return {
    id: p.id, name: props.Name?.title?.[0]?.plain_text || '',
    date: props.Date?.date?.start || '', minutes: props.Minutes?.number || 0,
    phase: props.Phase?.select?.name || '', mood: props.Mood?.select?.name || '',
    satisfaction: props.Satisfaction?.select?.name || '',
    dayType: props['Day Type']?.select?.name || '',
    whatIDid: props['What I Did']?.rich_text?.[0]?.plain_text || '',
    pomodoros: props.Pomodoros?.number || 0,
    cs: props.CS?.checkbox || false, ai: props.AI?.checkbox || false,
    hci: props.HCI?.checkbox || false, se: props.SE?.checkbox || false,
    ir: props.IR?.checkbox || false,
    earlyRise: props['早起']?.checkbox || false, earlySleep: props['早睡']?.checkbox || false,
    exercise: props['运动']?.checkbox || false, reading: props['阅读']?.checkbox || false,
    meditation: props['冥想']?.checkbox || false, noTakeout: props['不点外卖']?.checkbox || false,
  };
}

// ===== PRIORITY HELPERS =====
function priorityOrder(pri) {
  if (!pri) return 4;
  if (pri.includes('S') || pri === 'Critical') return 0;
  if (pri.includes('A') || pri === 'High') return 1;
  if (pri.includes('B') || pri === 'Medium') return 2;
  if (pri.includes('C') || pri === 'Low') return 3;
  return 4;
}

// ===== DAILY PLAN: Only push previously-studied items that are due =====
function generateDailyPlan(parsedItems, parsedAITerms, parsedLogs, today) {
  const studiedItemIds = new Set();
  const studiedTermIds = new Set();
  parsedLogs.forEach(l => {
    l.studyItemIds.forEach(id => studiedItemIds.add(id));
    l.aiTermIds.forEach(id => studiedTermIds.add(id));
  });

  // Only push items that have been reviewed before AND are due
  const dueStudyItems = parsedItems.filter(item => {
    if (!item.redoDate || item.redoDate > today) return false;
    return studiedItemIds.has(item.id) || item.timeSpent > 0;
  });

  const dueAITerms = parsedAITerms.filter(term => {
    if (!term.redoDate || term.redoDate > today) return false;
    return studiedTermIds.has(term.id);
  });

  // Sort by priority then mastery
  const sortFn = (a, b) => {
    const d = priorityOrder(a.priority) - priorityOrder(b.priority);
    if (d !== 0) return d;
    const m = { '🔴': 0, '🟡': 1, '🟢': 2 };
    return (m[a.mastery] ?? 3) - (m[b.mastery] ?? 3);
  };

  dueStudyItems.sort(sortFn);
  dueAITerms.sort(sortFn);

  const plan = [
    ...dueStudyItems.map(item => ({ ...item, queueType: 'review' })),
    ...dueAITerms.map(term => ({ ...term, queueType: 'review-term' })),
  ];

  const estimatedMinutes = plan.reduce((sum, item) => {
    if (item.source === 'aiTerm') return sum + 3;
    if (item.mastery === '🟢') return sum + 5;
    if (item.mastery === '🟡') return sum + 10;
    return sum + 15;
  }, 0);

  return {
    plan,
    reviewCount: dueStudyItems.length,
    termReviewCount: dueAITerms.length,
    totalCount: plan.length,
    estimatedMinutes,
  };
}

// ===== ICS CALENDAR =====
function generateICS(dailyPlan, today) {
  const now = todayJST();
  const isWE = now.getDay() === 0 || now.getDay() === 6;
  const plan = dailyPlan.plan || [];
  const events = [];

  if (isWE) {
    if (plan.length > 0) events.push({ summary: `🔄 復習 (${plan.length}題)`, desc: plan.map(i => `${i.subject}: ${i.name}`).join('\\n'), sh: 9, sm: 0, dur: Math.max(30, plan.length * 10) });
    events.push({ summary: '📝 ノート整理 + 打卡', desc: '', sh: 15, sm: 0, dur: 30 });
    events.push({ summary: '🔧 弱点復習', desc: '', sh: 16, sm: 0, dur: 60 });
  } else {
    events.push({ summary: '📖 通勤学習', desc: plan.slice(0, 3).map(i => `${i.subject}: ${i.name}`).join('\\n') || 'Dashboard確認', sh: 7, sm: 0, dur: 30 });
    events.push({ summary: '🔄 昼休み復習', desc: '', sh: 12, sm: 0, dur: 15 });
    if (plan.length > 0) events.push({ summary: `📚 集中学習 (${plan.length}題)`, desc: plan.map(i => `${i.subject}: ${i.name}`).join('\\n'), sh: 19, sm: 30, dur: Math.max(60, plan.length * 10) });
    events.push({ summary: '📝 Notion打卡', desc: '', sh: 21, sm: 30, dur: 15 });
  }

  const df = today.replace(/-/g, '');
  let ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//KyodaiStudy//Dashboard//JP','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:京大社情 Study Plan','X-WR-TIMEZONE:Asia/Tokyo','BEGIN:VTIMEZONE','TZID:Asia/Tokyo','BEGIN:STANDARD','DTSTART:19700101T000000','TZOFFSETFROM:+0900','TZOFFSETTO:+0900','END:STANDARD','END:VTIMEZONE'];
  events.forEach((e, i) => {
    const sh = String(e.sh).padStart(2,'0'), sm = String(e.sm).padStart(2,'0');
    const et = e.sh * 60 + e.sm + e.dur;
    const eh = String(Math.floor(et/60)).padStart(2,'0'), em = String(et%60).padStart(2,'0');
    ics.push('BEGIN:VEVENT',`UID:study-${df}-${i}@kyodai`,`DTSTART;TZID=Asia/Tokyo:${df}T${sh}${sm}00`,`DTEND;TZID=Asia/Tokyo:${df}T${eh}${em}00`,`SUMMARY:${e.summary}`,`DESCRIPTION:${(e.desc || '').replace(/\n/g, '\\n')}`,`BEGIN:VALARM`,`TRIGGER:-PT10M`,`ACTION:DISPLAY`,`DESCRIPTION:${e.summary}`,`END:VALARM`,'END:VEVENT');
  });
  ics.push('END:VCALENDAR');
  return ics.join('\r\n');
}

// ===== GET ALL =====
async function getAll() {
  const today = dateStrJST();
  const queries = [
    queryAll(DB_2026),
    queryAll(DB_LOG, undefined, [{ property: 'Review Date', direction: 'descending' }]),
    queryAll(DB_CHECKIN, undefined, [{ property: 'Date', direction: 'descending' }]),
  ];
  // AI Term DB is optional (env var may not be set yet)
  if (DB_AI_TERM) queries.push(queryAll(DB_AI_TERM));
  else queries.push(Promise.resolve([]));

  const [items, logs, checkins, aiTerms] = await Promise.all(queries);

  const parsedItems = items.map(parseStudyItem);
  const parsedAITerms = aiTerms.map(parseAITerm);
  const parsedLogs = logs.map(parseLog).filter(l => l.reviewDate && l.reviewDate <= today);
  const parsedCheckins = checkins.map(parseCheckin).filter(c => c.date && c.date <= today && (c.minutes > 0 || c.cs || c.ai || c.hci || c.se || c.ir));

  // Track which items/terms have been studied
  const studiedItemIds = new Set();
  const studiedTermIds = new Set();
  parsedLogs.forEach(l => {
    l.studyItemIds.forEach(id => studiedItemIds.add(id));
    l.aiTermIds.forEach(id => studiedTermIds.add(id));
  });

  // Mastery stats (2026 only)
  const masteryStats = { total: parsedItems.length, green: 0, yellow: 0, red: 0, notStudied: 0 };
  const subjectStats = {};
  parsedItems.forEach(item => {
    if (!subjectStats[item.subject]) subjectStats[item.subject] = { total: 0, green: 0, yellow: 0, red: 0, notStudied: 0 };
    subjectStats[item.subject].total++;
    const studied = studiedItemIds.has(item.id) || item.timeSpent > 0;
    if (item.mastery === '🟢' && studied) { masteryStats.green++; subjectStats[item.subject].green++; }
    else if (item.mastery === '🟡' && studied) { masteryStats.yellow++; subjectStats[item.subject].yellow++; }
    else if (item.mastery === '🔴' && studied) { masteryStats.red++; subjectStats[item.subject].red++; }
    else { masteryStats.notStudied++; subjectStats[item.subject].notStudied++; }
  });

  // AI term mastery stats
  const aiTermStats = { total: parsedAITerms.length, green: 0, yellow: 0, red: 0, notStudied: 0 };
  parsedAITerms.forEach(term => {
    const studied = studiedTermIds.has(term.id);
    if (term.mastery === '🟢' && studied) aiTermStats.green++;
    else if (term.mastery === '🟡' && studied) aiTermStats.yellow++;
    else if (term.mastery === '🔴' && studied) aiTermStats.red++;
    else aiTermStats.notStudied++;
  });

  // Daily plan: only previously-studied items that are due
  const dailyPlan = generateDailyPlan(parsedItems, parsedAITerms, parsedLogs, today);

  // Phase items
  const phaseItems = {};
  parsedCheckins.forEach(c => { if (c.phase) { if (!phaseItems[c.phase]) phaseItems[c.phase] = { count: 0, totalMinutes: 0 }; phaseItems[c.phase].count++; phaseItems[c.phase].totalMinutes += c.minutes; }});

  // Study dates & streak
  const studyDates = new Set();
  parsedLogs.forEach(l => { if (l.timeSpent > 0) studyDates.add(l.reviewDate); });
  parsedCheckins.forEach(c => { if (c.minutes > 0) studyDates.add(c.date); });

  let streak = 0; const sd = todayJST();
  if (studyDates.has(today)) { streak = 1; sd.setDate(sd.getDate() - 1); }
  while (true) {
    const ds = `${sd.getFullYear()}-${String(sd.getMonth()+1).padStart(2,'0')}-${String(sd.getDate()).padStart(2,'0')}`;
    if (studyDates.has(ds)) { streak++; sd.setDate(sd.getDate() - 1); } else break;
  }

  // FIX: Total hours from Review Logs ONLY (avoid double counting with Check-in)
  let totalMinutes = 0;
  parsedLogs.forEach(l => totalMinutes += l.timeSpent);

  const daysLeft = Math.ceil((new Date('2026-08-01T00:00:00+09:00') - todayJST()) / 864e5);

  // Heatmap
  const heatmap = {};
  parsedLogs.forEach(l => { if (l.reviewDate && l.timeSpent > 0) heatmap[l.reviewDate] = (heatmap[l.reviewDate]||0) + l.timeSpent; });

  // Today completed IDs
  const todayCompletedIds = [];
  parsedLogs.filter(l => l.reviewDate === today).forEach(l => {
    l.studyItemIds.forEach(id => todayCompletedIds.push(id));
    l.aiTermIds.forEach(id => todayCompletedIds.push(id));
  });

  // Group 2026 items by year for free selection
  const itemsByYear = {};
  parsedItems.forEach(item => {
    const yr = item.year || '未分類';
    if (!itemsByYear[yr]) itemsByYear[yr] = [];
    itemsByYear[yr].push(item);
  });

  // Group AI terms by Lec
  const termsByLec = {};
  parsedAITerms.forEach(term => {
    const lec = term.lec || '未分類';
    if (!termsByLec[lec]) termsByLec[lec] = [];
    termsByLec[lec].push(term);
  });

  return {
    items: parsedItems,
    aiTerms: parsedAITerms,
    logs: parsedLogs.slice(0, 30),
    checkins: parsedCheckins.slice(0, 60),
    masteryStats, subjectStats, aiTermStats,
    dailyPlan, phaseItems,
    streak,
    totalHours: Math.round(totalMinutes / 60 * 10) / 10,
    daysLeft, today, heatmap,
    studyDates: Array.from(studyDates),
    todayCompletedIds,
    itemsByYear, termsByLec,
  };
}

// ===== COMPLETE REVIEW (2026 study item) =====
async function completeReview({ studyItemId, studyItemName, subject, timeSpent, mastery, method, notes, startTime, endTime }) {
  const today = dateStrJST();
  const logProps = {
    Title: { title: [{ text: { content: studyItemName || `Review ${today}` } }] },
    'Review Date': { date: { start: today } },
  };
  if (mastery) logProps.Mastery = { select: { name: mastery } };
  if (method) logProps.Method = { select: { name: method } };
  if (notes) logProps.Notes = { rich_text: [{ text: { content: notes } }] };
  if (startTime) logProps['Start Time'] = { date: { start: startTime } };
  if (endTime) logProps['End Time'] = { date: { start: endTime } };
  if (studyItemId) logProps['Study Item'] = { relation: [{ id: studyItemId }] };

  const logPage = await notion.pages.create({ parent: { database_id: DB_LOG }, properties: logProps });

  // Update study item mastery + redo date
  if (studyItemId) {
    const up = {};
    if (mastery) {
      const mm = { '🟢 掌握': '🟢', '🟡 半熟': '🟡', '🔴 不会': '🔴' };
      if (mm[mastery]) up.Mastery = { select: { name: mm[mastery] } };
    }
    const nd = new Date(todayJST());
    if (mastery === '🟢 掌握') nd.setDate(nd.getDate() + 14);
    else if (mastery === '🟡 半熟') nd.setDate(nd.getDate() + 3);
    else nd.setDate(nd.getDate() + 1);
    up['Redo Date'] = { date: { start: `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-${String(nd.getDate()).padStart(2,'0')}` } };
    await notion.pages.update({ page_id: studyItemId, properties: up });
  }

  // FIX: Update checkin - only set subject checkbox, do NOT add minutes (avoids double counting)
  try {
    const ec = await notion.databases.query({ database_id: DB_CHECKIN, filter: { property: 'Date', date: { equals: today } } });
    if (ec.results.length > 0) {
      const up = {};
      if (subject) { const sm = { CS:'CS', AI:'AI', HCI:'HCI', SE:'SE', IR:'IR' }; if (sm[subject]) up[sm[subject]] = { checkbox: true }; }
      if (Object.keys(up).length > 0) await notion.pages.update({ page_id: ec.results[0].id, properties: up });
    } else {
      const np = {
        Name: { title: [{ text: { content: `Day ${today}` } }] },
        Date: { date: { start: today } },
        Minutes: { number: 0 },
        Phase: { select: { name: 'Phase 1 基础' } },
        'Day Type': { select: { name: new Date(today).getDay() % 6 === 0 ? '周末' : '工作日' } },
      };
      if (subject) { const sm = { CS:'CS', AI:'AI', HCI:'HCI', SE:'SE', IR:'IR' }; if (sm[subject]) np[sm[subject]] = { checkbox: true }; }
      await notion.pages.create({ parent: { database_id: DB_CHECKIN }, properties: np });
    }
  } catch (e) { console.error('Checkin error:', e.message); }

  return { success: true, logId: logPage.id };
}

// ===== COMPLETE AI TERM REVIEW =====
async function completeTermReview({ termId, termName, mastery, method, notes, startTime, endTime }) {
  const today = dateStrJST();
  const logProps = {
    Title: { title: [{ text: { content: termName || `Term Review ${today}` } }] },
    'Review Date': { date: { start: today } },
  };
  if (mastery) logProps.Mastery = { select: { name: mastery } };
  if (method) logProps.Method = { select: { name: method } };
  if (notes) logProps.Notes = { rich_text: [{ text: { content: notes } }] };
  if (startTime) logProps['Start Time'] = { date: { start: startTime } };
  if (endTime) logProps['End Time'] = { date: { start: endTime } };
  if (termId) logProps['AI Term'] = { relation: [{ id: termId }] };

  const logPage = await notion.pages.create({ parent: { database_id: DB_LOG }, properties: logProps });

  // Update AI term mastery + redo date
  if (termId) {
    const up = {};
    if (mastery) {
      const mm = { '🟢 掌握': '🟢', '🟡 半熟': '🟡', '🔴 不会': '🔴' };
      if (mm[mastery]) up.Mastery = { select: { name: mm[mastery] } };
    }
    const nd = new Date(todayJST());
    if (mastery === '🟢 掌握') nd.setDate(nd.getDate() + 14);
    else if (mastery === '🟡 半熟') nd.setDate(nd.getDate() + 3);
    else nd.setDate(nd.getDate() + 1);
    up['Redo Date'] = { date: { start: `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-${String(nd.getDate()).padStart(2,'0')}` } };
    await notion.pages.update({ page_id: termId, properties: up });
  }

  // Update checkin AI checkbox
  try {
    const ec = await notion.databases.query({ database_id: DB_CHECKIN, filter: { property: 'Date', date: { equals: today } } });
    if (ec.results.length > 0) {
      await notion.pages.update({ page_id: ec.results[0].id, properties: { AI: { checkbox: true } } });
    } else {
      await notion.pages.create({ parent: { database_id: DB_CHECKIN }, properties: {
        Name: { title: [{ text: { content: `Day ${today}` } }] },
        Date: { date: { start: today } }, Minutes: { number: 0 },
        Phase: { select: { name: 'Phase 1 基础' } },
        'Day Type': { select: { name: new Date(today).getDay() % 6 === 0 ? '周末' : '工作日' } },
        AI: { checkbox: true },
      }});
    }
  } catch (e) { console.error('Checkin error:', e.message); }

  return { success: true, logId: logPage.id };
}

// ===== COMPLETE READING SESSION =====
async function completeReading({ bookName, subject, startTime, endTime, notes }) {
  const today = dateStrJST();
  let mins = 0;
  if (startTime && endTime) {
    const diff = new Date(endTime) - new Date(startTime);
    if (diff > 0) mins = Math.round(diff / 60000);
  }

  const logProps = {
    Title: { title: [{ text: { content: `📖 ${bookName || 'Reading'}` } }] },
    'Review Date': { date: { start: today } },
    Method: { select: { name: '📖 通读' } },
  };
  if (startTime) logProps['Start Time'] = { date: { start: startTime } };
  if (endTime) logProps['End Time'] = { date: { start: endTime } };
  if (notes) logProps.Notes = { rich_text: [{ text: { content: notes } }] };

  const logPage = await notion.pages.create({ parent: { database_id: DB_LOG }, properties: logProps });

  // Update checkin
  try {
    const ec = await notion.databases.query({ database_id: DB_CHECKIN, filter: { property: 'Date', date: { equals: today } } });
    const sm = { CS:'CS', AI:'AI', HCI:'HCI', SE:'SE', IR:'IR' };
    if (ec.results.length > 0) {
      const up = {};
      if (subject && sm[subject]) up[sm[subject]] = { checkbox: true };
      if (Object.keys(up).length > 0) await notion.pages.update({ page_id: ec.results[0].id, properties: up });
    } else {
      const np = {
        Name: { title: [{ text: { content: `Day ${today}` } }] },
        Date: { date: { start: today } }, Minutes: { number: 0 },
        Phase: { select: { name: 'Phase 1 基础' } },
        'Day Type': { select: { name: new Date(today).getDay() % 6 === 0 ? '周末' : '工作日' } },
      };
      if (subject && sm[subject]) np[sm[subject]] = { checkbox: true };
      await notion.pages.create({ parent: { database_id: DB_CHECKIN }, properties: np });
    }
  } catch (e) { console.error('Checkin error:', e.message); }

  return { success: true, logId: logPage.id };
}

// ===== VERCEL HANDLER =====
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const { action } = req.query;
    if (action === 'getAll') return res.status(200).json(await getAll());
    if (action === 'complete-review' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      return res.status(200).json(await completeReview(body));
    }
    if (action === 'complete-term-review' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      return res.status(200).json(await completeTermReview(body));
    }
    if (action === 'complete-reading' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      return res.status(200).json(await completeReading(body));
    }
    if (action === 'ics' || action === 'calendar.ics') {
      const data = await getAll();
      const ics = generateICS(data.dailyPlan, data.today);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="study-plan.ics"');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(200).send(ics);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) { console.error('API Error:', err); return res.status(500).json({ error: err.message }); }
};
