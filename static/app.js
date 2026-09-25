'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseDate = s => {if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;const [y,m,d]=s.split('-').map(Number);const v=new Date(y,m-1,d);return key(v)===s?v:null};
const addDays=(d,n)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
const dayDiff=(a,b)=>Math.round((Date.UTC(b.getFullYear(),b.getMonth(),b.getDate())-Date.UTC(a.getFullYear(),a.getMonth(),a.getDate()))/86400000);
const time=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const duration=m=>`${Math.floor(m/60)?Math.floor(m/60)+'h':''}${m%60?' '+m%60+'m':''}`.trim();
const longDate=d=>d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
const shortDate=d=>d.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
const monthName=d=>d.toLocaleDateString('en-GB',{month:'long',year:'numeric'});
const category = e => ['exam', 'partial', 'final'].includes(e.type) ? 'exam' : e.type;
const typeLabel = e => ({important:'Note / reminder',holiday:'Holiday',break:'Semester break',exam:'Exam',partial:'Partial exams',final:'Final exams'}[e.type]);
const APP_BUILD = document.querySelector('meta[name="app-build"]').content;
const DATA_KEY = 'semester-planner-published-v1';
let published, semester, SCHEDULE = [], academic, baseEvents = [];
let now=new Date(),selectedDate=addDays(now,0),calendarDate=addDays(now,0),shownMonth=new Date(now.getFullYear(),now.getMonth(),1),view='day';
let defaultGroup='',group='',editingId=null,undoEvents=null,toastTimer,months=[],pendingEnvelope=null;
let connected=false,storedOffline=false,offlineShell=false,checking=false,reg=null,pendingReload=false,reloadTarget='';
let defaultKey='',calendarKey='';
function validGroup(g){return !!semester?.groups.some(item=>item.id===g);}
function groupLabel(g=group){return semester?.groups.find(item=>item.id===g)?.label || g;}
function storageUnavailable(){$('storageNote').hidden=false;}
function readLocal(key,fallback){try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch(e){storageUnavailable();return fallback;}}
function writeLocal(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch(e){storageUnavailable();return false;}}
function toEvent(e,scope){return {id:scope+':'+e.id,name:e.title,type:e.type,start:e.start_date,end:e.end_date,notes:e.details||'',weekdaysOnly:!!e.weekdays_only,exclude:e.excluded_dates||[]};}
function validPersonal(e){return e && typeof e.id==='string' && typeof e.name==='string' && typeof e.notes==='string' && parseDate(e.start) && parseDate(e.end) && e.end>=e.start && ['important','holiday','break','exam','partial','final'].includes(e.type) && Array.isArray(e.exclude||[]) && (e.exclude||[]).every(d=>parseDate(d));}
function loadSemester(id, resetDate=false){
 semester=published.data.semesters.find(s=>s.id===id)||published.data.semesters.find(s=>s.id===published.data.active_semester_id);
 defaultKey='semester-planner-default:'+semester.id;
 calendarKey='semester-planner-personal:'+semester.id;
 const preferred=readLocal(defaultKey,null);
 defaultGroup=validGroup(preferred)?preferred:semester.default_group_id;
 group=defaultGroup;
 $('group').innerHTML=semester.groups.map(g=>`<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('');
 $('defaultGroup').innerHTML=$('group').innerHTML;
 $('group').value=group;
 $('semesterSelect').innerHTML=published.data.semesters.map(s=>`<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('');
 $('semesterSelect').value=semester.id;
 $('brandTitle').textContent=semester.title;
 $('footerSemester').textContent=semester.title;
 document.title=semester.title+' · Semester Planner';
 SCHEDULE=semester.sessions.map(s=>{const course=semester.courses.find(c=>c.id===s.course_id);return {...s,day:s.weekday%7,start:toMinutes(s.start_time),end:toMinutes(s.end_time),name:course.title,kind:course.kind,group:course.kind==='lab'?'lab':null};});
 baseEvents=[...published.data.calendar_events.map(e=>toEvent(e,'shared')),...semester.events.map(e=>toEvent(e,semester.id))];
 const edits=readLocal(calendarKey,{}), removed=Array.isArray(edits.removed)?edits.removed:[];
 const overrides=Array.isArray(edits.overrides)?edits.overrides.filter(validPersonal):[];
 const additions=Array.isArray(edits.added)?edits.added.filter(validPersonal):[];
 academic={start:semester.start_date,end:semester.end_date,events:[...baseEvents.filter(e=>!removed.includes(e.id)).map(e=>overrides.find(o=>o.id===e.id)||structuredClone(e)),...additions]};
 if(resetDate){selectedDate=key(now)>=semester.start_date&&key(now)<=semester.end_date?addDays(now,0):parseDate(semester.start_date);calendarDate=addDays(selectedDate,0);shownMonth=new Date(calendarDate.getFullYear(),calendarDate.getMonth(),1);}
 refreshMonths();
}
function persistCalendar(){
 const baseIds=new Set(baseEvents.map(e=>e.id)), currentIds=new Set(academic.events.map(e=>e.id));
 return writeLocal(calendarKey,{removed:baseEvents.filter(e=>!currentIds.has(e.id)).map(e=>e.id),overrides:academic.events.filter(e=>baseIds.has(e.id)&&JSON.stringify(e)!==JSON.stringify(baseEvents.find(b=>b.id===e.id))),added:academic.events.filter(e=>!baseIds.has(e.id))});
}
function toMinutes(value){const [h,m]=value.split(':').map(Number);return h*60+m;}
function occursOn(s,d){
 const date=key(d),start=s.start_date||semester.start_date,end=s.end_date||semester.end_date;
 if(date<start||date>end||(s.excluded_dates||[]).includes(date))return false;
 if((s.week_interval||1)>1){const weeks=Math.floor(dayDiff(monday(parseDate(s.anchor_date)),monday(d))/7);if(((weeks%s.week_interval)+s.week_interval)%s.week_interval!==0)return false;}
 return true;
}
function refreshMonths(){
 const values=new Set();
 const add=(start,end)=>{let d=new Date(parseDate(start).getFullYear(),parseDate(start).getMonth(),1),last=new Date(parseDate(end).getFullYear(),parseDate(end).getMonth(),1);while(d<=last){values.add(key(d).slice(0,7));d=new Date(d.getFullYear(),d.getMonth()+1,1);}};
 // Every month in a semester has academic meaning, even if it has no holiday.
 add(academic.start,academic.end);
 academic.events.forEach(e=>{let date=parseDate(e.start);while(key(date)<=e.end){if(eventIncludes(e,date))values.add(key(date).slice(0,7));date=addDays(date,1);}});
 months=[...values].sort();
 if(!months.includes(key(shownMonth).slice(0,7))){const todayMonth=key(now).slice(0,7);const closest=months.find(m=>m>=todayMonth)||months.at(-1);shownMonth=parseDate(closest+'-01');calendarDate=addDays(shownMonth,0);}
}
function validEnvelope(value){return value && Number.isInteger(value.revision) && value.data?.schema_version===1 && Array.isArray(value.data.semesters) && value.data.semesters.length && value.data.semesters.some(s=>s.id===value.data.active_semester_id);}
function applyEnvelope(envelope){
 const previous=semester?.id,oldActive=published?.data.active_semester_id,oldGroup=group;
 published=envelope;
 const target=previous&&previous!==oldActive&&envelope.data.semesters.some(s=>s.id===previous)?previous:envelope.data.active_semester_id;
 loadSemester(target,!!previous&&previous!==target);
 if(previous===target&&validGroup(oldGroup)){$('group').value=group=oldGroup;}
 render();
 $('loadingState').hidden=true;$('planner').hidden=false;
}
function updateSyncStatus(){
 const label=checking?'Checking for updates…':!connected?(published?'Offline · saved schedule':'Offline'):offlineShell&&storedOffline?'Up to date · Ready offline':'Up to date · Preparing offline…';
 $('syncStatus').textContent=label;
 if(connected&&(!('serviceWorker' in navigator)||!window.isSecureContext))$('syncStatus').textContent='Up to date · HTTPS needed for offline';
 if(connected&&!storedOffline)$('syncStatus').textContent='Up to date · Local saving unavailable';
}
async function refreshPublished(){
 if(checking)return;
 checking=true;updateSyncStatus();
 try{
  const response=await fetch('/api/dataset',{cache:'no-store',signal:AbortSignal.timeout(7000)});
  if(!response.ok)throw new Error('Server unavailable');
  const envelope=await response.json();if(!validEnvelope(envelope))throw new Error('Invalid schedule data');
  connected=true;
  if(envelope.build!==APP_BUILD){pendingReload=true;reloadTarget=envelope.build;reloadWhenSafe();return;}
  storedOffline=writeLocal(DATA_KEY,envelope);
  if(!published||published.revision!==envelope.revision){
   if(document.querySelector('dialog[open]'))pendingEnvelope=envelope;
   else applyEnvelope(envelope);
  }
 }catch(e){
  connected=false;
  if(!published){$('loadingMessage').textContent='Connect to the internet and open this app once to save your schedule for offline use.';$('retryLoad').hidden=false;}
 }finally{checking=false;updateSyncStatus();}
}
function reloadWhenSafe(){
 if(!pendingReload||document.querySelector('dialog[open]'))return;
 // A slow connection may fall back to the old shell; avoid a reload loop.
 try{if(sessionStorage.getItem('semester-reload-build')===reloadTarget){pendingReload=false;showToast('An app update is available. Reopen when your connection is stable.');return;}sessionStorage.setItem('semester-reload-build',reloadTarget);}catch(e){}
 location.reload();
}
async function setupOffline(){
 if(!('serviceWorker' in navigator)||!window.isSecureContext)return;
 try{
  reg=await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});
  await reg.update();
  const ready=await navigator.serviceWorker.ready;
  offlineShell=!!ready.active;
  updateSyncStatus();
 }catch(e){$('syncStatus').textContent='Schedule loaded · Offline setup unavailable';}
}

function showToast(message, canUndo = false) {
 clearTimeout(toastTimer);
 $('toastText').textContent = message;
 $('undoEntry').hidden = !canUndo;
 $('toast').hidden = false;
 if (!canUndo) toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function classes(day,g=group,d=selectedDate){return SCHEDULE.filter(c=>c.day===day&&(!c.group_ids.length||c.group_ids.includes(g))&&occursOn(c,d)).sort((a,b)=>a.start-b.start);}
function eventIncludes(e, d) {
 const k = key(d);
 return e.start <= k && e.end >= k && (!e.weekdaysOnly || (d.getDay() !== 0 && d.getDay() !== 6)) && !(e.exclude || []).includes(k);
}
function eventsOn(d) { return academic.events.filter(e => eventIncludes(e, d)); }
function dayState(d) {
 const events = eventsOn(d);
 const kind = ['exam','holiday','break'].find(k => events.some(e => category(e) === k));
 if (kind) return {kind, title:{exam:'Exam day',holiday:'Holiday',break:'Semester break'}[kind], events};
 if (key(d) < academic.start || key(d) > academic.end) return {kind:'outside', title:'Outside '+semester.title, events};
 return {kind:classes(d.getDay(),group,d).length ? 'teaching' : 'weekend', title:'No classes', events};
}
function isTeachingDate(d) { return dayState(d).kind === 'teaching'; }
function classesOn(d) { return isTeachingDate(d) ? classes(d.getDay(),group,d) : []; }
function monday(d) { return addDays(d, -((d.getDay()+6)%7)); }
function timing(c,d) {
 if (key(d) < key(now)) return 'past';
 if (key(d) > key(now) || !isTeachingDate(d)) return '';
 const m = now.getHours()*60+now.getMinutes();
 return m >= c.end ? 'past' : m >= c.start ? 'active' : '';
}
function eventRange(e) {
 return e.start === e.end ? shortDate(parseDate(e.start)) : `${shortDate(parseDate(e.start))} – ${shortDate(parseDate(e.end))}`;
}
function upcomingEvents() {
 return academic.events.map(e => {
  let date = parseDate(e.start > key(now) ? e.start : key(now));
  while (key(date) <= e.end && !eventIncludes(e, date)) date = addDays(date, 1);
  return {event:e, date};
 }).filter(item => key(item.date) <= item.event.end).sort((a,b) => key(a.date).localeCompare(key(b.date)) || a.event.start.localeCompare(b.event.start));
}
function renderHeader() {
 const today = key(selectedDate) === key(now), base = monday(selectedDate);
 $('pageTitle').textContent = view === 'calendar' ? 'Academic calendar' : view === 'week' ? 'The whole week' : today ? 'Today' : selectedDate.toLocaleDateString('en-GB',{weekday:'long'});
 $('pageEyebrow').textContent = view === 'calendar' ? 'Dates that matter' : view === 'week' ? 'Your weekly schedule' : 'Your daily schedule';
 $('pageDate').textContent = view === 'calendar' ? longDate(now) : view === 'week' ? `${shortDate(base)} – ${shortDate(addDays(base,6))} · Group ${groupLabel()}` : longDate(selectedDate);
 $('footerGroup').textContent = `Group ${groupLabel()}`;
 $('localClock').textContent = now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
 $('weekNav').hidden = view !== 'day';
 $('countdownStrip').hidden = view === 'calendar';
 const daysLeft = Math.max(0, dayDiff(now, parseDate(academic.end))+1);
 const next = upcomingEvents().find(item => category(item.event) !== 'important');
 let nextText = 'View calendar';
 if (next) {
  const days = dayDiff(now, next.date), label = {partial:'Partials',final:'Finals',exam:'Exam',break:'Break',holiday:'Holiday'}[next.event.type];
  nextText = `${label} ${days === 0 ? 'today' : 'in '+days+'d'}`;
 }
 $('countdownStrip').innerHTML = `<span>${key(now) < academic.start ? 'Semester starts in <strong>'+dayDiff(now,parseDate(academic.start))+' days</strong>' : '<strong>'+daysLeft+' days</strong> left in '+esc(semester.title)}</span><span class="next-date">${esc(nextText)} ↗</span>`;
 $('weekNav').innerHTML = Array.from({length:7}, (_,i) => {
  const d = addDays(base,i), state = dayState(d);
  return `<button class="day-button ${key(d) === key(now) ? 'is-today' : ''}" data-date="${key(d)}" aria-label="${longDate(d)}${key(d) === key(now) ? ', today' : ''}${['exam','holiday','break'].includes(state.kind) ? ', '+state.title : ''}" aria-pressed="${key(d) === key(selectedDate)}"><span>${d.toLocaleDateString('en-GB',{weekday:'short'})}</span><strong>${d.getDate()}</strong></button>`;
 }).join('');
}
function entryReadout(e) {
 return `<article><h4>${esc(e.name)}</h4>${e.notes ? `<p>${esc(e.notes)}</p>` : ''}</article>`;
}
function renderDay() {
 const state = dayState(selectedDate), list = classesOn(selectedDate), isToday = key(selectedDate) === key(now);
 const minutes = now.getHours()*60+now.getMinutes(), sum = list.reduce((s,c) => s+c.end-c.start,0);
 $('dayHeading').textContent = isToday ? "Today's schedule" : `${selectedDate.toLocaleDateString('en-GB',{weekday:'long'})}'s schedule`;
 $('dayCount').textContent = list.length ? `${list.length} classes · ${duration(sum)}` : 'No regular classes';
 $('backToday').hidden = isToday;
 $('dayNotice').hidden = true;
 document.querySelector('.day-layout').classList.toggle('non-teaching', state.kind !== 'teaching');
 $('dayEntries').innerHTML = '';
 if (state.kind !== 'teaching') {
  const explanation = {exam:'No regular classes. Check the exam details for this day.',holiday:'No classes today. Enjoy your day off.',break:'No classes during the semester break.',outside:'There are no scheduled classes for '+semester.title+' on this date.',weekend:'A little breathing room. No regular classes scheduled.'}[state.kind];
  $('daySchedule').innerHTML = `<div class="special-day ${state.kind}"><p class="eyebrow">${shortDate(selectedDate)} · ${state.kind === 'exam' ? 'Exams' : 'Your calendar'}</p><h3>${state.title}</h3><p>${explanation}</p>${state.events.length ? `<div class="special-list">${state.events.map(entryReadout).join('')}</div>` : ''}<button class="plain-button" data-open-calendar="${key(selectedDate)}">Open this day in Calendar ↗</button></div>`;
  $('liveStatus').innerHTML = '';
  $('daySummary').innerHTML = '';
  return;
 }
 const first=Math.floor(Math.min(...list.map(c=>c.start))/60)*60,last=Math.ceil(Math.max(...list.map(c=>c.end))/60)*60;
 const available=Math.max(120,$('daySchedule').clientWidth-94), canvas=document.createElement('canvas'),measure=canvas.getContext('2d');
 measure.font='16px sans-serif';
 const needed=c=>40+Math.ceil(measure.measureText(c.name).width/available)*25+(c.group?22:0)+(c.location?Math.ceil(measure.measureText(c.location).width/available)*22:0);
 const scale=Math.max(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--scale')),...list.map(c=>needed(c)/(c.end-c.start)));
 let html = `<div class="timeline" style="height:${(last-first)*scale}px" aria-label="Class timeline from ${time(first)} to ${time(last)}">`;
 for (let m=first; m<=last; m+=60) html += `<div class="hour" style="top:${(m-first)*scale}px"><span>${time(m)}</span></div>`;
 html += list.map(c => {
  const status = timing(c,selectedDate), pct = status === 'active' ? Math.max(0,Math.min(100,(minutes-c.start)/(c.end-c.start)*100)) : 0;
  return `<article class="course ${c.group ? 'lab' : ''} ${status}" style="top:${(c.start-first)*scale+3}px;height:${(c.end-c.start)*scale-6}px" aria-label="${esc(c.name)}, ${time(c.start)} to ${time(c.end)}${status ? ', '+status : ''}">${status === 'active' ? `<span class="elapsed-fill" style="height:${pct}%"></span>` : ''}<div class="course-top"><span class="course-time">${time(c.start)} – ${time(c.end)}</span>${status === 'active' ? '<span class="pill">Now</span>' : ''}</div><h3 class="course-title">${esc(c.name)}</h3>${c.group ? `<p class="course-note">Group ${esc(groupLabel())} · Lab</p>` : ''}${c.location?`<p class="course-note">${esc(c.location)}</p>`:''}</article>`;
 }).join('');
 if (isToday && minutes >= first && minutes <= last) html += `<div class="now-line" style="top:${(minutes-first)*scale}px" aria-label="Current time ${time(minutes)}"><span class="now-time">${time(minutes)}</span></div>`;
 $('daySchedule').innerHTML = html+'</div>';
 const current = isToday ? list.find(c => minutes >= c.start && minutes < c.end) : null;
 const next = isToday ? list.find(c => minutes < c.start) : null;
 let label, title, detail, stamp, progress = '';
 if (current) {
  label='Happening now'; title=current.name; detail=`${current.end-minutes} min left${current.group ? ' · Group '+groupLabel() : ''}`; stamp=`${time(current.start)}–${time(current.end)}`;
  progress=`<div class="status-progress"><i style="width:${(minutes-current.start)/(current.end-current.start)*100}%"></i></div>`;
 } else if (next) {
  label=minutes < list[0].start ? 'First up' : 'Up next'; title=next.name; detail=`Starts in ${duration(next.start-minutes)}`; stamp=`${time(next.start)}–${time(next.end)}`;
 } else if (isToday) {
  label='All wrapped up'; title='You’re done for today.'; detail='Your scheduled classes have finished.'; stamp=`${list.length} classes`;
 } else {
  label=key(selectedDate) < key(now) ? 'On this day' : 'On the schedule'; title=`${list.length} classes, ${duration(sum)}.`; detail=`${list.filter(c=>c.group).length} labs · Group ${groupLabel()}`; stamp=`${time(list[0].start)}–${time(list[list.length-1].end)}`;
 }
 $('liveStatus').classList.remove('reference');
 $('liveStatus').innerHTML=`<div class="eyebrow">${label}</div><h3>${esc(title)}</h3><p>${esc(detail)}</p><div class="status-time">${stamp}</div>${progress}`;
 $('daySummary').innerHTML=`<h3>The day at a glance</h3><div class="stats-row"><span>Class time</span><strong>${duration(sum)}</strong></div><div class="stats-row"><span>Lectures / Labs</span><strong>${list.filter(c=>!c.group).length} / ${list.filter(c=>c.group).length}</strong></div><div class="stats-row"><span>Finish time</span><strong>${time(list[list.length-1].end)}</strong></div>`;
 if (state.events.length) $('dayEntries').innerHTML=`<section class="day-reminders"><h3>Also on this day</h3>${state.events.map(e=>`<div class="day-entry"><h4>${esc(e.name)}</h4>${e.notes ? `<p class="entry-notes">${esc(e.notes)}</p>` : ''}</div>`).join('')}<button class="plain-button" data-open-calendar="${key(selectedDate)}">Open in Calendar ↗</button></section>`;
}
function renderWeek() {
 $('weekHeading').textContent=`Weekly schedule · ${groupLabel()}`;
 const base=monday(selectedDate);
 const dates=Array.from({length:7},(_,i)=>addDays(base,i));
 $('weekGrid').innerHTML=dates.filter((d,i)=>i<5 || classesOn(d).length || eventsOn(d).length).map(d=>{
  const state=dayState(d), list=classesOn(d), weekend=d.getDay()===0 || d.getDay()===6;
  let content;
  if (list.length) {
   content=list.map(c=>`<article class="mini-course ${c.group?'lab':''} ${timing(c,d)}"><p>${time(c.start)}–${time(c.end)}</p><h3>${esc(c.name)}</h3>${c.group?`<p class="lab-label">Group ${esc(groupLabel())} · Lab</p>`:''}${c.location?`<p class="lab-label">${esc(c.location)}</p>`:''}</article>`).join('');
   content+=`<p class="week-hours">${list.length} classes · ${duration(list.reduce((s,c)=>s+c.end-c.start,0))}</p>`;
   content+=state.events.map(e=>`<p class="mini-reminder">${esc(e.name)}</p>`).join('');
  } else {
   content=`<div class="mini-special ${state.kind}"><h3>${state.title}</h3>${state.events.map(e=>`<p>${esc(e.name)}</p>`).join('')}<p style="margin-top:10px">No regular classes</p></div>`;
  }
  return `<section class="week-column ${key(d)===key(now)?'today-column':''} ${weekend?'weekend-column':''}" data-week-date="${key(d)}"><h2 class="week-heading">${d.toLocaleDateString('en-GB',{weekday:'short'})}<span>${shortDate(d)}</span></h2>${content}</section>`;
 }).join('');
}
function calendarEntry(e) {
 return `<article class="day-entry"><div class="entry-label"><i class="swatch ${category(e)}"></i>${typeLabel(e)}${e.start !== e.end ? ' · '+eventRange(e) : ''}</div><h4>${esc(e.name)}</h4>${e.notes ? `<p class="entry-notes">${esc(e.notes)}</p>` : ''}<div class="entry-actions"><button data-edit-entry="${esc(e.id)}">Edit</button><button class="delete-day" data-remove-day="${esc(e.id)}">${e.start === e.end ? 'Remove' : 'Remove from this day'}</button></div></article>`;
}
function renderCalendar() {
 refreshMonths();
 $('monthSelect').innerHTML=months.map(m=>`<option value="${m}">${monthName(parseDate(m+'-01'))}</option>`).join('');
 $('monthSelect').value=key(shownMonth).slice(0,7);
 const monthIndex=months.indexOf($('monthSelect').value);$('prevMonth').disabled=monthIndex<=0;$('nextMonth').disabled=monthIndex>=months.length-1;
 const offset=(shownMonth.getDay()+6)%7, days=new Date(shownMonth.getFullYear(),shownMonth.getMonth()+1,0).getDate();
 let html=['M','T','W','T','F','S','S'].map((d,i)=>`<div class="weekday" aria-label="${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][i]}">${d}</div>`).join('');
 html+='<div aria-hidden="true"></div>'.repeat(offset);
 for(let n=1;n<=days;n++) {
  const d=new Date(shownMonth.getFullYear(),shownMonth.getMonth(),n), events=eventsOn(d), cats=events.map(category);
  const color=['exam','holiday','break','important'].find(c=>cats.includes(c)) || '';
  html+=`<button class="calendar-day ${color} ${key(d)===key(now)?'today':''} ${key(d)===key(calendarDate)?'chosen':''}" data-calendar-date="${key(d)}" aria-label="${longDate(d)}${key(d)===key(now)?', today':''}${events.length?', '+esc(events.map(e=>e.name).join(', ')):''}" aria-pressed="${key(d)===key(calendarDate)}" ${key(d)===key(now)?'aria-current="date"':''}>${n}${events.length?`<span class="calendar-dots">${events.slice(0,3).map(e=>`<i class="${category(e)}"></i>`).join('')}</span>`:''}</button>`;
 }
 $('monthGrid').innerHTML=html;
 const events=eventsOn(calendarDate), state=dayState(calendarDate), count=classesOn(calendarDate).length;
 $('selectedDate').innerHTML=`<div class="selection-heading"><div><h3>${calendarDate.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short'})}</h3><span class="meta">${key(calendarDate)===key(now)?'Today · ':''}${count?count+' classes scheduled':state.title}</span></div><button id="addDayEntry" class="primary-btn">+ Add entry</button></div>${events.length?events.map(calendarEntry).join(''):'<p>No entries yet. Add something to remember.</p>'}<div class="selection-footer"><span class="helper">Holidays, breaks, and exams replace classes.</span><button id="viewSelectedDay" class="plain-button">View day ↗</button></div>`;
 const start=parseDate(academic.start), end=parseDate(academic.end), total=dayDiff(start,end)+1;
 const remaining=Math.max(0,dayDiff(now,end)+1), elapsed=Math.max(0,Math.min(total,dayDiff(start,now)));
 let stats='<h3>'+esc(semester.title)+'</h3>';
 if(key(now)<academic.start) stats+=`<div class="semester-count">${dayDiff(now,start)}</div><p class="semester-sub">days until semester starts</p>`;
 else stats+=`<div class="semester-count">${remaining}</div><p class="semester-sub">${remaining?'days left, including today':'days left · Semester complete'}</p>`;
 stats+=`<div class="semester-progress"><i style="width:${elapsed/total*100}%"></i></div><p class="helper">${shortDate(start)} – ${shortDate(end)}<br>${total} calendar days</p>`;
 $('semesterStats').innerHTML=stats;
 const upcoming=upcomingEvents().slice(0,5);
 $('upcomingDates').innerHTML='<h3>Next important dates</h3>'+(upcoming.length?upcoming.map(({event:e,date})=>{
  const days=dayDiff(now,date), label=days===0?'Today':days===1?'Tomorrow':`In ${days} days`;
  return `<div class="upcoming-item"><i class="swatch ${category(e)}"></i><button class="upcoming-link" data-open-calendar="${key(date)}"><h4>${esc(e.name)}</h4><p>${eventRange(e)}</p><strong>${label}</strong></button></div>`;
 }).join(''):'<p class="helper">No upcoming dates. Tap a calendar day to add one.</p>');
}
function render() { if(!semester)return; renderHeader(); renderDay(); renderWeek(); renderCalendar(); }
function setView(v) {
 view=v;
 ['day','week','calendar'].forEach(name=>{
  $(name+'View').hidden=name!==v;
  $(name+'Tab').setAttribute('aria-selected',String(name===v));
  $(name+'Tab').tabIndex=name===v?0:-1;
 });
 renderHeader();
}
function openCalendarDate(date) {
 calendarDate=addDays(date,0);
 shownMonth=new Date(date.getFullYear(),date.getMonth(),1);
 renderCalendar(); setView('calendar');
}
function updateEntryForm() {
 const type=$('entryType').value;
 $('entryEffect').textContent=type==='important'?'Notes and reminders keep your regular classes.':category({type})==='exam'?'Shows “Exam day” and removes regular classes.':'Removes regular classes on these dates.';
 const range=$('entryEnd').value && $('entryEnd').value !== $('entryStart').value;
 $('weekdaysField').hidden=!range;
}
function openEntry(id=null) {
 const entry=academic.events.find(e=>e.id===id);
 editingId=entry?entry.id:null;
 $('entryForm').reset();
 $('entryError').textContent='';
 $('entryTitle').textContent=entry?'Edit calendar entry':'Add to this day';
 $('entryDayLabel').textContent=entry?'Your calendar':longDate(calendarDate);
 $('entryName').value=entry?.name || '';
 $('entryType').value=entry?.type || 'important';
 $('entryStart').value=entry?.start || key(calendarDate);
 $('entryEnd').value=entry && entry.end!==entry.start?entry.end:'';
 $('entryNotes').value=entry?.notes || '';
 $('entryWeekdays').checked=!!entry?.weekdaysOnly;
 $('entryRangeHint').hidden=!(entry && entry.start!==entry.end);
 $('deleteEntry').hidden=!entry;
 $('saveEntry').textContent=entry?'Save changes':'Add entry';
 updateEntryForm();
 $('entryDialog').showModal();
}
function removeEntry(id, onlyDate=null) {
 const entry=academic.events.find(e=>e.id===id);
 if(!entry) return;
 undoEvents=JSON.parse(JSON.stringify(academic.events));
 if(onlyDate && entry.start!==entry.end) entry.exclude=[...new Set([...(entry.exclude || []),key(onlyDate)])];
 else academic.events=academic.events.filter(e=>e.id!==id);
 const saved=persistCalendar();
 render();
 showToast((onlyDate?'Removed from this day.':'Entry deleted.')+(saved?'':' Not saved after closing.'),true);
}
function setTemporaryGroup(value) {
 if(!validGroup(value)) throw new Error('Choose a group from this semester.');
 group=value; $('group').value=value; render();
}
if(semester)$('group').value=group;
$('group').addEventListener('change',e=>setTemporaryGroup(e.target.value));
$('openSettings').addEventListener('click',()=>{ $('defaultGroup').value=defaultGroup; $('settingsDialog').showModal(); });
$('preferencesForm').addEventListener('submit',e=>{
 e.preventDefault();
 const value=$('defaultGroup').value;
 if(!validGroup(value)) return;
 defaultGroup=value;
 let saved=true;
 saved=writeLocal(defaultKey,defaultGroup);
 setTemporaryGroup(defaultGroup);
 $('settingsDialog').close();
 showToast(saved?`Default group saved: ${groupLabel(defaultGroup)}.`:`Using ${groupLabel(defaultGroup)} for this visit. This viewer cannot save settings.`);
});
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{
 if(e.target!==dialog) return;
 const r=dialog.getBoundingClientRect();
 if(e.clientX<r.left || e.clientX>r.right || e.clientY<r.top || e.clientY>r.bottom) dialog.close();
}));
$('countdownStrip').addEventListener('click',()=>openCalendarDate(now));
document.querySelector('.tabs').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(b)setView(b.dataset.view);});
document.querySelector('.tabs').addEventListener('keydown',e=>{
 const order=['day','week','calendar'],i=order.indexOf(view);let n;
 if(e.key==='ArrowRight')n=(i+1)%3;if(e.key==='ArrowLeft')n=(i+2)%3;if(e.key==='Home')n=0;if(e.key==='End')n=2;
 if(n!==undefined){e.preventDefault();setView(order[n]);$(order[n]+'Tab').focus();}
});
$('weekNav').addEventListener('click',e=>{
 const b=e.target.closest('[data-date]');
 if(b){selectedDate=parseDate(b.dataset.date);renderHeader();renderDay();renderWeek();document.querySelector(`[data-date="${key(selectedDate)}"]`)?.focus({preventScroll:true});}
});
$('backToday').addEventListener('click',()=>{selectedDate=addDays(now,0);renderHeader();renderDay();renderWeek();});
function shiftWeek(n){selectedDate=addDays(selectedDate,n*7);renderHeader();renderDay();renderWeek();}
$('prevWeek').addEventListener('click',()=>shiftWeek(-1));
$('nextWeek').addEventListener('click',()=>shiftWeek(1));
$('weekToday').addEventListener('click',()=>{selectedDate=addDays(now,0);renderHeader();renderDay();renderWeek();});
function shiftMonth(step){const index=months.indexOf(key(shownMonth).slice(0,7))+step;if(index<0||index>=months.length)return;shownMonth=parseDate(months[index]+'-01');calendarDate=addDays(shownMonth,0);renderCalendar();}
 $('prevMonth').addEventListener('click',()=>shiftMonth(-1));
$('nextMonth').addEventListener('click',()=>shiftMonth(1));
$('monthSelect').addEventListener('change',()=>{shownMonth=parseDate($('monthSelect').value+'-01');calendarDate=addDays(shownMonth,0);renderCalendar();});
$('monthToday').addEventListener('click',()=>openCalendarDate(now));
$('monthGrid').addEventListener('click',e=>{
 const b=e.target.closest('[data-calendar-date]');
 if(b){calendarDate=parseDate(b.dataset.calendarDate);renderCalendar();document.querySelector(`[data-calendar-date="${key(calendarDate)}"]`)?.focus({preventScroll:true});}
});
document.addEventListener('click',e=>{
 const b=e.target.closest('[data-open-calendar]');
 if(b) openCalendarDate(parseDate(b.dataset.openCalendar));
});
$('selectedDate').addEventListener('click',e=>{
 if(e.target.closest('#addDayEntry')) openEntry();
 const edit=e.target.closest('[data-edit-entry]'), remove=e.target.closest('[data-remove-day]');
 if(edit) openEntry(edit.dataset.editEntry);
 if(remove) removeEntry(remove.dataset.removeDay,calendarDate);
 if(e.target.closest('#viewSelectedDay')){selectedDate=addDays(calendarDate,0);renderDay();renderWeek();setView('day');window.scrollTo({top:0});}
});
['entryType','entryStart','entryEnd'].forEach(id=>$(id).addEventListener('change',updateEntryForm));
$('entryForm').addEventListener('submit',e=>{
 e.preventDefault();
 const name=$('entryName').value.trim(), start=$('entryStart').value, end=$('entryEnd').value||start;
 if(!name || !parseDate(start) || !parseDate(end) || end<start){$('entryError').textContent='Add a title and valid dates. The end date cannot be before the start.';return;}
 if(start<'2000-01-01'||end>'2100-12-31'||dayDiff(parseDate(start),parseDate(end))>1096){$('entryError').textContent='Choose dates between 2000 and 2100, with a range no longer than three years.';return;}
 const previous=academic.events.find(e=>e.id===editingId);
 const entry={...previous,id:editingId || 'entry-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),name,start,end,type:$('entryType').value,notes:$('entryNotes').value.trim(),weekdaysOnly:start!==end && $('entryWeekdays').checked};
 if(start===end) delete entry.exclude;
 else if(entry.exclude) entry.exclude=entry.exclude.filter(d=>d>=start && d<=end);
 if(previous) academic.events[academic.events.indexOf(previous)]=entry;
 else academic.events.push(entry);
 undoEvents=null;
 const saved=persistCalendar();
 $('entryDialog').close();
 // Keep the chosen day when editing its range; new entries follow their start date.
 if(!previous || !eventIncludes(entry,calendarDate))calendarDate=parseDate(start);
 shownMonth=new Date(calendarDate.getFullYear(),calendarDate.getMonth(),1);
 render();
 showToast((previous?'Calendar entry updated.':'Added to your calendar.')+(saved?'':' Not saved after closing.'));
 $('addDayEntry').focus({preventScroll:true});
});
$('deleteEntry').addEventListener('click',()=>{const id=editingId;$('entryDialog').close();removeEntry(id);});
$('undoEntry').addEventListener('click',()=>{if(!undoEvents)return;academic.events=undoEvents;undoEvents=null;const saved=persistCalendar();render();showToast(saved?'Calendar entry restored.':'Entry restored for this visit.');});
$('dismissToast').addEventListener('click',()=>{$('toast').hidden=true;});
function tick() {
 if(!semester)return;
 const oldKey=key(now), wasToday=key(selectedDate)===oldKey, calendarWasToday=key(calendarDate)===oldKey;
 now=new Date();
 if(key(now)!==oldKey){
  if(wasToday)selectedDate=addDays(now,0);
  if(calendarWasToday){calendarDate=addDays(now,0);shownMonth=new Date(now.getFullYear(),now.getMonth(),1);}
  render();
 }else{
  $('localClock').textContent=now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  renderDay();renderWeek();
 }
}
let resizeTimer;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(semester)renderDay();},150);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){tick();refreshPublished();reg?.update().catch(()=>{});}});
window.addEventListener('pageshow',()=>{tick();refreshPublished();});
setInterval(tick,30000);
render();


$('semesterSelect').addEventListener('change',()=>{loadSemester($('semesterSelect').value,true);render();});
$('retryLoad').addEventListener('click',refreshPublished);
window.addEventListener('online',()=>{refreshPublished();setupOffline();});
window.addEventListener('offline',()=>{connected=false;updateSyncStatus();});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('close',()=>{
 if(pendingEnvelope){const envelope=pendingEnvelope;pendingEnvelope=null;applyEnvelope(envelope);showToast('Published schedule updated.');}
 reloadWhenSafe();
}));
// Use the saved dataset immediately, then replace it with the latest server revision.
const cached=readLocal(DATA_KEY,null);
if(validEnvelope(cached)){storedOffline=true;applyEnvelope(cached);}
refreshPublished();setupOffline();
