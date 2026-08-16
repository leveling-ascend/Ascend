import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
import { db, ASCEND_COLLECTION } from "./firebase.js";

/* =================================================================
   ASCEND: The Takeover — React port
   Same logic + UI as the original vanilla-JS PWA, rebuilt as a
   single-file React functional component (hooks, CSS custom
   properties, no build-time CSS framework) to match the app's
   tech stack.

   Sync: the whole app state (config/achievements/days/plans/
   penaltyLog) lives as one Firestore document, kept live with
   onSnapshot and written back with a debounced setDoc — same
   shape of sync as the Life RPG app, just on ASCEND's own
   Firebase project/collection. The PIN-based owner/view-only
   lock stays exactly as it was in the original app (client-side
   only, not Firebase auth). localStorage is kept as an offline
   cache so the app still works (read-only feel) without a
   network connection.
================================================================= */

const SYNC_ENABLED = true;
const MAIN_DOC_ID = "main";

/* ============================= CONSTANTS ============================= */
const CAMPAIGN_DAYS = 231;
const TOTAL_DAILY_XP_MAX = CAMPAIGN_DAYS * 100;
const TOTAL_CHAPTERS = 80;

const RANK_NAMES = ["E", "D", "C", "B", "A", "S"];
const RANK_COLORS = [
  ["#4c5164", "#6d7386"],
  ["#7a5636", "#b0824f"],
  ["#2f6fe0", "#6fa8ff"],
  ["#0fae9e", "#5be0d0"],
  ["#8b3fe0", "#c08bff"],
  ["#e8b400", "#ffe873"],
];
function tierFor(score) {
  return Math.min(5, Math.floor(clamp(score, 0, 100) / 18));
}
function rankFor(score) {
  const t = tierFor(score);
  return { name: RANK_NAMES[t], tier: t, glow: RANK_COLORS[t] };
}

const HARD_MODE_TASKS = [
  { id: "hm1", name: "Lights out by 9:30 PM" },
  { id: "hm2", name: "Zero phone before 12 PM" },
  { id: "hm3", name: "Cold shower" },
  { id: "hm4", name: "+50 extra revision questions" },
  { id: "hm5", name: "No sugar / junk food today" },
];

const THEMES = [
  { id: "catmeme", label: "Cat Glitter", ic: "🐱" },
  { id: "dark", label: "Obsidian", ic: "🌑" },
  { id: "light", label: "Daylight", ic: "☀️" },
  { id: "cyber", label: "Cyber", ic: "⚡" },
  { id: "forest", label: "Forest", ic: "🌿" },
];

const ACCENTS = ["#7c5cff", "#ff5c8a", "#3ddc84", "#ffb14d", "#4fd0ff", "#ff5c5c", "#c08bff"];

const DEFAULT_TASKS = {
  strength: {
    label: "Strength & Fitness", icon: "💪", max: 35,
    tasks: [
      { id: "walk", name: "4 km walk", xp: 10 },
      { id: "exercise", name: "Exercise", xp: 12 },
      { id: "protein", name: "80g protein", xp: 8 },
      { id: "water", name: "Adequate water", xp: 5 },
    ],
  },
  intellect: {
    label: "Intellect", icon: "🧠", max: 40,
    tasks: [
      { id: "study", name: "NEET study / practice", xp: 30 },
      { id: "revision", name: "Revision / questions", xp: 10 },
    ],
  },
  discipline: {
    label: "Discipline", icon: "🔥", max: 11,
    tasks: [
      { id: "wake", name: "Wake at 7:00 AM", xp: 8 },
      { id: "review", name: "Daily completion / review", xp: 3 },
    ],
  },
  skills: {
    label: "Skills", icon: "✨", max: 14,
    tasks: [
      { id: "skincare", name: "Skincare", xp: 4 },
      { id: "haircare", name: "Hair care", xp: 3 },
      { id: "shower", name: "Shower", xp: 3 },
      { id: "brush", name: "Brush teeth twice", xp: 4 },
    ],
  },
};

const DEFAULT_ACH = {
  chapters: 0,
  arcI: 0,
  arcII: 0,
  arcIII: 0,
  milestones: [false, false, false, false, false, false],
  driving: 0,
  bookLHN: false,
  bookAH: false,
};

const DEFAULT_CONFIG = {
  theme: "catmeme", accent: "#ff5fa8", threshold: 70,
  startDate: todayStr(), started: false,
  pin: "", ownerUnlocked: true,
  alarmTime: "", lastAlarmFired: "",
  lastRankTier: 0, celebrationUntil: 0,
  tasks: DEFAULT_TASKS,
};

/* ============================= UTIL ============================= */
function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function addDays(str, n) {
  const d = new Date(str + "T00:00:00");
  d.setDate(d.getDate() + n);
  return todayStr(d);
}
function weekOf(dateStr, startDate) {
  const a = new Date(startDate + "T00:00:00"), b = new Date(dateStr + "T00:00:00");
  const diff = Math.floor((b - a) / 86400000);
  return Math.max(1, Math.floor(diff / 7) + 1);
}
function weekStartDate(startDate, weekNum) {
  return addDays(startDate, (weekNum - 1) * 7);
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function uid() {
  return Math.random().toString(36).slice(2, 9);
}

/* ============================= LOCAL STORAGE ============================= */
const LS_KEYS = {
  config: "ascend:config",
  achievements: "ascend:achievements",
  days: "ascend:days",
  plans: "ascend:plans",
  penaltyLog: "ascend:penaltylog",
};
function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

/* ============================= SCORING (pure fns) ============================= */
function dayXP(days, taskDefs, dateStr) {
  const rec = days[dateStr];
  if (!rec) return 0;
  let sum = 0;
  for (const cat of Object.values(taskDefs)) {
    for (const t of cat.tasks) {
      if (rec.tasksDone && rec.tasksDone[t.id]) sum += t.xp;
    }
  }
  return sum;
}
function totalDailyXP(days, taskDefs) {
  let sum = 0;
  for (const k of Object.keys(days)) sum += dayXP(days, taskDefs, k);
  return sum;
}
function dailyDisciplineScore(days, taskDefs) {
  return (totalDailyXP(days, taskDefs) / TOTAL_DAILY_XP_MAX) * 60;
}
function chaptersScore(achievements) {
  return clamp(achievements.chapters, 0, TOTAL_CHAPTERS) * (10 / TOTAL_CHAPTERS);
}
function achievementScore(achievements) {
  return (
    chaptersScore(achievements) +
    clamp(achievements.arcI, 0, 5) +
    clamp(achievements.arcII, 0, 5) +
    clamp(achievements.arcIII, 0, 5)
  );
}
function milestoneScore(achievements) {
  const ms = achievements.milestones.filter(Boolean).length;
  return ms + clamp(achievements.driving, 0, 3) + (achievements.bookLHN ? 3 : 0) + (achievements.bookAH ? 3 : 0);
}
function finalScore(days, taskDefs, achievements) {
  return clamp(
    dailyDisciplineScore(days, taskDefs) + achievementScore(achievements) + milestoneScore(achievements),
    0,
    100
  );
}
function currentWeek(config) {
  return clamp(weekOf(todayStr(), config.startDate), 1, 33);
}
function currentArcLabel(config) {
  const w = currentWeek(config);
  if (w <= 11) return "Arc I — Foundation";
  if (w <= 22) return "Arc II — Evolution";
  return "Arc III — Ascension";
}
function weekMissCount(days, taskDefs, config, weekNum) {
  const start = weekStartDate(config.startDate, weekNum);
  let misses = 0;
  const t = todayStr();
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    if (d > t) continue;
    const rec = days[d];
    if (rec && rec.leave) continue;
    const xp = dayXP(days, taskDefs, d);
    if (xp < config.threshold) misses++;
  }
  return misses;
}
function penaltyForMisses(n) {
  if (n <= 0) return { level: 0, name: "No penalty", desc: "Full privileges. Keep the streak alive." };
  if (n === 1) return { level: 1, name: "P1 — Warning", desc: "No entertainment / social media for the rest of the day." };
  if (n === 2) return { level: 2, name: "P2 — Lockdown", desc: "No entertainment / gaming / recreational YouTube for 24 hours." };
  if (n === 3) return { level: 3, name: "P3 — Loss", desc: "Lose one planned leisure activity + no non-essential phone use until core quest is done." };
  if (n === 4) return { level: 4, name: "P4 — Boss", desc: "Lose one reward coupon + full leisure restriction next day." };
  return { level: 5, name: "P5 — Hard Mode", desc: "Lose one paid-leave day + 3 days of Hard Mode." };
}
function rebalance(tasksArr, targetMax) {
  const sum = tasksArr.reduce((s, t) => s + t.xp, 0);
  if (sum === 0 || tasksArr.length === 0) return tasksArr;
  let running = 0;
  return tasksArr.map((t, i) => {
    if (i === tasksArr.length - 1) return { ...t, xp: targetMax - running };
    const xp = Math.max(1, Math.round((t.xp / sum) * targetMax));
    running += xp;
    return { ...t, xp };
  });
}

/* ============================= STYLES ============================= */
const STYLES = `
.ascend-app{
  --bg:#0a0c14; --bg2:#11141f; --card:#161a28; --card2:#1d2233;
  --line:rgba(255,255,255,0.08); --text:#eef0f6; --sub:#8890a6; --sub2:#5c6580;
  --accent:#7c5cff; --accent2:#a78bfa; --green:#3ddc84; --yellow:#ffcc4d; --red:#ff5c5c;
  --radius:18px; --radius-sm:12px;
  --shadow:0 8px 30px rgba(0,0,0,0.35);
  --font: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.ascend-app[data-theme="light"]{
  --bg:#f3f1ea; --bg2:#ffffff; --card:#ffffff; --card2:#f6f4ee;
  --line:rgba(20,20,30,0.08); --text:#191a22; --sub:#5c6072; --sub2:#8a8fa3;
  --shadow:0 8px 24px rgba(30,20,10,0.10);
}
.ascend-app[data-theme="cyber"]{
  --bg:#04050a; --bg2:#070a14; --card:#0b1020; --card2:#111a30;
  --line:rgba(0,234,255,0.18); --text:#e8feff; --sub:#7fd8e8; --sub2:#4a8a96;
  --shadow:0 0 30px rgba(0,234,255,0.12);
}
.ascend-app[data-theme="forest"]{
  --bg:#0d1610; --bg2:#111d16; --card:#16241c; --card2:#1c2e22;
  --line:rgba(120,200,140,0.14); --text:#e9f5ec; --sub:#9fc4ab; --sub2:#5e7d68;
  --shadow:0 8px 26px rgba(0,20,10,0.35);
}
.ascend-app[data-theme="catmeme"]{
  --bg:#ffe4f3; --bg2:#fff0f8; --card:#fff7fc; --card2:#ffe9f6;
  --line:rgba(255,90,180,0.25); --text:#5a1440; --sub:#a84a86; --sub2:#c98cb4;
  --shadow:0 8px 26px rgba(255,100,180,0.18);
}
.ascend-app{box-sizing:border-box; width:100%; min-height:100vh; background:var(--bg); color:var(--text);
  font-family:var(--font); transition:background .4s ease,color .4s ease; overscroll-behavior-y:none; position:relative;}
.ascend-app *{box-sizing:border-box; -webkit-tap-highlight-color:transparent;}
.ascend-app button,.ascend-app input,.ascend-app textarea,.ascend-app select{font-family:inherit; color:inherit;}
.ascend-app .app{max-width:520px; margin:0 auto; min-height:100vh; display:flex; flex-direction:column; position:relative; overflow:hidden;}
.ascend-app .scroll{flex:1; overflow-y:auto; padding:14px 14px 100px; -webkit-overflow-scrolling:touch; position:relative;}
.ascend-app .scroll::-webkit-scrollbar{width:0;height:0;}

.ascend-app .sparkle-layer{position:fixed; inset:0; pointer-events:none; z-index:5; overflow:hidden; display:none;}
.ascend-app[data-theme="catmeme"] .sparkle-layer{display:block;}
.ascend-app .sparkle-layer span{position:absolute; bottom:-40px; font-size:20px; opacity:.85; animation:ascendFloatUp linear infinite;}
@keyframes ascendFloatUp{0%{transform:translateY(0) rotate(0deg); opacity:0;}10%{opacity:.9;}100%{transform:translateY(-110vh) rotate(360deg); opacity:0;}}
.ascend-app[data-theme="catmeme"] .card,.ascend-app[data-theme="catmeme"] .aspect-mini,.ascend-app[data-theme="catmeme"] .rank-core{
  box-shadow:0 4px 18px rgba(255,110,190,0.25), var(--shadow);}
.ascend-app[data-theme="catmeme"] .btn{background:linear-gradient(135deg,#ff5fa8,#c07bff);}

.ascend-app .ptr{position:absolute; top:-50px; left:50%; transform:translateX(-50%); width:34px; height:34px; border-radius:50%;
  background:var(--card); border:1px solid var(--line); display:flex; align-items:center; justify-content:center;
  font-size:16px; transition:top .2s ease; z-index:15; box-shadow:var(--shadow);}
.ascend-app .ptr.spin{animation:ascendSpin .7s linear infinite;}
@keyframes ascendSpin{to{transform:translateX(-50%) rotate(360deg);}}

.ascend-app .hud{position:sticky; top:0; z-index:20; padding:16px 16px 14px; background:linear-gradient(180deg,var(--bg) 60%,transparent);
  backdrop-filter:blur(6px);}
.ascend-app .hud-top{display:flex; align-items:center; gap:14px;}
.ascend-app .rank-core{position:relative; width:74px; height:74px; flex:none; border-radius:50%;
  display:flex; align-items:center; justify-content:center; font-weight:800; font-size:22px; letter-spacing:.5px;
  background:radial-gradient(circle at 35% 30%, var(--rc2), var(--rc1) 70%);
  box-shadow:0 0 0 3px var(--card), 0 0 24px 2px var(--rc1), inset 0 0 14px rgba(255,255,255,0.25);
  color:#0a0c14; transition:all .6s ease;}
.ascend-app .hud-mid{flex:1; min-width:0;}
.ascend-app .hud-label{font-size:11px; text-transform:uppercase; letter-spacing:1.5px; color:var(--sub2); font-weight:700;}
.ascend-app .hud-score{font-size:30px; font-weight:800; letter-spacing:-.5px; line-height:1.1;}
.ascend-app .hud-score span{font-size:15px; color:var(--sub); font-weight:600;}
.ascend-app .hud-bar-track{margin-top:8px; height:8px; border-radius:6px; background:var(--card2); overflow:hidden; border:1px solid var(--line);}
.ascend-app .hud-bar-fill{height:100%; border-radius:6px; background:linear-gradient(90deg,var(--accent),var(--accent2)); transition:width .5s ease;}
.ascend-app .hud-meta{display:flex; justify-content:space-between; margin-top:6px; font-size:11.5px; color:var(--sub);}

.ascend-app .celebrate{margin-top:12px; border-radius:16px; padding:14px; text-align:center; font-weight:800;
  background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; position:relative; overflow:hidden;}
.ascend-app .celebrate .pop{position:absolute; font-size:18px; animation:ascendPop 1.6s ease-in-out infinite;}
@keyframes ascendPop{0%,100%{transform:translateY(0) scale(1);}50%{transform:translateY(-6px) scale(1.15);}}

.ascend-app .tabbar{position:sticky; bottom:0; z-index:30; display:flex; background:var(--card); border-top:1px solid var(--line);
  padding:8px 6px calc(8px + env(safe-area-inset-bottom)); gap:2px; max-width:520px; margin:0 auto; width:100%;}
.ascend-app .tab{flex:1; border:none; background:transparent; padding:8px 2px; border-radius:12px; font-size:10.5px; font-weight:700;
  color:var(--sub); display:flex; flex-direction:column; align-items:center; gap:3px; cursor:pointer; letter-spacing:.3px;}
.ascend-app .tab .ic{font-size:18px;}
.ascend-app .tab.active{color:var(--accent); background:color-mix(in srgb, var(--accent) 14%, transparent);}

.ascend-app .section-title{font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:1.2px; color:var(--sub);
  margin:22px 2px 10px; display:flex; align-items:center; justify-content:space-between;}
.ascend-app .card{background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow); margin-bottom:12px;}

.ascend-app .trio{display:grid; grid-template-columns:repeat(3,1fr); gap:8px;}
.ascend-app .trio-card{background:var(--card); border:1px solid var(--line); border-radius:14px; padding:10px 8px; text-align:center; cursor:pointer;}
.ascend-app .trio-card .ic{font-size:18px;}
.ascend-app .trio-card b{display:block; font-size:15px; margin-top:2px;}
.ascend-app .trio-card span{font-size:9.5px; color:var(--sub); text-transform:uppercase; letter-spacing:.5px;}
.ascend-app .compact-detail{margin-top:10px;}

.ascend-app .aspect-strip{display:flex; justify-content:space-between; gap:8px; margin-top:6px;}
.ascend-app .aspect-mini{flex:1; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:10px 6px; text-align:center; cursor:pointer;}
.ascend-app .aspect-mini .name{font-size:10px; font-weight:700; margin-top:4px;}
.ascend-app .ring{width:48px; height:48px; margin:0 auto;}
.ascend-app .ring.big{width:64px; height:64px;}
.ascend-app .ring circle{fill:none; stroke-width:6;}
.ascend-app .ring.big circle{stroke-width:7;}
.ascend-app .ring .bg{stroke:var(--card2);}
.ascend-app .ring .fg{stroke:var(--accent); stroke-linecap:round; transition:stroke-dashoffset .6s ease;}
.ascend-app .ring text{font-size:12px; font-weight:800; fill:var(--text);}
.ascend-app .ring.big text{font-size:15px;}

.ascend-app .task-group{margin-bottom:6px;}
.ascend-app .task-group-title{font-size:11.5px; font-weight:800; color:var(--sub); text-transform:uppercase; letter-spacing:.8px; margin:14px 2px 6px;}
.ascend-app .task-row{display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--line);}
.ascend-app .task-row:last-child{border-bottom:none;}
.ascend-app .chk{width:23px; height:23px; border-radius:7px; border:2px solid var(--sub2); flex:none; cursor:pointer;
  display:flex; align-items:center; justify-content:center; font-size:14px; transition:all .15s; background:transparent;}
.ascend-app .chk.on{background:var(--green); border-color:var(--green); color:#08130c;}
.ascend-app .task-name{flex:1; font-size:14px; font-weight:600;}
.ascend-app .task-xp{font-size:12px; color:var(--sub); font-weight:700;}
.ascend-app .task-row.done .task-name{color:var(--sub); text-decoration:line-through;}

.ascend-app .field-row{display:flex; gap:8px; margin-top:10px;}
.ascend-app .field-row input,.ascend-app .field-row textarea{flex:1; background:var(--card2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px;}
.ascend-app textarea{width:100%; min-height:70px; resize:vertical; background:var(--card2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px; margin-top:8px;}
.ascend-app .btn{background:var(--accent); color:#fff; border:none; padding:10px 16px; border-radius:10px; font-weight:700; font-size:13px; cursor:pointer;}
.ascend-app .btn.ghost{background:transparent; border:1px solid var(--line); color:var(--text);}
.ascend-app .btn.sm{padding:7px 12px; font-size:12px;}
.ascend-app .btn:disabled{opacity:.4; cursor:not-allowed;}
.ascend-app .btn.big{width:100%; padding:16px; font-size:16px; border-radius:16px;}
.ascend-app .progress-line{display:flex; align-items:center; gap:10px; margin-top:6px;}
.ascend-app .progress-line .track{flex:1; height:10px; border-radius:6px; background:var(--card2); overflow:hidden;}
.ascend-app .progress-line .fill{height:100%; background:linear-gradient(90deg,var(--green),#8ff0b0);}
.ascend-app .small-muted{font-size:11.5px; color:var(--sub);}

.ascend-app .week-nav{display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;}
.ascend-app .week-nav b{font-size:14px;}
.ascend-app .dots{display:flex; justify-content:space-between;}
.ascend-app .day-dot{display:flex; flex-direction:column; align-items:center; gap:6px; font-size:10px; color:var(--sub);}
.ascend-app .dot{width:20px; height:20px; border-radius:50%; background:var(--card2); border:2px solid var(--line);}
.ascend-app .dot.g{background:var(--green); border-color:var(--green);}
.ascend-app .dot.y{background:var(--yellow); border-color:var(--yellow);}
.ascend-app .dot.r{background:var(--red); border-color:var(--red);}
.ascend-app .dot.today{box-shadow:0 0 0 2px var(--accent);}

.ascend-app .ach-row{margin-bottom:16px;}
.ascend-app .ach-head{display:flex; justify-content:space-between; font-size:13px; font-weight:700; margin-bottom:6px;}
.ascend-app .stepper{display:flex; gap:6px;}
.ascend-app .step{flex:1; height:14px; border-radius:5px; background:var(--card2); border:1px solid var(--line); cursor:pointer;}
.ascend-app .step.on{background:var(--accent);}
.ascend-app .chapter-input{display:flex; align-items:center; gap:8px; margin-top:8px;}
.ascend-app .chapter-input input{width:70px; background:var(--card2); border:1px solid var(--line); border-radius:8px; padding:8px; text-align:center; font-size:14px;}

.ascend-app .milestone-grid{display:flex; flex-wrap:wrap; gap:8px;}
.ascend-app .ms{padding:10px 12px; border-radius:12px; border:1px solid var(--line); background:var(--card2); font-size:12.5px; font-weight:700; cursor:pointer; flex:1 1 30%; text-align:center;}
.ascend-app .ms.on{background:var(--green); color:#08130c; border-color:var(--green);}

.ascend-app .pen-active{padding:16px; border-radius:var(--radius); text-align:center; font-weight:800;}
.ascend-app .pen-level0{background:color-mix(in srgb,var(--green) 18%,var(--card));}
.ascend-app .pen-level1{background:color-mix(in srgb,var(--yellow) 20%,var(--card));}
.ascend-app .pen-level2,.ascend-app .pen-level3{background:color-mix(in srgb,#ff9a3d 22%,var(--card));}
.ascend-app .pen-level4,.ascend-app .pen-level5{background:color-mix(in srgb,var(--red) 24%,var(--card));}
.ascend-app .pen-list .task-row{align-items:flex-start;}
.ascend-app .badge{font-size:10px; font-weight:800; padding:3px 8px; border-radius:20px; background:var(--card2); color:var(--sub);}

.ascend-app .swatch-row{display:flex; gap:10px; flex-wrap:wrap; margin-top:8px;}
.ascend-app .theme-swatch{width:56px; height:56px; border-radius:16px; border:2px solid var(--line); cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:20px; background:var(--card2);}
.ascend-app .theme-swatch.sel{border-color:var(--accent); transform:scale(1.06);}
.ascend-app .swatch{width:34px; height:34px; border-radius:50%; border:2px solid var(--line); cursor:pointer;}
.ascend-app .swatch.sel{border-color:var(--text); transform:scale(1.1);}
.ascend-app .toggle-row{display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom:1px solid var(--line);}
.ascend-app .toggle-row:last-child{border-bottom:none;}
.ascend-app .switch{width:46px; height:26px; border-radius:20px; background:var(--card2); border:1px solid var(--line); position:relative; cursor:pointer;}
.ascend-app .switch.on{background:var(--accent);}
.ascend-app .switch::after{content:''; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; transition:.2s;}
.ascend-app .switch.on::after{left:22px;}
.ascend-app .edit-task-row{display:flex; gap:6px; align-items:center; padding:8px 0; border-bottom:1px solid var(--line);}
.ascend-app .edit-task-row input[type=text]{flex:1; background:var(--card2); border:1px solid var(--line); border-radius:8px; padding:7px 9px; font-size:13px;}
.ascend-app .edit-task-row input[type=number]{width:56px; background:var(--card2); border:1px solid var(--line); border-radius:8px; padding:7px 6px; font-size:13px; text-align:center;}
.ascend-app .iconbtn{background:none; border:none; color:var(--sub); font-size:16px; cursor:pointer; padding:4px 6px;}
.ascend-app .lockbar{display:flex; align-items:center; gap:8px; background:var(--card2); border:1px solid var(--line); border-radius:12px; padding:10px 12px; margin-bottom:14px; font-size:12.5px;}
.ascend-app .hidden{display:none !important;}
.ascend-app .arc-desc{font-size:12px; color:var(--sub); margin-bottom:8px;}

.ascend-app .start-gate{display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:50px 20px;}
.ascend-app .start-gate .big-badge{width:110px; height:110px; border-radius:50%; background:radial-gradient(circle at 35% 30%,var(--accent2),var(--accent)); box-shadow:0 0 40px 6px var(--accent); margin-bottom:18px; display:flex; align-items:center; justify-content:center; font-size:40px;}
`;

/* ============================= SMALL UI HELPERS ============================= */
function Ring({ pct, size = 64 }) {
  const stroke = size >= 64 ? 7 : 6;
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - clamp(pct, 0, 1));
  return (
    <svg className={`ring ${size >= 64 ? "big" : ""}`} viewBox={`0 0 ${size} ${size}`}>
      <circle className="bg" cx={size / 2} cy={size / 2} r={r} />
      <circle
        className="fg" cx={size / 2} cy={size / 2} r={r}
        strokeDasharray={c} strokeDashoffset={off}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="53%" textAnchor="middle" dominantBaseline="middle">
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

function TaskRow({ id, name, xp, done, onToggle, disabled }) {
  return (
    <div className={`task-row ${done ? "done" : ""}`}>
      <div className={`chk ${done ? "on" : ""}`} onClick={disabled ? undefined : onToggle}>
        {done ? "✓" : ""}
      </div>
      <div className="task-name">{name}</div>
      <div className="task-xp">{xp} XP</div>
    </div>
  );
}

function Stepper({ value, max, onSet, disabled }) {
  return (
    <div className="stepper">
      {Array.from({ length: max }).map((_, i) => (
        <div
          key={i}
          className={`step ${i < value ? "on" : ""}`}
          onClick={disabled ? undefined : () => onSet(value === i + 1 ? i : i + 1)}
        />
      ))}
    </div>
  );
}

function SwitchToggle({ on, onClick, disabled }) {
  return <div className={`switch ${on ? "on" : ""}`} onClick={disabled ? undefined : onClick} />;
}

/* ============================= HUD ============================= */
const SYNC_LABEL = {
  synced: "☁️ Synced",
  saving: "💾 Saving…",
  loading: "☁️ Connecting…",
  offline: "📴 Offline — saved on this device",
  error: "⚠️ Sync error — saved on this device",
};
function Hud({ score, rank, celebrating, syncStatus }) {
  return (
    <div className="hud">
      <div className="hud-top">
        <div className="rank-core" style={{ "--rc1": rank.glow[0], "--rc2": rank.glow[1] }}>
          {rank.name}
        </div>
        <div className="hud-mid">
          <div className="hud-label">Final Campaign Score</div>
          <div className="hud-score">
            {score.toFixed(1)}
            <span>/100</span>
          </div>
          <div className="hud-bar-track">
            <div className="hud-bar-fill" style={{ width: `${score}%` }} />
          </div>
          <div className="hud-meta">
            <span>{currentArcLabel.__lastLabel}</span>
            <span>{SYNC_LABEL[syncStatus] || ""}</span>
          </div>
        </div>
      </div>
      {celebrating && (
        <div className="celebrate">
          <span className="pop" style={{ left: "8%", top: 6 }}>🎉</span>
          <span className="pop" style={{ right: "8%", top: 6, animationDelay: ".3s" }}>🎊</span>
          <div>RANK UP! Welcome to {rank.name}-Rank 🏆</div>
          <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.9, marginTop: 2 }}>
            A milestone was auto-completed for you. Celebration active for 12 hours.
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================= START GATE ============================= */
function StartGate({ isOwner, onStart }) {
  return (
    <div className="start-gate">
      <div className="big-badge">🏔️</div>
      <h2 style={{ margin: "0 0 8px" }}>ASCEND: The Takeover</h2>
      <p className="small-muted" style={{ maxWidth: 280 }}>
        33 weeks. 231 days. Your campaign hasn't begun yet.
      </p>
      {isOwner ? (
        <button className="btn big" style={{ maxWidth: 260, marginTop: 18 }} onClick={onStart}>
          🚀 Begin the Campaign
        </button>
      ) : (
        <p className="small-muted">Waiting for the campaign owner to start.</p>
      )}
    </div>
  );
}

/* ============================= HOME TAB ============================= */
function HomeTab({ config, setConfig, days, setDays, plans, setPlans, isOwner, onAfterTaskToggle }) {
  const [openAspect, setOpenAspect] = useState(null);
  const [compactExpanded, setCompactExpanded] = useState({ diet: false, planner: false });

  const t = todayStr();
  const rec = days[t] || { tasksDone: {}, protein: 0, studyLog: "", questions: 0, leave: false, hardMode: {} };

  const [proteinDraft, setProteinDraft] = useState(rec.protein || "");
  const [studyDraft, setStudyDraft] = useState(rec.studyLog || "");
  const [questionsDraft, setQuestionsDraft] = useState(rec.questions || "");
  const [plannerDraft, setPlannerDraft] = useState(plans[addDays(t, 1)] || "");

  const updateRec = useCallback(
    (patch) => {
      setDays((prev) => ({ ...prev, [t]: { ...(prev[t] || rec), ...patch } }));
    },
    [t, rec, setDays]
  );

  const toggleTask = (catKey, taskId) => {
    if (!isOwner) return;
    const current = days[t] || { tasksDone: {} };
    const nextDone = { ...(current.tasksDone || {}), [taskId]: !current.tasksDone?.[taskId] };
    setDays((prev) => ({ ...prev, [t]: { ...(prev[t] || rec), tasksDone: nextDone } }));
    onAfterTaskToggle();
  };

  const proteinPct = clamp((rec.protein || 0) / 80, 0, 1);
  const plannerText = plans[addDays(t, 1)] || "";
  const plannerCount = plannerText.trim() ? plannerText.trim().split(/\n+/).filter(Boolean).length : 0;

  const weekN = currentWeek(config);
  const wStart = weekStartDate(config.startDate, weekN);

  return (
    <>
      <div className="trio">
        <div className="trio-card" onClick={() => setCompactExpanded((s) => ({ ...s, diet: !s.diet }))}>
          <div className="ic">🍗</div>
          <b>{rec.protein || 0}g</b>
          <span>Diet</span>
        </div>
        <div className="trio-card" onClick={() => setCompactExpanded((s) => ({ ...s, planner: !s.planner }))}>
          <div className="ic">📝</div>
          <b>{plannerCount}</b>
          <span>Planner</span>
        </div>
        <div className="trio-card" onClick={() => document.getElementById("aspect-detail")?.scrollIntoView({ behavior: "smooth" })}>
          <div className="ic">⚡</div>
          <b>{dayXP(days, config.tasks, t)}</b>
          <span>Today XP</span>
        </div>
      </div>

      {compactExpanded.diet && (
        <div className="card compact-detail">
          <div className="small-muted">Protein target: 80g</div>
          <div className="progress-line">
            <div className="track"><div className="fill" style={{ width: `${proteinPct * 100}%` }} /></div>
            <b>{rec.protein || 0}g</b>
          </div>
          <div className="field-row">
            <input
              type="number" placeholder="Grams eaten so far" value={proteinDraft} disabled={!isOwner}
              onChange={(e) => setProteinDraft(e.target.value)}
            />
            <button className="btn sm" disabled={!isOwner} onClick={() => updateRec({ protein: Number(proteinDraft) || 0 })}>
              Log
            </button>
          </div>
          <div className="small-muted" style={{ marginTop: 10 }}>What did you study today?</div>
          <textarea
            placeholder="e.g. Physics — Rotational Motion" disabled={!isOwner}
            value={studyDraft} onChange={(e) => setStudyDraft(e.target.value)}
          />
          <div style={{ textAlign: "right", marginTop: 6 }}>
            <button className="btn sm" disabled={!isOwner} onClick={() => updateRec({ studyLog: studyDraft })}>Save</button>
          </div>
          <div className="small-muted" style={{ marginTop: 10 }}>Questions done today</div>
          <div className="field-row">
            <input
              type="number" placeholder="No. of questions" value={questionsDraft} disabled={!isOwner}
              onChange={(e) => setQuestionsDraft(e.target.value)}
            />
            <button className="btn sm" disabled={!isOwner} onClick={() => updateRec({ questions: Number(questionsDraft) || 0 })}>
              Log
            </button>
          </div>
        </div>
      )}

      {compactExpanded.planner && (
        <div className="card compact-detail">
          <div className="small-muted">Tonight's plan for tomorrow</div>
          <textarea
            placeholder="Plan tomorrow's priorities before you sleep..." disabled={!isOwner}
            value={plannerDraft} onChange={(e) => setPlannerDraft(e.target.value)}
          />
          <div style={{ textAlign: "right", marginTop: 6 }}>
            <button
              className="btn sm" disabled={!isOwner}
              onClick={() => setPlans((prev) => ({ ...prev, [addDays(t, 1)]: plannerDraft }))}
            >
              Save Plan
            </button>
          </div>
        </div>
      )}

      <div className="section-title">Week {weekN} Calendar</div>
      <div className="card">
        <div className="week-nav">
          <button className="btn ghost sm" disabled>←</button>
          <b>Week {weekN}</b>
          <button className="btn ghost sm" disabled>→</button>
        </div>
        <div className="dots">
          {Array.from({ length: 7 }).map((_, i) => {
            const d = addDays(wStart, i);
            const dr = days[d];
            let cls = "";
            if (d > t) cls = "";
            else if (dr && dr.leave) cls = "y";
            else if (dr) cls = dayXP(days, config.tasks, d) >= config.threshold ? "g" : "r";
            else cls = d < t ? "r" : "";
            return (
              <div className="day-dot" key={d}>
                <div className={`dot ${cls} ${d === t ? "today" : ""}`} />
                {["S", "M", "T", "W", "T", "F", "S"][i]}
              </div>
            );
          })}
        </div>
        <div className="small-muted" style={{ marginTop: 10 }}>🟢 sufficient XP · 🟡 leave day · 🔴 insufficient XP</div>
        {isOwner && (
          <div style={{ textAlign: "right", marginTop: 10 }}>
            <button className="btn ghost sm" onClick={() => updateRec({ leave: !rec.leave })}>
              {rec.leave ? "Undo leave for today" : "Mark today as paid leave"}
            </button>
          </div>
        )}
      </div>

      <div className="section-title">Daily Tasks</div>
      <div className="card">
        {Object.entries(config.tasks).map(([key, cat]) => (
          <div className="task-group" key={key}>
            <div className="task-group-title">{cat.icon} {cat.label}</div>
            {cat.tasks.map((tk) => (
              <TaskRow
                key={tk.id} id={tk.id} name={tk.name} xp={tk.xp}
                done={!!rec.tasksDone[tk.id]} disabled={!isOwner}
                onToggle={() => toggleTask(key, tk.id)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="section-title">Aspects</div>
      <div className="aspect-strip">
        {Object.entries(config.tasks).map(([key, cat]) => {
          const earned = cat.tasks.reduce((s, tk) => s + (rec.tasksDone[tk.id] ? tk.xp : 0), 0);
          const pct = cat.max ? earned / cat.max : 0;
          return (
            <div className="aspect-mini" key={key} onClick={() => setOpenAspect((a) => (a === key ? null : key))}>
              <Ring pct={pct} size={48} />
              <div className="name">{cat.icon} {cat.label}</div>
            </div>
          );
        })}
      </div>
      {openAspect && (
        <div className="card" id="aspect-detail" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>
            {config.tasks[openAspect].icon} {config.tasks[openAspect].label}
          </div>
          {config.tasks[openAspect].tasks.map((tk) => (
            <TaskRow
              key={tk.id} id={tk.id} name={tk.name} xp={tk.xp}
              done={!!rec.tasksDone[tk.id]} disabled={!isOwner}
              onToggle={() => toggleTask(openAspect, tk.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

/* ============================= WEEKLY TAB ============================= */
function WeeklyTab({ achievements, setAchievements, isOwner, afterAchChange }) {
  const [chapterDraft, setChapterDraft] = useState(achievements.chapters);
  useEffect(() => setChapterDraft(achievements.chapters), [achievements.chapters]);

  const arcs = [
    { key: "arcI", label: "Arc I — Foundation", weeks: "Weeks 1–11", max: 5, desc: "Hardest half of NEET syllabus · learn driving · progress toward 4kg loss." },
    { key: "arcII", label: "Arc II — Evolution", weeks: "Weeks 12–22", max: 5, desc: "Remaining syllabus · whole-syllabus revision · The Laws of Human Nature · progress toward 4kg loss." },
    { key: "arcIII", label: "Arc III — Ascension", weeks: "Weeks 23–33", max: 5, desc: "30 tests + revision · Atomic Habits · progress toward 4kg loss." },
  ];

  const patchAch = (patch) => {
    setAchievements((prev) => ({ ...prev, ...patch }));
    afterAchChange();
  };

  return (
    <>
      <div className="section-title">
        Consistency &amp; Completion
        <span className="small-muted" style={{ textTransform: "none", fontWeight: 500 }}>0.125 pt / chapter · 80 chapters</span>
      </div>
      <div className="card">
        <div className="ach-head"><span>Chapters completed</span><span>{chaptersScore(achievements).toFixed(2)}/10</span></div>
        <div className="progress-line">
          <div className="track"><div className="fill" style={{ width: `${(achievements.chapters / TOTAL_CHAPTERS) * 100}%` }} /></div>
          <b>{achievements.chapters}/80</b>
        </div>
        <div className="chapter-input">
          <button className="btn ghost sm" disabled={!isOwner} onClick={() => setChapterDraft((v) => clamp(v - 1, 0, 80))}>−</button>
          <input type="number" value={chapterDraft} disabled={!isOwner} onChange={(e) => setChapterDraft(Number(e.target.value) || 0)} />
          <button className="btn ghost sm" disabled={!isOwner} onClick={() => setChapterDraft((v) => clamp(v + 1, 0, 80))}>+</button>
          <button className="btn sm" disabled={!isOwner} onClick={() => patchAch({ chapters: clamp(chapterDraft, 0, 80) })}>Save</button>
        </div>
      </div>

      <div className="section-title">
        The Three Arcs
        <span className="small-muted" style={{ textTransform: "none", fontWeight: 500 }}>5 pts each · 4kg loss objective</span>
      </div>
      <div className="card">
        {arcs.map((a) => (
          <div className="ach-row" key={a.key}>
            <div className="ach-head">
              <span>{a.label} <span className="small-muted">({a.weeks})</span></span>
              <span>{achievements[a.key]}/{a.max}</span>
            </div>
            <div className="arc-desc">{a.desc}</div>
            <Stepper value={achievements[a.key]} max={a.max} disabled={!isOwner} onSet={(v) => patchAch({ [a.key]: clamp(v, 0, a.max) })} />
          </div>
        ))}
      </div>

      <div className="section-title">
        Milestones
        <span className="small-muted" style={{ textTransform: "none", fontWeight: 500 }}>6 total · 1 pt each · auto-hit on rank-up</span>
      </div>
      <div className="card">
        <div className="milestone-grid">
          {achievements.milestones.map((on, i) => (
            <div
              key={i} className={`ms ${on ? "on" : ""}`}
              onClick={() => {
                if (!isOwner) return;
                const next = [...achievements.milestones];
                next[i] = !next[i];
                patchAch({ milestones: next });
              }}
            >
              Milestone {i + 1}
            </div>
          ))}
        </div>
      </div>

      <div className="section-title">Driving <span className="small-muted" style={{ textTransform: "none", fontWeight: 500 }}>3 pts</span></div>
      <div className="card">
        <div className="ach-head"><span>Driving progression</span><span>{achievements.driving}/3</span></div>
        <Stepper value={achievements.driving} max={3} disabled={!isOwner} onSet={(v) => patchAch({ driving: clamp(v, 0, 3) })} />
      </div>

      <div className="section-title">Reading Quests</div>
      <div className="card">
        <div className="toggle-row">
          <span>The Laws of Human Nature <span className="small-muted">(Arc II · 3 pts)</span></span>
          <SwitchToggle on={achievements.bookLHN} disabled={!isOwner} onClick={() => patchAch({ bookLHN: !achievements.bookLHN })} />
        </div>
        <div className="toggle-row">
          <span>Atomic Habits <span className="small-muted">(Arc III · 3 pts)</span></span>
          <SwitchToggle on={achievements.bookAH} disabled={!isOwner} onClick={() => patchAch({ bookAH: !achievements.bookAH })} />
        </div>
      </div>
    </>
  );
}

/* ============================= PENALTIES TAB ============================= */
function PenaltiesTab({ config, days, setDays, achievements, penaltyLog, isOwner }) {
  const w = currentWeek(config);
  const misses = weekMissCount(days, config.tasks, config, w);
  const pen = penaltyForMisses(misses);
  const history = penaltyLog.slice(-15).reverse();
  const t = todayStr();
  const rec = days[t] || { hardMode: {} };

  const toggleHardMode = (id) => {
    if (!isOwner) return;
    const current = days[t] || { hardMode: {} };
    const nextHM = { ...(current.hardMode || {}), [id]: !current.hardMode?.[id] };
    setDays((prev) => ({ ...prev, [t]: { ...(prev[t] || rec), hardMode: nextHM } }));
  };

  return (
    <>
      <div className="section-title">Current Status — Week {w}</div>
      <div className={`pen-active pen-level${pen.level}`}>
        <div style={{ fontSize: 15 }}>{pen.name}</div>
        <div className="small-muted" style={{ marginTop: 6, fontWeight: 500 }}>{pen.desc}</div>
        <div className="small-muted" style={{ marginTop: 10, fontWeight: 500 }}>
          {misses} miss{misses === 1 ? "" : "es"} logged this week
        </div>
      </div>

      {pen.level === 5 && (
        <>
          <div className="section-title">
            Hard Mode Protocol <span className="small-muted" style={{ textTransform: "none", fontWeight: 500 }}>active — 3 days</span>
          </div>
          <div className="card">
            {HARD_MODE_TASKS.map((h) => (
              <TaskRow
                key={h.id} id={h.id} name={h.name} xp={null}
                done={!!rec.hardMode?.[h.id]} disabled={!isOwner}
                onToggle={() => toggleHardMode(h.id)}
              />
            ))}
          </div>
        </>
      )}

      <div className="section-title">Penalty Ladder</div>
      <div className="card pen-list">
        {[1, 2, 3, 4, 5].map((n) => {
          const p = penaltyForMisses(n);
          return (
            <div className="task-row" key={n}>
              <span className="badge">{p.name}</span>
              <div className="task-name" style={{ marginLeft: 10 }}>{p.desc}</div>
            </div>
          );
        })}
      </div>

      <div className="section-title">Recent Auto-Log</div>
      <div className="card">
        {history.length ? (
          history.map((h, i) => (
            <div className="task-row" key={i}>
              <div className="task-name">Week {h.week} — {h.name}</div>
              <div className="task-xp">{h.ts}</div>
            </div>
          ))
        ) : (
          <div className="small-muted">No penalties logged yet. Stay clean.</div>
        )}
      </div>

      <div className="section-title">Paid Leave</div>
      <div className="card">
        <div className="small-muted">
          7 self-chosen paid-leave days across the campaign. Mark a day as leave from Home — it won't count as a miss.
        </div>
        <div style={{ marginTop: 10, fontWeight: 700 }}>
          {Object.values(days).filter((d) => d.leave).length} / 7 used
        </div>
      </div>
    </>
  );
}

/* ============================= SETTINGS TAB ============================= */
function SettingsTab({ config, setConfig, isOwner, setIsOwner, onRequestNotifPermission, onResetCampaign }) {
  const [pinInput, setPinInput] = useState("");
  const [pinTry, setPinTry] = useState("");
  const [alarmDraft, setAlarmDraft] = useState(config.alarmTime || "");
  const [startDateDraft, setStartDateDraft] = useState(config.startDate);
  const [thresholdDraft, setThresholdDraft] = useState(config.threshold);
  const [taskDrafts, setTaskDrafts] = useState(() =>
    Object.fromEntries(Object.entries(config.tasks).map(([k, cat]) => [k, cat.tasks.map((t) => ({ ...t }))]))
  );

  const patchConfig = (patch) => setConfig((prev) => ({ ...prev, ...patch }));

  const saveTaskEdit = (key) => {
    const cat = config.tasks[key];
    const newTasks = rebalance(taskDrafts[key], cat.max);
    patchConfig({ tasks: { ...config.tasks, [key]: { ...cat, tasks: newTasks } } });
    setTaskDrafts((prev) => ({ ...prev, [key]: newTasks.map((t) => ({ ...t })) }));
  };

  const deleteTaskDraft = (key, id) => {
    setTaskDrafts((prev) => ({ ...prev, [key]: prev[key].filter((t) => t.id !== id) }));
  };
  const addTaskDraft = (key) => {
    setTaskDrafts((prev) => ({ ...prev, [key]: [...prev[key], { id: "t_" + uid(), name: "New task", xp: 5 }] }));
  };

  return (
    <>
      <div className="section-title">Access</div>
      <div className="card">
        <div className="lockbar">
          {isOwner ? "🔓 Owner mode — you can edit everything." : "🔒 View-only mode — you can watch progress but not edit it."}
        </div>
        {isOwner ? (
          <>
            <div className="small-muted">Set / change your edit PIN so shared viewers can't edit.</div>
            <div className="field-row">
              <input type="text" placeholder="New PIN" value={pinInput} onChange={(e) => setPinInput(e.target.value)} />
              <button className="btn sm" onClick={() => { patchConfig({ pin: pinInput }); }}>Save PIN</button>
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="btn ghost sm" onClick={() => setIsOwner(false)}>Lock editing (switch to view-only)</button>
            </div>
          </>
        ) : (
          <div className="field-row">
            <input type="password" placeholder="Enter PIN to unlock editing" value={pinTry} onChange={(e) => setPinTry(e.target.value)} />
            <button
              className="btn sm"
              onClick={() => {
                if (config.pin === "" || pinTry === config.pin) setIsOwner(true);
                else alert("Wrong PIN.");
              }}
            >
              Unlock
            </button>
          </div>
        )}
      </div>

      <div className="section-title">Appearance — 5 Themes</div>
      <div className="card">
        <div className="swatch-row">
          {THEMES.map((th) => (
            <div
              key={th.id} className={`theme-swatch ${config.theme === th.id ? "sel" : ""}`} title={th.label}
              onClick={() => patchConfig({ theme: th.id })}
            >
              {th.ic}
            </div>
          ))}
        </div>
        <div className="small-muted" style={{ marginTop: 10 }}>Accent colour</div>
        <div className="swatch-row">
          {ACCENTS.map((c) => (
            <div
              key={c} className={`swatch ${config.accent === c ? "sel" : ""}`} style={{ background: c }}
              onClick={() => patchConfig({ accent: c })}
            />
          ))}
        </div>
      </div>

      <div className="section-title">Alarm</div>
      <div className="card">
        <div className="small-muted">
          Set a daily wake alarm (sounds while the app is open in a browser tab — for a true background alarm, keep this tab open or use your phone's own clock app alongside it).
        </div>
        <div className="field-row">
          <input type="time" value={alarmDraft} disabled={!isOwner} onChange={(e) => setAlarmDraft(e.target.value)} />
          <button
            className="btn sm" disabled={!isOwner}
            onClick={() => { patchConfig({ alarmTime: alarmDraft }); onRequestNotifPermission(); }}
          >
            Save
          </button>
        </div>
      </div>

      <div className="section-title">Campaign</div>
      <div className="card">
        <div className="small-muted">Campaign start date</div>
        <div className="field-row">
          <input type="date" value={startDateDraft} disabled={!isOwner} onChange={(e) => setStartDateDraft(e.target.value)} />
        </div>
        <div className="small-muted" style={{ marginTop: 12 }}>XP threshold to count a day as "sufficient"</div>
        <div className="field-row">
          <input type="number" value={thresholdDraft} disabled={!isOwner} onChange={(e) => setThresholdDraft(Number(e.target.value) || 0)} />
        </div>
        {isOwner && (
          <div style={{ textAlign: "right", marginTop: 8 }}>
            <button
              className="btn sm"
              onClick={() => patchConfig({ startDate: startDateDraft || config.startDate, threshold: thresholdDraft || 70 })}
            >
              Save
            </button>
          </div>
        )}
        {isOwner && config.started && (
          <div style={{ marginTop: 14 }}>
            <button className="btn ghost sm" onClick={onResetCampaign}>Reset &amp; show Start screen again</button>
          </div>
        )}
      </div>

      <div className="section-title">Customize Daily Tasks</div>
      {Object.entries(config.tasks).map(([key, cat]) => (
        <div className="card" key={key}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>
            {cat.icon} {cat.label} <span className="small-muted">(max {cat.max} XP)</span>
          </div>
          {taskDrafts[key].map((tk) => (
            <div className="edit-task-row" key={tk.id}>
              <input
                type="text" value={tk.name} disabled={!isOwner}
                onChange={(e) =>
                  setTaskDrafts((prev) => ({
                    ...prev,
                    [key]: prev[key].map((x) => (x.id === tk.id ? { ...x, name: e.target.value } : x)),
                  }))
                }
              />
              <input
                type="number" value={tk.xp} disabled={!isOwner}
                onChange={(e) =>
                  setTaskDrafts((prev) => ({
                    ...prev,
                    [key]: prev[key].map((x) => (x.id === tk.id ? { ...x, xp: Number(e.target.value) || 1 } : x)),
                  }))
                }
              />
              {isOwner && (
                <button className="iconbtn" onClick={() => deleteTaskDraft(key, tk.id)}>🗑️</button>
              )}
            </div>
          ))}
          {isOwner && (
            <div style={{ textAlign: "right", marginTop: 8, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn ghost sm" onClick={() => addTaskDraft(key)}>+ Add task</button>
              <button className="btn sm" onClick={() => saveTaskEdit(key)}>Save &amp; Rebalance</button>
            </div>
          )}
        </div>
      ))}

      <div className="section-title">Sharing</div>
      <div className="card">
        <div className="small-muted">Share this app's link with anyone — they'll see your live progress. Without your PIN, they can't edit anything.</div>
      </div>
    </>
  );
}

/* ============================= SPARKLE LAYER ============================= */
function SparkleLayer() {
  const sparkles = useMemo(() => {
    const emojis = ["🐱", "✨", "💖", "🌸", "⭐"];
    return Array.from({ length: 14 }).map((_, i) => ({
      key: i,
      emoji: emojis[i % emojis.length],
      left: Math.random() * 100,
      duration: 8 + Math.random() * 10,
      delay: Math.random() * 10,
      size: 14 + Math.random() * 14,
    }));
  }, []);
  return (
    <div className="sparkle-layer">
      {sparkles.map((s) => (
        <span
          key={s.key}
          style={{ left: `${s.left}%`, animationDuration: `${s.duration}s`, animationDelay: `${s.delay}s`, fontSize: s.size }}
        >
          {s.emoji}
        </span>
      ))}
    </div>
  );
}

/* ============================= MAIN APP ============================= */
const TABS = [
  { id: "home", label: "Home", ic: "🏠" },
  { id: "weekly", label: "Weekly/Monthly", ic: "🗓️" },
  { id: "penalties", label: "Penalties", ic: "⚔️" },
  { id: "settings", label: "Settings", ic: "⚙️" },
];

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [achievements, setAchievements] = useState(DEFAULT_ACH);
  const [days, setDays] = useState({});
  const [plans, setPlans] = useState({});
  const [penaltyLog, setPenaltyLog] = useState([]);
  const [activeTab, setActiveTab] = useState("home");
  const [isOwner, setIsOwner] = useState(true);
  const [installEvent, setInstallEvent] = useState(null);
  const [syncStatus, setSyncStatus] = useState(SYNC_ENABLED ? "loading" : "offline");

  // Tracks whether the current in-memory state has local edits Firestore
  // hasn't confirmed yet, so an incoming snapshot never clobbers a change
  // the person just made. Also used to skip the "mark dirty" step right
  // after we apply a remote snapshot ourselves.
  const dirtyRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const saveTimerRef = useRef(null);

  // pull-to-refresh
  const scrollRef = useRef(null);
  const [ptrY, setPtrY] = useState(-50);
  const [ptrSpin, setPtrSpin] = useState(false);
  const touchState = useRef({ startY: null, pulling: false });

  /* ---- load from localStorage on mount ---- */
  useEffect(() => {
    setConfig((prev) => ({ ...prev, ...lsGet(LS_KEYS.config, {}) }));
    setAchievements((prev) => ({ ...prev, ...lsGet(LS_KEYS.achievements, {}) }));
    setDays(lsGet(LS_KEYS.days, {}));
    setPlans(lsGet(LS_KEYS.plans, {}));
    setPenaltyLog(lsGet(LS_KEYS.penaltyLog, []));
    setIsOwner(lsGet(LS_KEYS.config, {}).ownerUnlocked ?? true);
    setLoaded(true);
  }, []);

  /* ---- persist to localStorage on every change (offline cache) ---- */
  useEffect(() => { if (loaded) lsSet(LS_KEYS.config, { ...config, ownerUnlocked: isOwner }); }, [config, isOwner, loaded]);
  useEffect(() => { if (loaded) lsSet(LS_KEYS.achievements, achievements); }, [achievements, loaded]);
  useEffect(() => { if (loaded) lsSet(LS_KEYS.days, days); }, [days, loaded]);
  useEffect(() => { if (loaded) lsSet(LS_KEYS.plans, plans); }, [plans, loaded]);
  useEffect(() => { if (loaded) lsSet(LS_KEYS.penaltyLog, penaltyLog); }, [penaltyLog, loaded]);

  /* ---- Firestore: live subscription to the single shared doc ---- */
  useEffect(() => {
    if (!loaded) return;
    if (!SYNC_ENABLED) { setSyncStatus("offline"); return; }

    const ref = doc(db, ASCEND_COLLECTION, MAIN_DOC_ID);
    const unsub = onSnapshot(
      ref,
      async (snap) => {
        if (snap.exists()) {
          if (!dirtyRef.current) {
            const data = snap.data();
            applyingRemoteRef.current = true;
            setConfig((prev) => ({ ...prev, ...(data.config || {}), ownerUnlocked: prev.ownerUnlocked }));
            setAchievements((prev) => ({ ...DEFAULT_ACH, ...(data.achievements || {}) }));
            setDays(data.days || {});
            setPlans(data.plans || {});
            setPenaltyLog(data.penaltyLog || []);
          }
          setSyncStatus("synced");
        } else if (isOwner) {
          // First device to connect creates the shared document.
          const initial = { config, achievements, days, plans, penaltyLog };
          try { await setDoc(ref, initial); } catch { setSyncStatus("error"); }
          setSyncStatus("synced");
        } else {
          setSyncStatus("synced");
        }
      },
      () => setSyncStatus("offline")
    );
    return () => unsub();
    // Only (re)subscribe once loaded — the callback closes over fresh state via refs/updaters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /* ---- Firestore: debounced write-back whenever local state changes ---- */
  useEffect(() => {
    if (!loaded || !SYNC_ENABLED) return;
    if (applyingRemoteRef.current) { applyingRemoteRef.current = false; return; }
    if (!isOwner) return; // view-only devices never write

    dirtyRef.current = true;
    setSyncStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const ref = doc(db, ASCEND_COLLECTION, MAIN_DOC_ID);
      setDoc(ref, { config, achievements, days, plans, penaltyLog })
        .then(() => { dirtyRef.current = false; setSyncStatus("synced"); })
        .catch(() => setSyncStatus("error"));
    }, 600);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, achievements, days, plans, penaltyLog, loaded, isOwner]);

  /* ---- derived scoring ---- */
  const score = useMemo(() => finalScore(days, config.tasks, achievements), [days, config.tasks, achievements]);
  const rank = useMemo(() => rankFor(score), [score]);
  const arcLabel = currentArcLabel(config);
  currentArcLabel.__lastLabel = `${arcLabel} · Week ${currentWeek(config)} / 33`;
  const celebrating = Date.now() < (config.celebrationUntil || 0);

  /* ---- rank-up auto-check ---- */
  const checkRankUp = useCallback(() => {
    const s = finalScore(days, config.tasks, achievements);
    const tier = tierFor(s);
    if (tier > config.lastRankTier) {
      const nextMs = achievements.milestones.findIndex((m) => !m);
      setAchievements((prev) => {
        if (nextMs === -1) return prev;
        const next = [...prev.milestones];
        next[nextMs] = true;
        return { ...prev, milestones: next };
      });
      setConfig((prev) => ({ ...prev, lastRankTier: tier, celebrationUntil: Date.now() + 12 * 3600 * 1000 }));
    }
  }, [days, config.tasks, config.lastRankTier, achievements]);

  useEffect(() => { if (loaded) checkRankUp(); }, [score, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- penalty auto-log ---- */
  const checkPenaltyAutoLog = useCallback(() => {
    const w = currentWeek(config);
    const misses = weekMissCount(days, config.tasks, config, w);
    const pen = penaltyForMisses(misses);
    setPenaltyLog((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.week !== w || last.level !== pen.level) {
        return [...prev, { week: w, level: pen.level, name: pen.name, ts: todayStr() }];
      }
      return prev;
    });
  }, [days, config]);

  useEffect(() => { if (loaded) checkPenaltyAutoLog(); }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- alarm ---- */
  const beep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; o.type = "sine";
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      o.start();
      for (let i = 0; i < 4; i++) {
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25 + i * 0.5);
        g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.35 + i * 0.5);
      }
      o.stop(ctx.currentTime + 2.2);
    } catch (e) {}
  };
  const requestNotifPermission = () => {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  };
  useEffect(() => {
    const iv = setInterval(() => {
      if (!config.alarmTime) return;
      const now = new Date();
      const hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
      const todayKey = todayStr() + "_" + config.alarmTime;
      if (hhmm === config.alarmTime && config.lastAlarmFired !== todayKey) {
        setConfig((prev) => ({ ...prev, lastAlarmFired: todayKey }));
        beep();
        if ("Notification" in window && Notification.permission === "granted") {
          try { new Notification("ASCEND", { body: "Wake up. The campaign doesn't pause.", icon: "icon-192.png" }); } catch (e) {}
        }
      }
    }, 15000);
    return () => clearInterval(iv);
  }, [config.alarmTime, config.lastAlarmFired]);

  /* ---- PWA install prompt + service worker ---- */
  useEffect(() => {
    const onBeforeInstall = (e) => { e.preventDefault(); setInstallEvent(e); };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
      window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  /* ---- pull to refresh (visual only — there's no remote source to refresh from) ---- */
  const onTouchStart = (e) => {
    const el = scrollRef.current;
    if (el && el.scrollTop <= 0) { touchState.current.startY = e.touches[0].clientY; touchState.current.pulling = true; }
  };
  const onTouchMove = (e) => {
    const el = scrollRef.current;
    if (!touchState.current.pulling || touchState.current.startY === null) return;
    const diff = e.touches[0].clientY - touchState.current.startY;
    if (diff > 0 && el.scrollTop <= 0) setPtrY(Math.min(20, diff / 3 - 30));
  };
  const onTouchEnd = () => {
    if (!touchState.current.pulling) return;
    if (ptrY >= 10) {
      setPtrSpin(true);
      setTimeout(() => { setPtrSpin(false); setPtrY(-50); }, 500);
    } else {
      setPtrY(-50);
    }
    touchState.current.pulling = false;
    touchState.current.startY = null;
  };

  if (!loaded) return null;

  return (
    <div className="ascend-app" data-theme={config.theme} style={{ "--accent": config.accent, "--accent2": config.accent }}>
      <style>{STYLES}</style>
      <SparkleLayer />
      <div className="app">
        <div className={`ptr ${ptrSpin ? "spin" : ""} ${ptrY <= -50 ? "hidden" : ""}`} style={{ top: ptrY }}>🔄</div>
        <Hud score={score} rank={rank} celebrating={celebrating} syncStatus={syncStatus} />
        <div
          className="scroll" id="page" ref={scrollRef}
          onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        >
          {!config.started ? (
            <StartGate isOwner={isOwner} onStart={() => setConfig((prev) => ({ ...prev, started: true, startDate: todayStr() }))} />
          ) : (
            <>
              {activeTab === "home" && (
                <HomeTab
                  config={config} setConfig={setConfig} days={days} setDays={setDays}
                  plans={plans} setPlans={setPlans} isOwner={isOwner}
                  onAfterTaskToggle={() => { checkRankUp(); checkPenaltyAutoLog(); }}
                />
              )}
              {activeTab === "weekly" && (
                <WeeklyTab
                  achievements={achievements} setAchievements={setAchievements} isOwner={isOwner}
                  afterAchChange={checkRankUp}
                />
              )}
              {activeTab === "penalties" && (
                <PenaltiesTab config={config} days={days} setDays={setDays} achievements={achievements} penaltyLog={penaltyLog} isOwner={isOwner} />
              )}
              {activeTab === "settings" && (
                <SettingsTab
                  config={config} setConfig={setConfig} isOwner={isOwner} setIsOwner={setIsOwner}
                  onRequestNotifPermission={requestNotifPermission}
                  onResetCampaign={() => setConfig((prev) => ({ ...prev, started: false }))}
                />
              )}
            </>
          )}
        </div>
        <div className="tabbar">
          {TABS.map((tab) => (
            <button
              key={tab.id} className={`tab ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="ic">{tab.ic}</span>
              {tab.label}
            </button>
          ))}
        </div>
        {installEvent && (
          <button
            style={{
              position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 78, zIndex: 40,
              background: "var(--accent)", color: "#fff", border: "none", padding: "10px 18px",
              borderRadius: 30, fontWeight: 800, fontSize: 13, boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
            }}
            onClick={async () => { installEvent.prompt(); await installEvent.userChoice; setInstallEvent(null); }}
          >
            ⬇ Install App
          </button>
        )}
      </div>
    </div>
  );
}
