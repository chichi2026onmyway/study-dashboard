const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_2026 = process.env.DB_2026;
const DB_LOG = process.env.DB_LOG;
const DB_CHECKIN = process.env.DB_CHECKIN;
const EXAM_DATE = "2026-08-01";

const WEEKDAY_SUBJECTS = {
  0: ["CS"], 1: ["CS"], 2: ["AI"], 3: ["HCI"],
  4: ["SE"], 5: ["CS"], 6: ["IR", "CS"],
};
const DAILY_LIMIT_WEEKDAY = 3;
const DAILY_LIMIT_WEEKEND = 5;
const PRIORITY_ORDER = {
  "\ud83d\udd34 S 必须掌握": 0, "\ud83d\udfe0 A 重要": 1,
  "\ud83d\udfe1 B 建议学": 2, "\ud83d\udfe2 C 了解即可": 3,
};

function todayJST() {
  return new Date(Date.now() + 9 * 3600000).toISOString().split("T")[0];
}
function getDowJST() {
  return new Date(Date.now() + 9 * 3600000).getUTCDay();
}
function daysUntilExam() {
  return Math.ceil((new Date(EXAM_DATE) - new Date(todayJST())) / 86400000);
}

async function notionFetch(endpoint, body, method) {
  const res = await fetch("https://api.notion.com/v1" + endpoint, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      Authorization: "Bearer " + NOTION_TOKEN,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function fetchAllItems() {
  const items = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const r = await notionFetch("/databases/" + DB_2026 + "/query", {
      start_cursor: cursor, page_size: 100,
    });
    if (!r.results) break;
    items.push(...r.results);
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return items;
}

function hasBeenStudied(props) {
  return (props["Review Count"]?.rollup?.number || 0) > 0
    || !!props["Last Reviewed"]?.rollup?.date?.start;
}

function extractItem(item) {
  const p = item.properties;
  return {
    id: item.id,
    name: p.Name?.title?.[0]?.plain_text || "Untitled",
    subject: p.Subject?.select?.name || "",
    mastery: p.Mastery?.select?.name || "",
    type: p.Type?.select?.name || "",
    priority: p.Priority?.select?.name || "",
    url: item.url,
    isReview: hasBeenStudied(p),
  };
}

function buildSummary(items) {
  const bySubject = {};
  let totalGreen = 0, totalReviewed = 0;
  for (const item of items) {
    const p = item.properties;
    const s = p.Subject?.select?.name || "Unknown";
    const m = p.Mastery?.select?.name || "";
    if (!bySubject[s]) bySubject[s] = { total:0,green:0,yellow:0,red:0,none:0,reviewed:0 };
    bySubject[s].total++;
    if (hasBeenStudied(p)) { bySubject[s].reviewed++; totalReviewed++; }
    if (m==="\ud83d\udfe2") { bySubject[s].green++; totalGreen++; }
    else if (m==="\ud83d\udfe1") bySubject[s].yellow++;
    else if (m==="\ud83d\udd34") bySubject[s].red++;
    else bySubject[s].none++;
  }
  return { totalItems:items.length, totalGreen, totalReviewed, bySubject, daysUntilExam:daysUntilExam() };
}

function filterDueItems(items, todayStr) {
  return items
    .filter(item => {
      const p = item.properties;
      if (p.Mastery?.select?.name === "\ud83d\udfe2") return false;
      const rd = p["Redo Date"]?.date?.start;
      const ar = p["Auto Redo"]?.formula?.date?.start?.split("T")[0];
      const eff = rd || ar;
      if (!eff) return false;
      return eff <= todayStr;
    })
    .map(extractItem)
    .sort((a,b) => (PRIORITY_ORDER[a.priority]??4) - (PRIORITY_ORDER[b.priority]??4))
    .slice(0, 20);
}

// ===== 自动排题 =====
async function assignDaily() {
  const todayStr = todayJST();
  const dow = getDowJST();
  const subjects = WEEKDAY_SUBJECTS[dow] || ["CS"];
  const isWE = dow === 0 || dow === 6;
  const limit = isWE ? DAILY_LIMIT_WEEKEND : DAILY_LIMIT_WEEKDAY;
  const items = await fetchAllItems();

  const alreadyDue = filterDueItems(items, todayStr);
  const dueIds = new Set(alreadyDue.map(i => i.id));

  const candidates = items.filter(item => {
    const p = item.properties;
    if (dueIds.has(item.id)) return false;
    if (p.Mastery?.select?.name === "\ud83d\udfe2") return false;
    if (!subjects.includes(p.Subject?.select?.name)) return false;
    if (hasBeenStudied(p)) return false;
    if (p["Redo Date"]?.date?.start) return false;
    return true;
  });

  candidates.sort((a,b) => {
    const pa = PRIORITY_ORDER[a.properties.Priority?.select?.name] ?? 4;
    const pb = PRIORITY_ORDER[b.properties.Priority?.select?.name] ?? 4;
    if (pa !== pb) return pa - pb;
    const ta = a.properties.Type?.select?.name === "知识点" ? 0 : 1;
    const tb = b.properties.Type?.select?.name === "知识点" ? 0 : 1;
    return ta - tb;
  });

  const needed = Math.max(0, limit - alreadyDue.length);
  const toAssign = candidates.slice(0, needed);
  const assigned = [];

  for (const item of toAssign) {
    try {
      await notionFetch("/pages/" + item.id, {
        properties: { "Redo Date": { date: { start: todayStr } } },
      }, "PATCH");
      assigned.push(extractItem(item));
    } catch (e) {
      console.error("assign fail:", item.id, e.message);
    }
  }

  return {
    today: todayStr,
    dayOfWeek: ["日","月","火","水","木","金","土"][dow],
    subjects, limit,
    alreadyDueCount: alreadyDue.length,
    newlyAssigned: assigned.length,
    totalForToday: alreadyDue.length + assigned.length,
    assigned,
  };
}

// ===== 完成复习 =====
async function completeReview(data) {
  const { pageId, mastery } = data;
  if (!pageId || !mastery) return { success:false, error:"Missing pageId or mastery" };
  const todayStr = todayJST();
  const intervals = { "\ud83d\udd34":1, "\ud83d\udfe1":3, "\ud83d\udfe2":0 };
  const days = intervals[mastery] ?? 3;
  const updates = { Mastery: { select: { name: mastery } } };
  if (mastery === "\ud83d\udfe2") {
    updates["Redo Date"] = { date: null };
  } else {
    const nd = new Date(todayStr);
    nd.setDate(nd.getDate() + days);
    updates["Redo Date"] = { date: { start: nd.toISOString().split("T")[0] } };
  }
  try {
    await notionFetch("/pages/" + pageId, { properties: updates }, "PATCH");
    return { success:true, mastery, nextRedoDate: updates["Redo Date"]?.date?.start || null };
  } catch (e) {
    return { success:false, error:e.message };
  }
}

// ===== ICS 日历生成 (方案2: 订阅源) =====
async function generateICS() {
  const todayStr = todayJST();
  const dow = getDowJST();
  const isWE = dow===0||dow===6;
  const startH = isWE ? 9 : 19;
  const slotM = isWE ? 25 : 15;
  const items = await fetchAllItems();
  const due = filterDueItems(items, todayStr);
  const iconMap = {CS:"CS",AI:"AI",HCI:"HCI",SE:"SE",IR:"IR"};

  function evt(item, dateStr, sh, idx, sm) {
    const h1=sh+Math.floor(idx*sm/60), m1=(idx*sm)%60;
    const h2=sh+Math.floor((idx+1)*sm/60), m2=((idx+1)*sm)%60;
    const ds=dateStr.replace(/-/g,"");
    const pad=n=>String(n).padStart(2,"0");
    return "BEGIN:VEVENT\r\n"
      +"DTSTART;TZID=Asia/Tokyo:"+ds+"T"+pad(h1)+pad(m1)+"00\r\n"
      +"DTEND;TZID=Asia/Tokyo:"+ds+"T"+pad(h2)+pad(m2)+"00\r\n"
      +"SUMMARY:"+item.subject+": "+item.name+"\r\n"
      +"DESCRIPTION:Priority: "+item.priority+"\\nType: "+item.type+"\r\n"
      +"UID:study-"+item.id+"-"+dateStr+"@dashboard\r\n"
      +"STATUS:CONFIRMED\r\n"
      +"BEGIN:VALARM\r\nTRIGGER:-PT5M\r\nACTION:DISPLAY\r\nDESCRIPTION:Study time\r\nEND:VALARM\r\n"
      +"END:VEVENT";
  }

  const events = due.map((item,i)=>evt(item,todayStr,startH,i,slotM));

  // 未来7天到期的
  for (let d=1; d<=7; d++) {
    const fd = new Date(todayStr);
    fd.setDate(fd.getDate()+d);
    const fs = fd.toISOString().split("T")[0];
    const fDow = fd.getDay();
    const fWE = fDow===0||fDow===6;
    const fSH = fWE?9:19, fSM = fWE?25:15;
    const fDue = items.filter(item => {
      const rd = item.properties["Redo Date"]?.date?.start;
      return rd === fs && item.properties.Mastery?.select?.name !== "\ud83d\udfe2";
    }).map(extractItem).slice(0,8);
    fDue.forEach((item,i) => events.push(evt(item,fs,fSH,i,fSM)));
  }

  return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//StudyDashboard//EN\r\n"
    +"CALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n"
    +"X-WR-CALNAME:京大社情 Study Plan\r\nX-WR-TIMEZONE:Asia/Tokyo\r\n"
    +events.join("\r\n")+"\r\nEND:VCALENDAR";
}

async function getRecentLogs() {
  if (!DB_LOG) return { logs:[] };
  const r = await notionFetch("/databases/"+DB_LOG+"/query", {
    sorts:[{property:"Review Date",direction:"descending"}], page_size:50,
  });
  return { logs: (r.results||[]).map(item => {
    const p = item.properties;
    const title = p.Title?.title?.[0]?.plain_text||"";
    const mins = p["Duration (min)"]?.formula?.number || p["Time Spent (min)"]?.number || 0;
    let subj = p.Subject?.rollup?.array?.[0]?.select?.name||"";
    if(!subj){for(const s of["CS","AI","HCI","SE","IR"]){if(title.toUpperCase().includes(s)){subj=s;break;}}}
    return { title, date:(p["Review Date"]?.date?.start||"").split("T")[0], minutes:Math.round(mins), subject:subj, mastery:p.Mastery?.select?.name||"", method:p.Method?.select?.name||"" };
  })};
}

async function getCheckins() {
  if (!DB_CHECKIN) return { checkins:[] };
  const todayStr = todayJST();
  const all=[];
  let cursor;
  for(let i=0;i<3;i++){
    const r=await notionFetch("/databases/"+DB_CHECKIN+"/query",{sorts:[{property:"Date",direction:"descending"}],page_size:100,start_cursor:cursor});
    if(!r.results)break; all.push(...r.results); if(!r.has_more)break; cursor=r.next_cursor;
  }
  return { checkins: all.map(item=>{
    const p=item.properties;
    return{date:p.Date?.date?.start||"",minutes:p.Minutes?.number||0,mood:p.Mood?.select?.name||"",cs:p.CS?.checkbox||false,ai:p.AI?.checkbox||false,hci:p.HCI?.checkbox||false,se:p.SE?.checkbox||false,ir:p.IR?.checkbox||false};
  }).filter(c=>c.date<=todayStr&&c.minutes>0)};
}

async function createLog(data) {
  if(!DB_LOG) return{success:false,error:"DB_LOG not set"};
  const props = {
    Title:{title:[{text:{content:data.title||"复习记录"}}]},
    "Review Date":{date:{start:data.date}},
  };
  if(data.method) props.Method={select:{name:data.method}};
  if(data.minutes) props["Time Spent (min)"]={number:data.minutes};
  if(data.startTime) props["Start Time"]={date:{start:data.startTime}};
  if(data.endTime) props["End Time"]={date:{start:data.endTime}};
  try{
    const r=await notionFetch("/pages",{parent:{database_id:DB_LOG},properties:props});
    return{success:!!r.id,id:r.id,url:r.url};
  }catch(e){return{success:false,error:e.message};}
}

async function createCheckin(data) {
  if(!DB_CHECKIN) return{success:false,error:"DB_CHECKIN not set"};
  const props = {
    Name:{title:[{text:{content:data.name||data.date+" 打卡"}}]},
    Date:{date:{start:data.date}},
  };
  if(data.minutes!=null) props.Minutes={number:data.minutes};
  if(data.mood) props.Mood={select:{name:data.mood}};
  if(data.cs) props.CS={checkbox:true};
  if(data.ai) props.AI={checkbox:true};
  if(data.hci) props.HCI={checkbox:true};
  if(data.se) props.SE={checkbox:true};
  if(data.ir) props.IR={checkbox:true};
  try{
    const r=await notionFetch("/pages",{parent:{database_id:DB_CHECKIN},properties:props});
    return{success:!!r.id};
  }catch(e){return{success:false,error:e.message};}
}

async function getAll() {
  const items = await fetchAllItems();
  const todayStr = todayJST();
  const [logsRes,checkinsRes] = await Promise.all([getRecentLogs(),getCheckins()]);
  return {
    summary: buildSummary(items),
    dueItems: filterDueItems(items, todayStr),
    logs: logsRes.logs,
    checkins: checkinsRes.checkins,
  };
}

async function exportAnki(subject) {
  const all=[];let cursor;
  const filter=subject?{property:"Subject",select:{equals:subject}}:undefined;
  for(let i=0;i<10;i++){
    const r=await notionFetch("/databases/"+DB_2026+"/query",{start_cursor:cursor,page_size:100,filter});
    if(!r?.results)break;
    for(const pg of r.results){
      const p=pg.properties;
      const nm=p.Name?.title?.map(t=>t.plain_text).join("")||"";
      const nt=p.Note?.rich_text?.map(t=>t.plain_text).join("")||"";
      if(nm) all.push({front:nm,back:nt||"(no note)",tags:[p.Subject?.select?.name,p.Chapter?.select?.name,p.Type?.select?.name,p.Mastery?.select?.name].filter(Boolean).join(" ")});
    }
    if(!r.has_more)break; cursor=r.next_cursor;
  }
  return{count:all.length,data:all.map(i=>i.front+"\t"+i.back+"\t"+i.tags).join("\n")};
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(!NOTION_TOKEN) return res.status(500).json({error:"NOTION_TOKEN not set"});

  try{
    switch(req.query.action){
      case "ping": return res.json({ok:true});
      case "all": return res.json(await getAll());
      case "study-summary": return res.json(buildSummary(await fetchAllItems()));
      case "due-today": return res.json({items:filterDueItems(await fetchAllItems(),todayJST())});
      case "assign-daily": return res.json(await assignDaily());
      case "complete-review": return res.json(await completeReview(req.body));
      case "daily-ics":
        const ics=await generateICS();
        res.setHeader("Content-Type","text/calendar;charset=utf-8");
        res.setHeader("Content-Disposition",'attachment;filename="study-plan.ics"');
        return res.send(ics);
      case "recent-logs": return res.json(await getRecentLogs());
      case "checkins": return res.json(await getCheckins());
      case "create-log": return res.json(await createLog(req.body));
      case "create-checkin": return res.json(await createCheckin(req.body));
      case "anki-export":
        const s=req.query.subject||null;
        const d=await exportAnki(s);
        if(req.query.download==="1"){res.setHeader("Content-Type","text/tab-separated-values;charset=utf-8");return res.send(d.data);}
        return res.json(d);
      default: return res.status(400).json({error:"Unknown action"});
    }
  }catch(e){return res.status(500).json({error:e.message});}
};
