const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_2026 = process.env.DB_2026;
const DB_LOG = process.env.DB_LOG;
const DB_CHECKIN = process.env.DB_CHECKIN;

function todayJST() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })); }
function dateStrJST() { const d = todayJST(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

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

function parseStudyItem(p) {
  const props = p.properties;
  return { id: p.id, name: props.Name?.title?.[0]?.plain_text || '', subject: props.Subject?.select?.name || '', type: props.Type?.select?.name || '', mastery: props.Mastery?.select?.name || '', priority: props.Priority?.select?.name || '', chapter: props.Chapter?.select?.name || '', year: props.Year?.select?.name || '', difficulty: props.Difficulty?.select?.name || '', redoDate: props['Redo Date']?.date?.start || '', note: props.Note?.rich_text?.[0]?.plain_text || '', relatedKnowledge: props['Related Knowledge']?.rich_text?.[0]?.plain_text || '', timeSpent: props['Time Spent']?.number || 0, num: props.Num?.rich_text?.[0]?.plain_text || '' };
}
function parseLog(p) {
  const props = p.properties;
  return { id: p.id, title: props.Title?.title?.[0]?.plain_text || '', subject: props.Subject?.rollup?.array?.[0]?.select?.name || '', mastery: props.Mastery?.select?.name || '', method: props.Method?.select?.name || '', timeSpent: props['Time Spent (min)']?.number || 0, reviewDate: props['Review Date']?.date?.start || '', startTime: props['Start Time']?.date?.start || '', endTime: props['End Time']?.date?.start || '', notes: props.Notes?.rich_text?.[0]?.plain_text || '', studyItemIds: (props['Study Item']?.relation || []).map(r => r.id) };
}
function parseCheckin(p) {
  const props = p.properties;
  return { id: p.id, name: props.Name?.title?.[0]?.plain_text || '', date: props.Date?.date?.start || '', minutes: props.Minutes?.number || 0, phase: props.Phase?.select?.name || '', mood: props.Mood?.select?.name || '', satisfaction: props.Satisfaction?.select?.name || '', dayType: props['Day Type']?.select?.name || '', whatIDid: props['What I Did']?.rich_text?.[0]?.plain_text || '', pomodoros: props.Pomodoros?.number || 0, cs: props.CS?.checkbox || false, ai: props.AI?.checkbox || false, hci: props.HCI?.checkbox || false, se: props.SE?.checkbox || false, ir: props.IR?.checkbox || false, earlyRise: props['早起']?.checkbox || false, earlySleep: props['早睡']?.checkbox || false, exercise: props['运动']?.checkbox || false, reading: props['阅读']?.checkbox || false, meditation: props['冥想']?.checkbox || false, noTakeout: props['不点外卖']?.checkbox || false };
}

function priorityOrder(pri) {
  if (!pri) return 4;
  if (pri.includes('S')) return 0;
  if (pri.includes('A')) return 1;
  if (pri.includes('B')) return 2;
  if (pri.includes('C')) return 3;
  return 4;
}

function generateDailyPlan(parsedItems, parsedLogs, today) {
  const now = todayJST();
  const dow = now.getDay();
  const isWeekend = dow === 0 || dow === 6;

  // Items that have actual study logs
  const studiedIds = new Set();
  parsedLogs.forEach(l => l.studyItemIds.forEach(id => studiedIds.add(id)));

  // 1. Review: items with logs AND redoDate <= today
  const reviewItems = parsedItems.filter(item => {
    if (!item.redoDate || item.redoDate > today) return false;
    return studiedIds.has(item.id) || item.timeSpent > 0;
  });

  // 2. New: items never studied (even if they have pre-set Redo Dates)
  const unstudied = parsedItems.filter(item => {
    if (studiedIds.has(item.id) || item.timeSpent > 0) return false;
    if (!item.name) return false;
    return true;
  });

  unstudied.sort((a, b) => {
    const pa = priorityOrder(a.priority), pb = priorityOrder(b.priority);
    if (pa !== pb) return pa - pb;
    return (a.subject || '').localeCompare(b.subject || '');
  });

  const dailyNewTarget = isWeekend ? 10 : 6;
  const maxReview = isWeekend ? 15 : 10;

  // Subject-balanced round-robin
  const buckets = {};
  unstudied.forEach(item => {
    const sub = item.subject || 'Other';
    if (!buckets[sub]) buckets[sub] = [];
    buckets[sub].push(item);
  });
  const newItems = [];
  const subs = Object.keys(buckets);
  let round = 0;
  while (newItems.length < dailyNewTarget && round < 50) {
    let added = false;
    for (const sub of subs) {
      if (newItems.length >= dailyNewTarget) break;
      if (buckets[sub].length > 0) { newItems.push(buckets[sub].shift()); added = true; }
    }
    if (!added) break;
    round++;
  }

  // If total is too low, add more new items
  const minTotal = isWeekend ? 12 : 8;
  if (reviewItems.length + newItems.length < minTotal) {
    const selectedIds = new Set(newItems.map(i => i.id));
    const more = unstudied.filter(i => !selectedIds.has(i.id)).slice(0, minTotal - reviewItems.length - newItems.length);
    newItems.push(...more);
  }

  const cappedReviews = reviewItems.sort((a, b) => {
    const pa = priorityOrder(a.priority), pb = priorityOrder(b.priority);
    if (pa !== pb) return pa - pb;
    const m = { '🔴': 0, '🟡': 1, '🟢': 2 };
    return (m[a.mastery] ?? 3) - (m[b.mastery] ?? 3);
  }).slice(0, maxReview);

  const plan = [
    ...cappedReviews.map(item => ({ ...item, queueType: 'review' })),
    ...newItems.map(item => ({ ...item, queueType: 'new' })),
  ];

  const estimatedMinutes = plan.reduce((sum, item) => {
    if (item.queueType === 'review') {
      if (item.mastery === '🟢') return sum + 5;
      if (item.mastery === '🟡') return sum + 10;
      return sum + 15;
    }
    return sum + 15;
  }, 0);

  return { plan, reviewCount: cappedReviews.length, newCount: newItems.length, totalCount: plan.length, estimatedMinutes, isWeekend, unstudiedRemaining: unstudied.length - newItems.length };
}

// ===== ICS Calendar Feed =====
function generateICS(dailyPlan, today) {
  const now = todayJST();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const reviewItems = dailyPlan.plan.filter(i => i.queueType === 'review');
  const newItems = dailyPlan.plan.filter(i => i.queueType === 'new');
  const events = [];

  if (isWeekend) {
    if (reviewItems.length > 0) events.push({ summary: `🔄 復習 (${reviewItems.length}題)`, desc: reviewItems.map(i => `- ${i.subject}: ${i.name}`).join('\\n'), sh: 9, sm: 0, dur: Math.max(30, reviewItems.length * 12) });
    if (newItems.length > 0) events.push({ summary: `🆕 新規学習 (${newItems.length}題)`, desc: newItems.map(i => `- ${i.subject}: ${i.name}`).join('\\n'), sh: reviewItems.length > 0 ? 11 : 9, sm: 0, dur: Math.max(30, newItems.length * 15) });
    events.push({ summary: '📝 ノート整理 + 打卡', desc: '', sh: 15, sm: 0, dur: 30 });
    events.push({ summary: '🔧 弱点復習', desc: '', sh: 16, sm: 0, dur: 60 });
  } else {
    events.push({ summary: '📖 通勤学習', desc: reviewItems.slice(0, 3).map(i => `- ${i.subject}: ${i.name}`).join('\\n') || '復習タスク確認', sh: 7, sm: 0, dur: 30 });
    events.push({ summary: '🔄 昼休み復習', desc: '', sh: 12, sm: 0, dur: 15 });
    if (dailyPlan.plan.length > 0) events.push({ summary: `📚 集中学習 (${dailyPlan.totalCount}題)`, desc: dailyPlan.plan.map(i => `[${i.queueType === 'new' ? 'NEW' : '復習'}] ${i.subject}: ${i.name}`).join('\\n'), sh: 19, sm: 30, dur: Math.max(60, dailyPlan.totalCount * 10) });
    events.push({ summary: '📝 Notion打卡', desc: '', sh: 21, sm: 30, dur: 15 });
  }

  const df = today.replace(/-/g, '');
  let ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//KyodaiStudy//Dashboard//JP','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:京大社情 Study Plan','X-WR-TIMEZONE:Asia/Tokyo','BEGIN:VTIMEZONE','TZID:Asia/Tokyo','BEGIN:STANDARD','DTSTART:19700101T000000','TZOFFSETFROM:+0900','TZOFFSETTO:+0900','END:STANDARD','END:VTIMEZONE'];
  events.forEach((e, i) => {
    const sh = String(e.sh).padStart(2,'0'), sm = String(e.sm).padStart(2,'0');
    const et = e.sh * 60 + e.sm + e.dur;
    const eh = String(Math.floor(et/60)).padStart(2,'0'), em = String(et%60).padStart(2,'0');
    ics.push('BEGIN:VEVENT',`UID:study-${df}-${i}@kyodai`,`DTSTART;TZID=Asia/Tokyo:${df}T${sh}${sm}00`,`DTEND;TZID=Asia/Tokyo:${df}T${eh}${em}00`,`SUMMARY:${e.summary}`,`DESCRIPTION:${e.desc || ''}`,`BEGIN:VALARM`,`TRIGGER:-PT10M`,`ACTION:DISPLAY`,`DESCRIPTION:${e.summary}`,`END:VALARM`,'END:VEVENT');
  });
  ics.push('END:VCALENDAR');
  return ics.join('\r\n');
}

async function getAll() {
  const today = dateStrJST();
  const [items, logs, checkins] = await Promise.all([
    queryAll(DB_2026),
    queryAll(DB_LOG, undefined, [{ property: 'Review Date', direction: 'descending' }]),
    queryAll(DB_CHECKIN, undefined, [{ property: 'Date', direction: 'descending' }]),
  ]);
  const parsedItems = items.map(parseStudyItem);
  const parsedLogs = logs.map(parseLog).filter(l => l.reviewDate && l.reviewDate <= today);
  const parsedCheckins = checkins.map(parseCheckin).filter(c => c.date && c.date <= today && (c.minutes > 0 || c.cs || c.ai || c.hci || c.se || c.ir));

  const itemsWithLogs = new Set();
  parsedLogs.forEach(l => l.studyItemIds.forEach(id => itemsWithLogs.add(id)));

  const masteryStats = { total: parsedItems.length, green: 0, yellow: 0, red: 0, notStudied: 0 };
  const subjectStats = {};
  parsedItems.forEach(item => {
    if (!subjectStats[item.subject]) subjectStats[item.subject] = { total: 0, green: 0, yellow: 0, red: 0, notStudied: 0 };
    subjectStats[item.subject].total++;
    const studied = itemsWithLogs.has(item.id) || item.timeSpent > 0;
    if (item.mastery === '🟢' && studied) { masteryStats.green++; subjectStats[item.subject].green++; }
    else if (item.mastery === '🟡' && studied) { masteryStats.yellow++; subjectStats[item.subject].yellow++; }
    else if (item.mastery === '🔴' && studied) { masteryStats.red++; subjectStats[item.subject].red++; }
    else { masteryStats.notStudied++; subjectStats[item.subject].notStudied++; }
  });

  const dueToday = parsedItems.filter(i => i.redoDate && i.redoDate <= today).sort((a, b) => {
    const po = { '🔴 S 必须掌握': 0, '🟠 A 重要': 1, '🟡 B 建议学': 2, '🟢 C 了解即可': 3 };
    const d = (po[a.priority]??4) - (po[b.priority]??4);
    if (d !== 0) return d;
    const m = { '🔴': 0, '🟡': 1, '🟢': 2 };
    return (m[a.mastery]??3) - (m[b.mastery]??3);
  });

  const dailyPlan = generateDailyPlan(parsedItems, parsedLogs, today);

  const phaseItems = {};
  parsedCheckins.forEach(c => { if (c.phase) { if (!phaseItems[c.phase]) phaseItems[c.phase] = { count: 0, totalMinutes: 0 }; phaseItems[c.phase].count++; phaseItems[c.phase].totalMinutes += c.minutes; }});

  const studyDates = new Set();
  parsedCheckins.forEach(c => { if (c.minutes > 0) studyDates.add(c.date); });
  parsedLogs.forEach(l => { if (l.timeSpent > 0) studyDates.add(l.reviewDate); });

  let streak = 0; const sd = todayJST();
  if (studyDates.has(today)) { streak = 1; sd.setDate(sd.getDate() - 1); }
  while (true) {
    const ds = `${sd.getFullYear()}-${String(sd.getMonth()+1).padStart(2,'0')}-${String(sd.getDate()).padStart(2,'0')}`;
    if (studyDates.has(ds)) { streak++; sd.setDate(sd.getDate() - 1); } else break;
  }

  let totalMinutes = 0;
  parsedCheckins.forEach(c => totalMinutes += c.minutes);
  parsedLogs.forEach(l => totalMinutes += l.timeSpent);

  const daysLeft = Math.ceil((new Date('2026-08-01T00:00:00+09:00') - todayJST()) / 864e5);

  const heatmap = {};
  parsedCheckins.forEach(c => { if (c.date && c.minutes > 0) heatmap[c.date] = (heatmap[c.date]||0) + c.minutes; });
  parsedLogs.forEach(l => { if (l.reviewDate && l.timeSpent > 0) heatmap[l.reviewDate] = (heatmap[l.reviewDate]||0) + l.timeSpent; });

  const todayCompletedIds = [];
  parsedLogs.filter(l => l.reviewDate === today).forEach(l => l.studyItemIds.forEach(id => todayCompletedIds.push(id)));

  return { items: parsedItems, logs: parsedLogs.slice(0, 20), checkins: parsedCheckins.slice(0, 60), masteryStats, subjectStats, dueToday, dailyPlan, phaseItems, streak, totalHours: Math.round(totalMinutes / 60 * 10) / 10, daysLeft, today, heatmap, studyDates: Array.from(studyDates), todayCompletedIds };
}

async function completeReview({ studyItemId, studyItemName, subject, timeSpent, mastery, method, notes, startTime, endTime }) {
  const today = dateStrJST();
  const logProps = { Title: { title: [{ text: { content: studyItemName || `Review ${today}` } }] }, 'Review Date': { date: { start: today } }, 'Time Spent (min)': { number: timeSpent || 0 } };
  if (mastery) logProps.Mastery = { select: { name: mastery } };
  if (method) logProps.Method = { select: { name: method } };
  if (notes) logProps.Notes = { rich_text: [{ text: { content: notes } }] };
  if (startTime) logProps['Start Time'] = { date: { start: startTime } };
  if (endTime) logProps['End Time'] = { date: { start: endTime } };
  if (studyItemId) logProps['Study Item'] = { relation: [{ id: studyItemId }] };
  const logPage = await notion.pages.create({ parent: { database_id: DB_LOG }, properties: logProps });

  if (studyItemId) {
    const up = {};
    if (mastery) { const mm = { '🟢 掌握': '🟢', '🟡 半熟': '🟡', '🔴 不会': '🔴' }; if (mm[mastery]) up.Mastery = { select: { name: mm[mastery] } }; }
    const nd = new Date(todayJST());
    if (mastery === '🟢 掌握') nd.setDate(nd.getDate() + 14);
    else if (mastery === '🟡 半熟') nd.setDate(nd.getDate() + 3);
    else nd.setDate(nd.getDate() + 1);
    up['Redo Date'] = { date: { start: `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-${String(nd.getDate()).padStart(2,'0')}` } };
    await notion.pages.update({ page_id: studyItemId, properties: up });
  }

  try {
    const ec = await notion.databases.query({ database_id: DB_CHECKIN, filter: { property: 'Date', date: { equals: today } } });
    if (ec.results.length > 0) {
      const ex = ec.results[0]; const cm = ex.properties.Minutes?.number || 0;
      const up = { Minutes: { number: cm + (timeSpent || 0) } };
      if (subject) { const sm = { CS:'CS', AI:'AI', HCI:'HCI', SE:'SE', IR:'IR' }; if (sm[subject]) up[sm[subject]] = { checkbox: true }; }
      await notion.pages.update({ page_id: ex.id, properties: up });
    } else {
      const np = { Name: { title: [{ text: { content: `Day ${today}` } }] }, Date: { date: { start: today } }, Minutes: { number: timeSpent || 0 }, Phase: { select: { name: 'Phase 1 基础' } }, 'Day Type': { select: { name: new Date(today).getDay() % 6 === 0 ? '周末' : '工作日' } } };
      if (subject) { const sm = { CS:'CS', AI:'AI', HCI:'HCI', SE:'SE', IR:'IR' }; if (sm[subject]) np[sm[subject]] = { checkbox: true }; }
      await notion.pages.create({ parent: { database_id: DB_CHECKIN }, properties: np });
    }
  } catch (e) { console.error('Checkin error:', e.message); }

  return { success: true, logId: logPage.id };
}

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
    if (action === 'ics' || action === 'calendar.ics') {
      const data = await getAll();
      const ics = generateICS(data.dailyPlan, data.today);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="study-plan.ics"');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(200).send(ics);
    }
    return res.status(400).json({ error: 'Use ?action=getAll, ?action=complete-review, or ?action=ics' });
  } catch (err) { console.error('API Error:', err); return res.status(500).json({ error: err.message }); }
};
