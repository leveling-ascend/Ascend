import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
import { db, ASCEND_COLLECTION } from "./firebase.js";

/* =================================================================
   ASCEND: The Takeover — React port

   NOTE ON THIS REVISION
   This is a large rework covering: flattened daily-task lists,
   an editable-past-days calendar (Monday-start, fixed campaign
   start of 17 Aug 2026), a Skills achievement panel, a rebuilt
   scoring model, a single-login owner/viewer flow with an
   activity log, animated (non-emoji) theme swatches, ringtone
   alarms, and a "Final Ascent" S+ completion path. The scoring
   weights were rebalanced so the total still adds up to exactly
   100 points — see the comments beside each score function for
   the breakdown.
================================================================= */

const SYNC_ENABLED = true;
const MAIN_DOC_ID = "main";

/* ============================= CONSTANTS ============================= */
const CAMPAIGN_START = "2026-08-17"; // Monday, 17 Aug 2026, IST — fixed, no longer editable
const CAMPAIGN_DAYS = 231;
const TOTAL_CHAPTERS = 80;
const PAID_LEAVE_MAX = 7;
const LEAVE_MAX = 27;

const RANK_NAMES = ["E", "D", "C", "B", "A", "S", "S+"];
const RANK_COLORS = [
  ["#4c5164", "#6d7386"],
  ["#7a5636", "#b0824f"],
  ["#2f6fe0", "#6fa8ff"],
  ["#0fae9e", "#5be0d0"],
  ["#8b3fe0", "#c08bff"],
  ["#e8b400", "#ffe873"],
  ["#fff7d6", "#ffd700"],
];
function tierFor(score) {
  return Math.min(5, Math.floor(clamp(score, 0, 100) / 18));
}
function rankFor(score, finalAscent) {
  if (finalAscent) return { name: "S+", tier: 6, glow: RANK_COLORS[6] };
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
  { id: "dark", label: "Obsidian" },
  { id: "light", label: "Daylight" },
];

const ACCENTS = ["#7c5cff", "#ff5c8a", "#3ddc84", "#ffb14d", "#4fd0ff", "#ff5c5c", "#c08bff"];

/* -- daily tasks: Strength, Intellect, Discipline (Skills moved to achievements) -- */
const DEFAULT_TASKS = {
  strength: {
    label: "Strength & Fitness", icon: "💪",
    tasks: [
      { id: "walk", name: "4 km walk", xp: 10 },
      { id: "exercise", name: "Exercise", xp: 12 },
      { id: "protein", name: "60g protein", xp: 8 },
    ],
  },
  intellect: {
    label: "Intellect", icon: "🧠",
    tasks: [
      { id: "study", name: "Study", xp: 20 },
      { id: "revision", name: "Revision", xp: 10 },
      { id: "questions", name: "Questions", xp: 10 },
    ],
  },
  discipline: {
    label: "Discipline", icon: "🔥",
    tasks: [
      { id: "water", name: "Adequate water", xp: 11 },
      { id: "wake", name: "Wake at 7:00 AM", xp: 8 },
      { id: "skincare", name: "Skincare", xp: 4 },
      { id: "haircare", name: "Hair care", xp: 3 },
      { id: "brush", name: "Brush teeth twice", xp: 4 },
      { id: "shower", name: "Shower", xp: 3 },
    ],
  },
};
const TASK_CATEGORY_KEYS = ["strength", "intellect", "discipline"];
// Strip any stray/legacy category (e.g. an old "skills" category from a
// previous version) out of synced/stored data — only these 3 are ever valid.
// Without this, stale data saved before Skills became achievement-only can
// silently reappear as a phantom 4th category and duplicate the Skills tile.
function sanitizeTasks(tasks) {
  const clean = {};
  for (const key of TASK_CATEGORY_KEYS) {
    clean[key] = (tasks && tasks[key]) || DEFAULT_TASKS[key];
  }
  return clean;
}

/* -- achievements: chapters + weight-loss-per-arc (25 pts) + milestones/skills (15 pts) -- */
const DEFAULT_ACH = {
  chapters: 0,
  weightLossArcI: false,
  weightLossArcII: false,
  weightLossArcIII: false,
  milestones: [false, false, false, false, false, false],
  driving: false,
  bookLHN: false,
  bookAH: false,
  bookNew: false,
  finalAscent: false,
};

const DEFAULT_SKILL_XP = { driving: 3, bookLHN: 2, bookAH: 2, bookNew: 2 };
const DEFAULT_BOOK_NAMES = { bookLHN: "The Laws of Human Nature", bookAH: "Atomic Habits", bookNew: "New Book" };
const DEFAULT_WEIGHTLOSS_XP = { arcI: 5, arcII: 5, arcIII: 5 };

const DEFAULT_CONFIG = {
  theme: "dark", accent: "#ff5fa8", threshold: 70,
  started: false,
  pinSet: false, pin: "", viewerPassword: "", loginLog: [],
  lastRankTier: 0, celebrationUntil: 0, gameCompleted: false,
  weightLossXP: DEFAULT_WEIGHTLOSS_XP, skillXP: DEFAULT_SKILL_XP, bookNames: DEFAULT_BOOK_NAMES,
  tasks: DEFAULT_TASKS,
};

/* ============================= UTIL ============================= */
function todayStr(baseDate) {
  // "Now", anchored to India Standard Time (UTC+5:30, no DST) — NOT the
  // device's own clock/timezone. getTime() is always an absolute UTC epoch
  // regardless of device settings, so shifting it by +5:30 and reading the
  // UTC fields back out gives the correct IST calendar date on any device,
  // anywhere in the world.
  const now = baseDate || new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// Pure calendar-date arithmetic on YYYY-MM-DD strings, done entirely in UTC
// so it never depends on (or is thrown off by) the device's timezone.
function addDays(str, n) {
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function weekOf(dateStr, startDate) {
  const [ay, am, ad] = startDate.split("-").map(Number);
  const [by, bm, bd] = dateStr.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad), b = Date.UTC(by, bm - 1, bd);
  const diff = Math.round((b - a) / 86400000);
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
function fmtDate(dstr) {
  const [y, m, d] = dstr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/* ============================= LOCAL STORAGE ============================= */
const LS_KEYS = {
  config: "ascend:config",
  achievements: "ascend:achievements",
  days: "ascend:days",
  plans: "ascend:plans",
  penaltyLog: "ascend:penaltylog",
  auth: "ascend:auth",
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
// Daily tasks max out at 60 pts of the final 100 (ratio of everything ever logged
// vs. the theoretical max for the whole 231-day campaign).
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
function perDayMax(taskDefs) {
  return Object.values(taskDefs).reduce((s, cat) => s + cat.tasks.reduce((ss, t) => ss + t.xp, 0), 0);
}
function dailyDisciplineScore(days, taskDefs) {
  const totalMax = perDayMax(taskDefs) * CAMPAIGN_DAYS;
  return totalMax ? (totalDailyXP(days, taskDefs) / totalMax) * 60 : 0;
}
function chaptersScore(achievements) {
  return clamp(achievements.chapters, 0, TOTAL_CHAPTERS) * (10 / TOTAL_CHAPTERS);
}
// Achievements: chapters(10) + weight-loss per arc (5 each = 15) = 25 pts
function achievementScore(config, achievements) {
  const wl = config.weightLossXP || DEFAULT_WEIGHTLOSS_XP;
  return (
    chaptersScore(achievements) +
    (achievements.weightLossArcI ? (wl.arcI ?? 5) : 0) +
    (achievements.weightLossArcII ? (wl.arcII ?? 5) : 0) +
    (achievements.weightLossArcIII ? (wl.arcIII ?? 5) : 0)
  );
}
// Milestones(6) + driving + 3 books = 15 pts
function milestoneScore(config, achievements) {
  const skillXP = config.skillXP || DEFAULT_SKILL_XP;
  const ms = achievements.milestones.filter(Boolean).length;
  return (
    ms +
    (achievements.driving ? skillXP.driving : 0) +
    (achievements.bookLHN ? skillXP.bookLHN : 0) +
    (achievements.bookAH ? skillXP.bookAH : 0) +
    (achievements.bookNew ? skillXP.bookNew : 0)
  );
}
function finalScore(days, config, achievements) {
  if (achievements.finalAscent) return 100;
  return clamp(
    dailyDisciplineScore(days, config.tasks) + achievementScore(config, achievements) + milestoneScore(config, achievements),
    0,
    100
  );
}
function currentWeek(config) {
  return clamp(weekOf(todayStr(), CAMPAIGN_START), 1, 33);
}
function currentArcLabel(config) {
  const w = currentWeek(config);
  if (w <= 11) return "Arc I — Foundation";
  if (w <= 22) return "Arc II — Evolution";
  return "Arc III — Ascension";
}
function weekMissCount(days, taskDefs, config, weekNum, uptoExclusive) {
  const start = weekStartDate(CAMPAIGN_START, weekNum);
  const limit = uptoExclusive || addDays(todayStr(), 1); // default: include today
  let misses = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    if (d >= limit) continue;
    const rec = days[d];
    if (rec && (rec.leave || rec.leaveOrdinary)) continue;
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
// A miss on day D only puts Hard Mode tasks in front of you starting day D+1 —
// never the same day you missed. Computed by excluding `dateStr` itself from
// the week's miss count.
function penaltyLevelForDate(days, config, dateStr) {
  const wk = clamp(weekOf(dateStr, CAMPAIGN_START), 1, 33);
  const misses = weekMissCount(days, config.tasks, config, wk, dateStr);
  return penaltyForMisses(misses).level;
}
// Flattened list of every daily task, plus the Weight Loss goal (a one-time
// achievement, but shown inline in the same checklist per spec — no aspect
// names shown next to any of them).
function flatDailyTasks(config) {
  const out = [];
  for (const cat of Object.values(config.tasks)) {
    for (const t of cat.tasks) out.push({ ...t, special: null });
  }
  return out;
}
function categoryCampaignPct(days, cat) {
  let earned = 0;
  const catMaxXP = cat.tasks.reduce((s, t) => s + t.xp, 0);
  for (const d of Object.values(days)) {
    for (const t of cat.tasks) if (d.tasksDone && d.tasksDone[t.id]) earned += t.xp;
  }
  const max = catMaxXP * CAMPAIGN_DAYS;
  return max ? clamp(earned / max, 0, 1) : 0;
}
// Skills is achievement-based (driving + the 3 books), not day-by-day —
// its "campaign %" is simply how much of its total XP pool has been earned.
function skillsPct(config, achievements) {
  const sx = config.skillXP || DEFAULT_SKILL_XP;
  const max = (sx.driving || 0) + (sx.bookLHN || 0) + (sx.bookAH || 0) + (sx.bookNew || 0);
  const earned =
    (achievements.driving ? sx.driving : 0) +
    (achievements.bookLHN ? sx.bookLHN : 0) +
    (achievements.bookAH ? sx.bookAH : 0) +
    (achievements.bookNew ? sx.bookNew : 0);
  return max ? clamp(earned / max, 0, 1) : 0;
}


/* ============================= STYLES ============================= */
const STYLES = `
.ascend-app{
  --bg:#0a0c14; --bg2:#11141f; --card:#161a28; --card2:#1d2233;
  --line:rgba(255,255,255,0.08); --text:#eef0f6; --sub:#8890a6; --sub2:#5c6580;
  --accent:#7c5cff; --accent2:#a78bfa; --green:#3ddc84; --yellow:#ffcc4d; --red:#ff5c5c; --blue:#3d8bff;
  --radius:18px; --radius-sm:12px;
  --shadow:0 8px 30px rgba(0,0,0,0.35);
  --font: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.ascend-app[data-theme="light"]{
  --bg:#f3f1ea; --bg2:#ffffff; --card:#ffffff; --card2:#f6f4ee;
  --line:rgba(20,20,30,0.08); --text:#191a22; --sub:#5c6072; --sub2:#8a8fa3;
  --shadow:0 8px 24px rgba(30,20,10,0.10);
}
.ascend-app[data-celebration="true"]{
  --bg:#1a1200; --bg2:#231800; --card:#2a1d00; --card2:#3a2900;
  --line:rgba(255,215,0,0.35); --text:#fff8dc; --sub:#ffd76a; --sub2:#e0b840;
  --accent:#ffd700; --accent2:#fff2a8;
  --shadow:0 0 40px rgba(255,215,0,0.3);
}
.ascend-app{box-sizing:border-box; width:100%; min-height:100vh; background:var(--bg); color:var(--text);
  font-family:var(--font); transition:background .4s ease,color .4s ease; overscroll-behavior-y:none; position:relative;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; text-rendering:optimizeLegibility;}
.ascend-app[data-celebration="true"]{background:linear-gradient(135deg,#1a1200,#2a1d00,#3a2900,#1a1200); background-size:300% 300%; animation:ascendGold 6s ease infinite;}
@keyframes ascendGold{0%{background-position:0% 50%;}50%{background-position:100% 50%;}100%{background-position:0% 50%;}}
.ascend-app *{box-sizing:border-box; -webkit-tap-highlight-color:transparent;}
.ascend-app button,.ascend-app input,.ascend-app textarea,.ascend-app select{font-family:inherit; color:inherit;}
.ascend-app button:focus-visible,.ascend-app input:focus-visible,.ascend-app textarea:focus-visible,.ascend-app select:focus-visible,.ascend-app [tabindex]:focus-visible{
  outline:2px solid var(--accent); outline-offset:2px; border-radius:4px;}
.ascend-app select{background:var(--card2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px; cursor:pointer;}
.ascend-app .app{max-width:520px; margin:0 auto; min-height:100vh; display:flex; flex-direction:column; position:relative; overflow:hidden;}
.ascend-app .scroll{flex:1; overflow-y:auto; padding:14px 14px 100px; -webkit-overflow-scrolling:touch; position:relative;}
.ascend-app .scroll::-webkit-scrollbar{width:0;height:0;}

.ascend-app .sparkle-layer{position:fixed; inset:0; pointer-events:none; z-index:5; overflow:hidden;}
.ascend-app .sparkle-layer span{position:absolute; opacity:.85; display:block;}
.ascend-app .sparkle-layer span.float{animation-name:ascendFloatUp; animation-timing-function:linear; animation-iteration-count:infinite;}
.ascend-app .sparkle-layer span.fall{animation-name:ascendFall; animation-timing-function:linear; animation-iteration-count:infinite;}
.ascend-app .sparkle-layer span.drift{animation-name:ascendDrift; animation-timing-function:linear; animation-iteration-count:infinite;}
.ascend-app .sparkle-layer span.twinkleDrift{animation-name:ascendTwinkleDrift; animation-timing-function:ease-in-out; animation-iteration-count:infinite;}
.ascend-app .sparkle-layer span.shape-dot{border-radius:50%; box-shadow:0 0 6px currentColor;}
.ascend-app .sparkle-layer span.shape-star{border-radius:2px; clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%); box-shadow:0 0 5px currentColor;}
.ascend-app .sparkle-layer span.shape-cloud{border-radius:50%; filter:blur(1.5px); opacity:.55;}
@keyframes ascendFloatUp{0%{transform:translateY(0) rotate(0deg); opacity:0;}10%{opacity:.9;}100%{transform:translateY(-110vh) rotate(360deg); opacity:0;}}
@keyframes ascendFall{0%{transform:translateY(0) rotate(0deg); opacity:0;}10%{opacity:.85;}100%{transform:translateY(110vh) rotate(220deg); opacity:0;}}
@keyframes ascendDrift{0%{transform:translateX(0); opacity:0;}10%{opacity:.75;}90%{opacity:.75;}100%{transform:translateX(120vw); opacity:0;}}
@keyframes ascendTwinkleDrift{0%,100%{opacity:.12;}50%{opacity:.9;}}
.ascend-app .ptr{position:absolute; top:-50px; left:50%; transform:translateX(-50%); width:34px; height:34px; border-radius:50%;
  background:var(--card); border:1px solid var(--line); display:flex; align-items:center; justify-content:center;
  font-size:16px; transition:top .2s ease; z-index:15; box-shadow:var(--shadow);}
.ascend-app .ptr.spin{animation:ascendSpin .7s linear infinite;}
@keyframes ascendSpin{to{transform:translateX(-50%) rotate(360deg);}}

.ascend-app .hud{position:sticky; top:0; z-index:20; padding:16px 16px 14px; background:linear-gradient(180deg,var(--bg) 60%,transparent);
  backdrop-filter:blur(6px);}
.ascend-app .hud-top{display:flex; align-items:center; gap:14px;}
.ascend-app .rank-core{position:relative; width:74px; height:74px; flex:none; border-radius:50%;
  display:flex; align-items:center; justify-content:center; font-weight:800; font-size:20px; letter-spacing:.5px;
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
  background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#1a1200; position:relative; overflow:hidden;}
.ascend-app .celebrate .pop{position:absolute; font-size:18px; animation:ascendPop 1.6s ease-in-out infinite;}
@keyframes ascendPop{0%,100%{transform:translateY(0) scale(1);}50%{transform:translateY(-6px) scale(1.15);}}
.ascend-app .celebrate.grand{font-size:16px; letter-spacing:.5px;}

.ascend-app .tabbar{position:sticky; bottom:0; z-index:30; display:flex; background:var(--card); border-top:1px solid var(--line);
  padding:8px 6px calc(8px + env(safe-area-inset-bottom)); gap:2px; max-width:520px; margin:0 auto; width:100%;}
.ascend-app .tab{flex:1; border:none; background:transparent; padding:8px 2px; border-radius:12px; font-size:10.5px; font-weight:700;
  color:var(--sub); display:flex; flex-direction:column; align-items:center; gap:3px; cursor:pointer; letter-spacing:.3px;}
.ascend-app .tab .ic{font-size:18px;}
.ascend-app .tab.active{color:var(--accent); background:color-mix(in srgb, var(--accent) 14%, transparent);}

.ascend-app .section-title{font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:1.2px; color:var(--sub);
  margin:22px 2px 10px; display:flex; align-items:center; justify-content:space-between; line-height:1.3;}
.ascend-app .card{background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow); margin-bottom:12px;}

.ascend-app .trio{display:grid; grid-template-columns:repeat(4,1fr); gap:6px;}
.ascend-app .trio-card{background:var(--card); border:1px solid var(--line); border-radius:14px; padding:10px 5px; text-align:center; cursor:pointer;
  box-shadow:0 2px 8px rgba(0,0,0,0.12); transition:transform .12s ease;}
.ascend-app .trio-card:active{transform:scale(.96);}
.ascend-app .trio-card .ic{font-size:16px;}
.ascend-app .trio-card b{display:block; font-size:14px; margin-top:2px; line-height:1.2;}
.ascend-app .trio-card span{font-size:9px; color:var(--sub); text-transform:uppercase; letter-spacing:.4px; line-height:1.3;}
.ascend-app .compact-detail{margin-top:10px;}

.ascend-app .aspect-strip{display:flex; justify-content:space-between; gap:8px; margin-top:6px;}
.ascend-app .aspect-mini{flex:1; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:10px 6px; text-align:center; cursor:pointer;
  box-shadow:0 2px 8px rgba(0,0,0,0.12); transition:transform .12s ease;}
.ascend-app .aspect-mini:active{transform:scale(.96);}
.ascend-app .aspect-mini .name{font-size:10px; font-weight:700; margin-top:4px; line-height:1.25;}
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
.ascend-app .chk:active{transform:scale(.9);}
.ascend-app .chk.on{background:var(--green); border-color:var(--green); color:#08130c;}
.ascend-app .task-name{flex:1; font-size:14px; font-weight:600; line-height:1.35;}
.ascend-app .task-xp{font-size:12px; color:var(--sub); font-weight:700;}
.ascend-app .task-row.done .task-name{color:var(--sub); text-decoration:line-through;}
.ascend-app .task-row.static .task-name{font-weight:500;}

.ascend-app .field-row{display:flex; gap:8px; margin-top:10px;}
.ascend-app .field-row input,.ascend-app .field-row textarea{flex:1; background:var(--card2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px; transition:border-color .15s ease;}
.ascend-app textarea{width:100%; min-height:70px; resize:vertical; background:var(--card2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px; margin-top:8px; transition:border-color .15s ease; line-height:1.4;}
.ascend-app input:focus,.ascend-app textarea:focus{border-color:var(--accent);}
.ascend-app .btn{background:var(--accent); color:#fff; border:none; padding:10px 16px; border-radius:10px; font-weight:700; font-size:13px; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center; gap:6px; letter-spacing:.2px; line-height:1.2;
  transition:transform .12s ease, opacity .12s ease, box-shadow .12s ease;}
.ascend-app .btn:active:not(:disabled){transform:scale(.96);}
.ascend-app[data-celebration="true"] .btn{color:#1a1200;}
.ascend-app .btn.ghost{background:transparent; border:1px solid var(--line); color:var(--text);}
.ascend-app .btn.sm{padding:7px 12px; font-size:12px;}
.ascend-app .btn:disabled{opacity:.4; cursor:not-allowed;}
.ascend-app .btn.big{width:100%; padding:16px; font-size:16px; border-radius:16px;}
.ascend-app .btn.gold{background:linear-gradient(135deg,#ffd700,#fff2a8); color:#1a1200;}
.ascend-app .progress-line{display:flex; align-items:center; gap:10px; margin-top:6px;}
.ascend-app .progress-line .track{flex:1; height:10px; border-radius:6px; background:var(--card2); overflow:hidden;}
.ascend-app .progress-line .fill{height:100%; background:linear-gradient(90deg,var(--green),#8ff0b0);}
.ascend-app .small-muted{font-size:11.5px; color:var(--sub);}

.ascend-app .day-header{display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; font-size:12.5px;}
.ascend-app .week-nav{display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;}
.ascend-app .week-nav b{font-size:14px;}
.ascend-app .dots{display:flex;}
.ascend-app .day-dot{flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; font-size:10px; color:var(--sub); cursor:pointer;}
.ascend-app .dot{width:20px; height:20px; border-radius:50%; background:var(--card2); border:2px solid var(--line);}
.ascend-app .dot.g{background:var(--green); border-color:var(--green);}
.ascend-app .dot.y{background:var(--yellow); border-color:var(--yellow);}
.ascend-app .dot.r{background:var(--red); border-color:var(--red);}
.ascend-app .dot.b{background:var(--blue); border-color:var(--blue);}
.ascend-app .dot.today{box-shadow:0 0 0 2px var(--accent);}
.ascend-app .dot.selected{box-shadow:0 0 0 2px var(--text);}

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
.ascend-app .pen-meter{display:flex; gap:4px; margin-top:10px;}
.ascend-app .pen-meter .seg{flex:1; height:8px; border-radius:4px; background:var(--card2); border:1px solid var(--line);}
.ascend-app .pen-meter .seg.on{background:var(--red);}

.ascend-app .swatch-row{display:flex; gap:10px; flex-wrap:wrap; margin-top:8px;}
.ascend-app .theme-swatch{width:68px; height:68px; border-radius:16px; border:2px solid var(--line); cursor:pointer; display:flex; align-items:center; justify-content:center; background:var(--card2); overflow:hidden; position:relative; transition:transform .12s ease, border-color .12s ease;}
.ascend-app .theme-swatch:active{transform:scale(.95);}
.ascend-app .theme-swatch.sel{border-color:var(--accent); transform:scale(1.06);}
.ascend-app .theme-swatch span.tlabel{position:absolute; bottom:1px; left:0; right:0; font-size:7px; text-align:center; font-weight:700; background:rgba(0,0,0,0.35); color:#fff; padding:1px 0;}
.ascend-app .swatch{width:34px; height:34px; border-radius:50%; border:2px solid var(--line); cursor:pointer; transition:transform .12s ease;}
.ascend-app .swatch:active{transform:scale(.9);}
.ascend-app .swatch.sel{border-color:var(--text); transform:scale(1.1);}
.ascend-app .toggle-row{display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom:1px solid var(--line);}
.ascend-app .toggle-row:last-child{border-bottom:none;}
.ascend-app .switch{width:46px; height:26px; border-radius:20px; background:var(--card2); border:1px solid var(--line); position:relative; cursor:pointer; transition:background .15s ease;}
.ascend-app .switch.on{background:var(--accent);}
.ascend-app .switch::after{content:''; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; transition:.2s; box-shadow:0 1px 3px rgba(0,0,0,0.25);}
.ascend-app .switch.on::after{left:22px;}
.ascend-app .edit-task-row{display:flex; gap:6px; align-items:center; padding:8px 0; border-bottom:1px solid var(--line);}
.ascend-app .edit-task-row input[type=text]{flex:1; background:var(--card2); border:1px solid var(--line); border-radius:8px; padding:7px 9px; font-size:13px;}
.ascend-app .edit-task-row input[type=number]{width:56px; background:var(--card2); border:1px solid var(--line); border-radius:8px; padding:7px 6px; font-size:13px; text-align:center;}
.ascend-app .iconbtn{background:none; border:none; color:var(--sub); font-size:16px; cursor:pointer; padding:4px 6px;
  display:inline-flex; align-items:center; justify-content:center; border-radius:6px; transition:color .15s ease, background .15s ease;}
.ascend-app .iconbtn:hover{color:var(--red); background:var(--card2);}
.ascend-app .lockbar{display:flex; align-items:center; gap:8px; background:var(--card2); border:1px solid var(--line); border-radius:12px; padding:10px 12px; margin-bottom:14px; font-size:12.5px;}
.ascend-app .hidden{display:none !important;}
.ascend-app .arc-desc{font-size:12px; color:var(--sub); margin-bottom:8px;}
.ascend-app .log-row{display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--line); font-size:12px;}
.ascend-app .log-row:last-child{border-bottom:none;}

.ascend-app .start-gate{display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:50px 20px;}
.ascend-app .start-gate .big-badge{width:110px; height:110px; border-radius:50%; background:radial-gradient(circle at 35% 30%,var(--accent2),var(--accent)); box-shadow:0 0 40px 6px var(--accent); margin-bottom:18px; display:flex; align-items:center; justify-content:center; font-size:40px;}

/* -- theme swatch animated icons (no emoji) -- */
@keyframes tiTwinkle{0%,100%{opacity:.2; transform:scale(.5);}50%{opacity:1; transform:scale(1.3);}}
@keyframes tiSpin{to{transform:rotate(360deg);}}

/* Obsidian: a glowing crescent moon that gently bobs, with twinkling stars */
.ti-moon-wrap{position:relative; width:44px; height:44px;}
.ti-moon{position:absolute; left:9px; top:9px; width:26px; height:26px; border-radius:50%; background:#e4e8ff;
  box-shadow:-9px -2px 0 3px #23283a inset, 0 0 10px 2px rgba(190,200,255,0.55);
  animation:tiMoonFloat 2.6s ease-in-out infinite;}
@keyframes tiMoonFloat{0%,100%{transform:translateY(0);}50%{transform:translateY(-5px);}}
.ti-star{position:absolute; width:3px; height:3px; background:#fff; border-radius:50%; animation:tiTwinkle 1.5s ease-in-out infinite;}

/* Daylight: a sun with spinning rays that pulses */
.ti-sun-wrap{position:relative; width:46px; height:46px;}
.ti-sun-rays{position:absolute; inset:1px; border-radius:50%;
  background:repeating-conic-gradient(#ffcc4d 0deg 7deg, transparent 7deg 30deg);
  animation:tiSpin 5s linear infinite; opacity:.9;}
.ti-sun-core{position:absolute; inset:13px; border-radius:50%; background:#ffcc4d;
  box-shadow:0 0 10px 2px rgba(255,204,77,0.75); animation:tiSunPulse 1.8s ease-in-out infinite;}
@keyframes tiSunPulse{0%,100%{transform:scale(1);}50%{transform:scale(1.15);}}

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

function TaskRow({ id, name, xp, done, onToggle, disabled, unit = "XP" }) {
  return (
    <div className={`task-row ${done ? "done" : ""}`}>
      <div className={`chk ${done ? "on" : ""}`} onClick={disabled ? undefined : onToggle}>
        {done ? "✓" : ""}
      </div>
      <div className="task-name">{name}</div>
      {xp !== null && <div className="task-xp">{xp} {unit}</div>}
    </div>
  );
}

function TaskRowStatic({ name, xp }) {
  return (
    <div className="task-row static">
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

/* -- animated (non-emoji) theme icons -- */
function ThemeIcon({ id }) {
  if (id === "dark") {
    return (
      <div className="ti-moon-wrap">
        <div className="ti-moon" />
        <div className="ti-star" style={{ left: 4, top: 8 }} />
        <div className="ti-star" style={{ right: 4, top: 18, animationDelay: ".5s" }} />
        <div className="ti-star" style={{ left: 8, bottom: 5, animationDelay: ".9s" }} />
      </div>
    );
  }
  if (id === "light") {
    return (
      <div className="ti-sun-wrap">
        <div className="ti-sun-rays" />
        <div className="ti-sun-core" />
      </div>
    );
  }
  return null;
}

/* ============================= HUD ============================= */
const SYNC_LABEL = {
  synced: "☁️ Synced",
  saving: "💾 Saving…",
  loading: "☁️ Connecting…",
  offline: "📴 Offline — saved on this device",
  error: "⚠️ Sync error — saved on this device",
};
function Hud({ score, rank, syncStatus, showBadge, gameCompleted }) {
  return (
    <div className="hud">
      <div className="hud-top">
        {showBadge && (
          <div className="rank-core" style={{ "--rc1": rank.glow[0], "--rc2": rank.glow[1] }}>
            {rank.name}
          </div>
        )}
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
      {gameCompleted && (
        <div className="celebrate grand">
          <span className="pop" style={{ left: "8%", top: 6 }}>🏆</span>
          <span className="pop" style={{ right: "8%", top: 6, animationDelay: ".3s" }}>🏆</span>
          <div>Game completed successfully</div>
          <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.9, marginTop: 2 }}>
            Rank S+ reached. The Final Ascent is complete.
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================= LOGIN GATE ============================= */
function LoginGate({ config, setConfig, onAuthed }) {
  const [mode, setMode] = useState(config.pinSet ? "choose" : "setup");
  const [pinDraft, setPinDraft] = useState("");
  const [pwDraft, setPwDraft] = useState("");
  const [err, setErr] = useState("");

  const logAndEnter = (r) => {
    const entry = { role: r, ts: new Date().toISOString() };
    setConfig((prev) => ({ ...prev, loginLog: [...(prev.loginLog || []).slice(-49), entry] }));
    onAuthed(r);
  };

  if (mode === "setup") {
    return (
      <div className="start-gate">
        <div className="big-badge">🔐</div>
        <h2 style={{ margin: "0 0 8px" }}>Set up ASCEND</h2>
        <p className="small-muted" style={{ maxWidth: 280 }}>
          Nobody has logged in yet. The first person to set a PIN becomes the campaign owner.
        </p>
        <div className="field-row" style={{ maxWidth: 260, width: "100%" }}>
          <input type="password" placeholder="Choose an owner PIN" value={pinDraft} onChange={(e) => setPinDraft(e.target.value)} />
        </div>
        <button
          className="btn big" style={{ maxWidth: 260, marginTop: 12 }}
          onClick={() => {
            if (!pinDraft.trim()) { setErr("Enter a PIN first."); return; }
            setConfig((prev) => ({ ...prev, pinSet: true, pin: pinDraft }));
            logAndEnter("owner");
          }}
        >
          Become Owner
        </button>
        {err && <div className="small-muted" style={{ color: "var(--red)", marginTop: 8 }}>{err}</div>}
      </div>
    );
  }

  if (mode === "choose") {
    return (
      <div className="start-gate">
        <div className="big-badge">🔐</div>
        <h2 style={{ margin: "0 0 8px" }}>Log in</h2>
        <p className="small-muted" style={{ maxWidth: 280, marginBottom: 14 }}>Are you the owner, or viewing?</p>
        <button className="btn big" style={{ maxWidth: 260, marginBottom: 10 }} onClick={() => setMode("pin")}>Owner</button>
        <button className="btn ghost big" style={{ maxWidth: 260 }} onClick={() => setMode("pw")}>Viewer</button>
      </div>
    );
  }

  if (mode === "pin") {
    return (
      <div className="start-gate">
        <div className="big-badge">🔐</div>
        <h2 style={{ margin: "0 0 8px" }}>Owner PIN</h2>
        <div className="field-row" style={{ maxWidth: 260, width: "100%" }}>
          <input type="password" placeholder="PIN" value={pinDraft} onChange={(e) => setPinDraft(e.target.value)} />
        </div>
        <button
          className="btn big" style={{ maxWidth: 260, marginTop: 12 }}
          onClick={() => {
            if (pinDraft === config.pin) logAndEnter("owner");
            else setErr("Wrong PIN.");
          }}
        >
          Unlock
        </button>
        {err && <div className="small-muted" style={{ color: "var(--red)", marginTop: 8 }}>{err}</div>}
      </div>
    );
  }

  // viewer password
  return (
    <div className="start-gate">
      <div className="big-badge">🔐</div>
      <h2 style={{ margin: "0 0 8px" }}>Viewer Password</h2>
      {!config.viewerPassword ? (
        <p className="small-muted" style={{ maxWidth: 280 }}>The owner hasn't set a viewer password yet.</p>
      ) : (
        <>
          <div className="field-row" style={{ maxWidth: 260, width: "100%" }}>
            <input type="password" placeholder="Viewer password" value={pwDraft} onChange={(e) => setPwDraft(e.target.value)} />
          </div>
          <button
            className="btn big" style={{ maxWidth: 260, marginTop: 12 }}
            onClick={() => {
              if (pwDraft === config.viewerPassword) logAndEnter("viewer");
              else setErr("Wrong password.");
            }}
          >
            Enter (view only)
          </button>
          {err && <div className="small-muted" style={{ color: "var(--red)", marginTop: 8 }}>{err}</div>}
        </>
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
        33 weeks. 231 days. Campaign start: 17 Aug 2026.
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
function HomeTab({ config, setConfig, achievements, setAchievements, days, setDays, plans, setPlans, isOwner, onAfterTaskToggle }) {
  const [openAspect, setOpenAspect] = useState(null);
  const [compactExpanded, setCompactExpanded] = useState({ protein: false, planner: false, recap: false });
  const [selectedDate, setSelectedDate] = useState(todayStr());

  const t = todayStr();
  const sel = selectedDate;
  const rec = days[sel] || { tasksDone: {}, protein: 0, leave: false, leaveOrdinary: false, hardMode: {} };

  const currentWeekN = clamp(weekOf(t, CAMPAIGN_START), 1, 33);
  const [viewWeekN, setViewWeekN] = useState(currentWeekN);

  const [proteinDraft, setProteinDraft] = useState(rec.protein || "");
  const [chaptersDraft, setChaptersDraft] = useState(rec.chaptersLog || "");
  const [questionsDraft, setQuestionsDraft] = useState(rec.questions || "");
  const [plannerDraft, setPlannerDraft] = useState(plans[addDays(t, 1)] || "");

  useEffect(() => {
    const r = days[sel] || {};
    setProteinDraft(r.protein || "");
    setChaptersDraft(r.chaptersLog || "");
    setQuestionsDraft(r.questions || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const updateRec = useCallback(
    (patch) => {
      setDays((prev) => ({ ...prev, [sel]: { ...(prev[sel] || rec), ...patch } }));
    },
    [sel, rec, setDays]
  );

  const toggleTask = (taskId) => {
    if (!isOwner) return;
    const current = days[sel] || { tasksDone: {} };
    const nextDone = { ...(current.tasksDone || {}), [taskId]: !current.tasksDone?.[taskId] };
    setDays((prev) => ({ ...prev, [sel]: { ...(prev[sel] || rec), tasksDone: nextDone } }));
    onAfterTaskToggle();
  };

  const proteinPct = clamp((rec.protein || 0) / 60, 0, 1);
  const plannerText = plans[addDays(t, 1)] || "";
  const plannerCount = plannerText.trim() ? plannerText.trim().split(/\n+/).filter(Boolean).length : 0;

  const wStart = weekStartDate(CAMPAIGN_START, viewWeekN);
  const paidLeaveCount = Object.values(days).filter((d) => d.leave).length;
  const leaveCount = Object.values(days).filter((d) => d.leaveOrdinary).length;

  const dailyTasks = flatDailyTasks(config);
  // A miss only adds Hard Mode tasks starting the NEXT day, never same-day —
  // and once every one of them is checked off, the section disappears.
  const hardModeAllDone = HARD_MODE_TASKS.every((h) => !!rec.hardMode?.[h.id]);
  const penaltyActive = penaltyLevelForDate(days, config, sel) === 5 && !hardModeAllDone;
  const recapDone = dailyTasks.filter((tk) => !!rec.tasksDone[tk.id]);
  const recapPlan = plans[sel] || "";

  // Monday-first day order for the week strip
  const dow = ["M", "T", "W", "T", "F", "S", "S"];

  const openDay = (d) => {
    setSelectedDate(d);
    setCompactExpanded((s) => ({ ...s, recap: true }));
  };

  return (
    <>
      <div className="trio">
        <div className="trio-card" onClick={() => setCompactExpanded((s) => ({ ...s, planner: !s.planner }))}>
          <div className="ic">📝</div>
          <b>{plannerCount}</b>
          <span>Today's Plan</span>
        </div>
        <div className="trio-card" onClick={() => setCompactExpanded((s) => ({ ...s, recap: !s.recap }))}>
          <div className="ic">🗒️</div>
          <b>{recapDone.length}</b>
          <span>Daily Recap</span>
        </div>
        <div className="trio-card" onClick={() => setCompactExpanded((s) => ({ ...s, protein: !s.protein }))}>
          <div className="ic">🍗</div>
          <b>{rec.protein || 0}g</b>
          <span>Protein</span>
        </div>
        <div className="trio-card" onClick={() => document.getElementById("aspect-detail")?.scrollIntoView({ behavior: "smooth" })}>
          <div className="ic">⚡</div>
          <b>{dayXP(days, config.tasks, sel)}</b>
          <span>XP</span>
        </div>
      </div>

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

      {compactExpanded.recap && (
        <div className="card compact-detail">
          <div className="small-muted">Plan for {fmtDate(sel)}</div>
          <div style={{ marginTop: 6, fontSize: 13.5, whiteSpace: "pre-wrap" }}>
            {recapPlan ? recapPlan : <span className="small-muted">No plan was set for this day.</span>}
          </div>
          <div className="small-muted" style={{ marginTop: 14 }}>Completed on {fmtDate(sel)}</div>
          <div style={{ marginTop: 4 }}>
            {recapDone.length ? (
              recapDone.map((tk) => <TaskRowStatic key={tk.id} name={tk.name} xp={tk.xp} />)
            ) : (
              <div className="small-muted">Nothing marked done yet.</div>
            )}
          </div>
          <div className="small-muted" style={{ marginTop: 14 }}>Chapters done on {fmtDate(sel)}</div>
          <textarea
            placeholder="e.g. Physics Ch.5 — Rotational Motion" disabled={!isOwner}
            value={chaptersDraft} onChange={(e) => setChaptersDraft(e.target.value)}
          />
          <div style={{ textAlign: "right", marginTop: 6 }}>
            <button className="btn sm" disabled={!isOwner} onClick={() => updateRec({ chaptersLog: chaptersDraft })}>Save</button>
          </div>
          <div className="small-muted" style={{ marginTop: 14 }}>Questions done on {fmtDate(sel)}</div>
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

      {compactExpanded.protein && (
        <div className="card compact-detail">
          <div className="small-muted">Protein target: 60g</div>
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
        </div>
      )}

      <div className="section-title">Week {viewWeekN} Calendar</div>
      <div className="card">
        <div className="week-nav">
          <button className="btn ghost sm" disabled={viewWeekN <= 1} onClick={() => setViewWeekN((w) => clamp(w - 1, 1, currentWeekN))}>←</button>
          <b>Week {viewWeekN}</b>
          <button className="btn ghost sm" disabled={viewWeekN >= currentWeekN} onClick={() => setViewWeekN((w) => clamp(w + 1, 1, currentWeekN))}>→</button>
        </div>
        <div className="dots">
          {Array.from({ length: 7 }).map((_, i) => {
            const d = addDays(wStart, i);
            const dr = days[d];
            let cls = "";
            if (d > t) cls = "";
            else if (dr && dr.leave) cls = "y";
            else if (dr && dr.leaveOrdinary) cls = "b";
            else if (dr) cls = dayXP(days, config.tasks, d) >= config.threshold ? "g" : "r";
            else cls = d < t ? "r" : "";
            return (
              <div className="day-dot" key={d} onClick={() => { if (d <= t) openDay(d); }}>
                <div className={`dot ${cls} ${d === t ? "today" : ""} ${d === sel ? "selected" : ""}`} />
                {dow[i]}
              </div>
            );
          })}
        </div>
        <div className="small-muted" style={{ marginTop: 10 }}>🟢 sufficient XP · 🟡 paid leave · 🔵 leave · 🔴 insufficient XP · ring = today (IST)</div>
        {sel !== t && (
          <div className="day-header" style={{ marginTop: 10 }}>
            <span className="small-muted">Viewing &amp; editing {fmtDate(sel)} — everything planned and done that day is in Daily Recap above</span>
            <button className="btn ghost sm" onClick={() => { setSelectedDate(t); setViewWeekN(currentWeekN); }}>Back to today</button>
          </div>
        )}
        {isOwner && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button className="btn ghost sm" onClick={() => updateRec({ leave: !rec.leave, leaveOrdinary: rec.leave ? rec.leaveOrdinary : false })}>
              {rec.leave ? "Undo paid leave" : `Mark paid leave (${paidLeaveCount}/${PAID_LEAVE_MAX})`}
            </button>
            <button
              className="btn ghost sm"
              onClick={() => {
                if (!rec.leaveOrdinary && leaveCount >= LEAVE_MAX) { alert(`All ${LEAVE_MAX} leave days have been used.`); return; }
                updateRec({ leaveOrdinary: !rec.leaveOrdinary, leave: rec.leaveOrdinary ? rec.leave : false });
              }}
            >
              {rec.leaveOrdinary ? "Undo leave" : `Mark leave (${leaveCount}/${LEAVE_MAX})`}
            </button>
          </div>
        )}
      </div>

      <div className="section-title">Daily Tasks</div>
      <div className="card">
        {dailyTasks.map((tk) => (
          <TaskRow
            key={tk.id} id={tk.id} name={tk.name} xp={tk.xp}
            done={!!rec.tasksDone[tk.id]}
            disabled={!isOwner}
            onToggle={() => toggleTask(tk.id)}
          />
        ))}
        {penaltyActive && (
          <>
            <div className="task-group-title">Penalty Tasks (active)</div>
            {HARD_MODE_TASKS.map((h) => (
              <TaskRow
                key={h.id} id={h.id} name={h.name} xp={null}
                done={!!rec.hardMode?.[h.id]} disabled={!isOwner}
                onToggle={() => {
                  if (!isOwner) return;
                  const nextHM = { ...(rec.hardMode || {}), [h.id]: !rec.hardMode?.[h.id] };
                  updateRec({ hardMode: nextHM });
                }}
              />
            ))}
          </>
        )}
      </div>

      <div className="section-title">Strength — Weight Loss</div>
      <div className="card">
        <div className="small-muted" style={{ marginBottom: 6 }}>One toggle per arc — mark it when that arc's weight-loss goal is hit.</div>
        <TaskRow
          name="Weight loss — Arc I" xp={config.weightLossXP?.arcI ?? 5} unit="pts" done={!!achievements.weightLossArcI} disabled={!isOwner}
          onToggle={() => { if (!isOwner) return; setAchievements((p) => ({ ...p, weightLossArcI: !p.weightLossArcI })); onAfterTaskToggle(); }}
        />
        <TaskRow
          name="Weight loss — Arc II" xp={config.weightLossXP?.arcII ?? 5} unit="pts" done={!!achievements.weightLossArcII} disabled={!isOwner}
          onToggle={() => { if (!isOwner) return; setAchievements((p) => ({ ...p, weightLossArcII: !p.weightLossArcII })); onAfterTaskToggle(); }}
        />
        <TaskRow
          name="Weight loss — Arc III" xp={config.weightLossXP?.arcIII ?? 5} unit="pts" done={!!achievements.weightLossArcIII} disabled={!isOwner}
          onToggle={() => { if (!isOwner) return; setAchievements((p) => ({ ...p, weightLossArcIII: !p.weightLossArcIII })); onAfterTaskToggle(); }}
        />
      </div>

      <div className="section-title">Aspects <span className="small-muted" style={{ textTransform: "none", fontWeight: 500 }}>% of total campaign score gained</span></div>
      <div className="aspect-strip">
        {Object.entries(config.tasks).map(([key, cat]) => {
          const pct = categoryCampaignPct(days, cat);
          return (
            <div className="aspect-mini" key={key} onClick={() => setOpenAspect((a) => (a === key ? null : key))}>
              <Ring pct={pct} size={48} />
              <div className="name">{cat.icon} {cat.label}</div>
            </div>
          );
        })}
        <div className="aspect-mini" onClick={() => setOpenAspect((a) => (a === "skills" ? null : "skills"))}>
          <Ring pct={skillsPct(config, achievements)} size={48} />
          <div className="name">🎓 Skills</div>
        </div>
      </div>
      {openAspect && openAspect !== "skills" && (
        <div className="card" id="aspect-detail" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>
            {config.tasks[openAspect].icon} {config.tasks[openAspect].label}
          </div>
          {config.tasks[openAspect].tasks.map((tk) => (
            <TaskRowStatic key={tk.id} name={tk.name} xp={tk.xp} />
          ))}
        </div>
      )}
      {openAspect === "skills" && (
        <div className="card" id="aspect-detail" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>🎓 Skills</div>
          <TaskRow
            name="Driving" xp={config.skillXP?.driving ?? 3} done={!!achievements.driving} disabled={!isOwner}
            onToggle={() => { if (!isOwner) return; setAchievements((p) => ({ ...p, driving: !p.driving })); onAfterTaskToggle(); }}
          />
          <TaskRow
            name={`${config.bookNames?.bookLHN ?? "Book 1"} (Arc II)`} xp={config.skillXP?.bookLHN ?? 2} done={!!achievements.bookLHN} disabled={!isOwner}
            onToggle={() => { if (!isOwner) return; setAchievements((p) => ({ ...p, bookLHN: !p.bookLHN })); onAfterTaskToggle(); }}
          />
          <TaskRow
            name={`${config.bookNames?.bookAH ?? "Book 2"} (Arc I)`} xp={config.skillXP?.bookAH ?? 2} done={!!achievements.bookAH} disabled={!isOwner}
            onToggle={() => { if (!isOwner) return; setAchievements((p) => ({ ...p, bookAH: !p.bookAH })); onAfterTaskToggle(); }}
          />
          <TaskRow
            name={`${config.bookNames?.bookNew ?? "Book 3"} (Arc III)`} xp={config.skillXP?.bookNew ?? 2} done={!!achievements.bookNew} disabled={!isOwner}
            onToggle={() => { if (!isOwner) return; setAchievements((p) => ({ ...p, bookNew: !p.bookNew })); onAfterTaskToggle(); }}
          />
        </div>
      )}
    </>
  );
}

/* ============================= MILESTONE & GOALS TAB ============================= */
function MilestoneGoalsTab({ achievements, setAchievements, config, setConfig, isOwner, afterAchChange }) {
  const [chapterDraft, setChapterDraft] = useState(achievements.chapters);
  useEffect(() => setChapterDraft(achievements.chapters), [achievements.chapters]);

  const patchAch = (patch) => {
    setAchievements((prev) => ({ ...prev, ...patch }));
    afterAchChange();
  };

  const triggerFinalAscent = (on) => {
    setAchievements((prev) => {
      const next = [...prev.milestones];
      if (on) next[5] = true;
      return { ...prev, finalAscent: on, milestones: next };
    });
    setConfig((prev) => ({
      ...prev,
      lastRankTier: on ? 6 : prev.lastRankTier,
      celebrationUntil: on ? Date.now() + 48 * 3600 * 1000 : prev.celebrationUntil,
      gameCompleted: on,
    }));
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
        Milestones
        <span className="small-muted" style={{ textTransform: "none", fontWeight: 500 }}>6 total · 1 pt each · auto-hit on rank-up</span>
      </div>
      <div className="card">
        <div className="milestone-grid">
          {["E → D", "D → C", "C → B", "B → A", "A → S", "S → S+"].map((label, i) => (
            <div
              key={i} className={`ms ${achievements.milestones[i] ? "on" : ""}`}
              onClick={() => {
                if (!isOwner) return;
                const next = [...achievements.milestones];
                next[i] = !next[i];
                patchAch({ milestones: next });
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      <div className="section-title">The Final Ascent</div>
      <div className="card">
        <div className="small-muted">
          Complete the main goal and the rest of the campaign XP will be fulfilled automatically — rank jumps straight to S+.
        </div>
        <div className="toggle-row" style={{ borderBottom: "none" }}>
          <span>Final Ascent complete</span>
          <SwitchToggle on={achievements.finalAscent} disabled={!isOwner} onClick={() => triggerFinalAscent(!achievements.finalAscent)} />
        </div>
      </div>
    </>
  );
}

/* ============================= PENALTIES TAB ============================= */
function PenaltiesTab({ config, days, setDays, achievements, penaltyLog, isOwner }) {
  const w = currentWeek(config);
  const misses = weekMissCount(days, config.tasks, config, w); // live, today-inclusive — for the status display
  const pen = penaltyForMisses(misses);
  const history = penaltyLog.slice(-15).reverse();
  const t = todayStr();
  const rec = days[t] || { hardMode: {} };
  // Actionable checklist only activates the day AFTER misses cross the threshold,
  // and hides itself once every Hard Mode task for today is checked off.
  const effectiveLevel = penaltyLevelForDate(days, config, t);
  const hardModeAllDone = HARD_MODE_TASKS.every((h) => !!rec.hardMode?.[h.id]);
  const hardModeShowing = effectiveLevel === 5 && !hardModeAllDone;

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
        <div className="pen-meter">
          {[1, 2, 3, 4, 5].map((n) => <div key={n} className={`seg ${misses >= n ? "on" : ""}`} />)}
        </div>
        {pen.level === 5 && !hardModeShowing && effectiveLevel < 5 && (
          <div className="small-muted" style={{ marginTop: 10, fontWeight: 500 }}>
            Hard Mode tasks start showing tomorrow, not today.
          </div>
        )}
      </div>

      {hardModeShowing && (
        <>
          <div className="section-title">
            Hard Mode Protocol <span className="small-muted" style={{ textTransform: "none", fontWeight: 500 }}>active — 3 days</span>
          </div>
          <div className="card">
            <div className="small-muted" style={{ marginBottom: 8 }}>These also appear under Daily Tasks on Home while the penalty is active.</div>
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

      <div className="section-title">Leave</div>
      <div className="card">
        <div className="small-muted">
          {PAID_LEAVE_MAX} paid-leave days and {LEAVE_MAX} ordinary leave days across the campaign. Mark either from Home — neither counts as a miss.
        </div>
        <div style={{ marginTop: 10, fontWeight: 700 }}>
          {Object.values(days).filter((d) => d.leave).length} / {PAID_LEAVE_MAX} paid leave used
        </div>
        <div style={{ marginTop: 4, fontWeight: 700 }}>
          {Object.values(days).filter((d) => d.leaveOrdinary).length} / {LEAVE_MAX} leave used
        </div>
      </div>
    </>
  );
}

/* ============================= SETTINGS TAB ============================= */
function SettingsTab({ config, setConfig, isOwner, setIsOwner, onResetCampaign, onLogout }) {
  const [viewerPwDraft, setViewerPwDraft] = useState(config.viewerPassword || "");
  const [thresholdDraft, setThresholdDraft] = useState(config.threshold);
  const [newTask, setNewTask] = useState({ name: "", xp: 5, catKey: "strength" });

  const patchConfig = (patch) => setConfig((prev) => ({ ...prev, ...patch }));

  // Every task/skill edit below writes straight to config — there is no local
  // staging copy that can go stale and silently overwrite newer synced data
  // when a separate "Save" button used to be clicked.
  const updateTask = (catKey, taskId, field, value) => {
    setConfig((prev) => {
      const cat = prev.tasks[catKey];
      const nextArr = cat.tasks.map((t) => (t.id === taskId ? { ...t, [field]: value } : t));
      return { ...prev, tasks: { ...prev.tasks, [catKey]: { ...cat, tasks: nextArr } } };
    });
  };

  const deleteTask = (catKey, taskId) => {
    setConfig((prev) => {
      const cat = prev.tasks[catKey];
      const nextArr = cat.tasks.filter((t) => t.id !== taskId);
      return { ...prev, tasks: { ...prev.tasks, [catKey]: { ...cat, tasks: nextArr } } };
    });
  };

  const addTask = () => {
    if (!newTask.name.trim()) return;
    setConfig((prev) => {
      const cat = prev.tasks[newTask.catKey];
      const nextArr = [...cat.tasks, { id: `t_${uid()}`, name: newTask.name.trim(), xp: Number(newTask.xp) || 1 }];
      return { ...prev, tasks: { ...prev.tasks, [newTask.catKey]: { ...cat, tasks: nextArr } } };
    });
    setNewTask({ name: "", xp: 5, catKey: newTask.catKey });
  };

  const flatTasks = [];
  for (const [catKey, cat] of Object.entries(config.tasks)) {
    for (const tk of cat.tasks) flatTasks.push({ ...tk, catKey });
  }

  const setSkillXP = (key, xp) => setConfig((prev) => ({ ...prev, skillXP: { ...prev.skillXP, [key]: Number(xp) || 1 } }));
  const setBookName = (key, name) => setConfig((prev) => ({ ...prev, bookNames: { ...prev.bookNames, [key]: name } }));

  const skillRows = [
    { key: "driving", name: "Driving", xp: config.skillXP?.driving ?? 3, editableName: false },
    { key: "bookLHN", name: config.bookNames?.bookLHN ?? "Book 1", xp: config.skillXP?.bookLHN ?? 2, editableName: true },
    { key: "bookAH", name: config.bookNames?.bookAH ?? "Book 2", xp: config.skillXP?.bookAH ?? 2, editableName: true },
    { key: "bookNew", name: config.bookNames?.bookNew ?? "Book 3", xp: config.skillXP?.bookNew ?? 2, editableName: true },
  ];

  const log = (config.loginLog || []).slice(-20).reverse();

  return (
    <>
      <div className="section-title">Access</div>
      <div className="card">
        <div className="lockbar">
          {isOwner ? "🔓 Owner mode — you can edit everything." : "🔒 View-only mode — you can watch progress but not edit it."}
        </div>
        {isOwner && (
          <>
            <div className="small-muted">Viewer password — share this with people who should only be able to view.</div>
            <div className="field-row">
              <input type="text" placeholder="Viewer password" value={viewerPwDraft} onChange={(e) => setViewerPwDraft(e.target.value)} />
              <button className="btn sm" onClick={() => patchConfig({ viewerPassword: viewerPwDraft })}>Save</button>
            </div>
            <div className="small-muted" style={{ marginTop: 14 }}>Login activity</div>
            <div style={{ marginTop: 6, maxHeight: 180, overflowY: "auto" }}>
              {log.length ? log.map((l, i) => (
                <div className="log-row" key={i}>
                  <span>{l.role === "owner" ? "🔓 Owner" : "👁️ Viewer"}</span>
                  <span>{new Date(l.ts).toLocaleString()}</span>
                </div>
              )) : <div className="small-muted">No logins recorded yet.</div>}
            </div>
          </>
        )}
        <div style={{ marginTop: 12 }}>
          <button className="btn ghost sm" onClick={onLogout}>Log out</button>
        </div>
      </div>

      <div className="section-title">Appearance — Theme</div>
      <div className="card">
        <div className="swatch-row">
          {THEMES.map((th) => (
            <div
              key={th.id} className={`theme-swatch ${config.theme === th.id ? "sel" : ""}`} title={th.label}
              onClick={() => patchConfig({ theme: th.id })}
            >
              <ThemeIcon id={th.id} />
              <span className="tlabel">{th.label}</span>
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

      <div className="section-title">Campaign</div>
      <div className="card">
        <div className="small-muted">Campaign start: 17 Aug 2026 (fixed).</div>
        <div className="small-muted" style={{ marginTop: 12 }}>XP threshold to count a day as "sufficient"</div>
        <div className="field-row">
          <input type="number" value={thresholdDraft} disabled={!isOwner} onChange={(e) => setThresholdDraft(Number(e.target.value) || 0)} />
          {isOwner && <button className="btn sm" onClick={() => patchConfig({ threshold: thresholdDraft || 70 })}>Save</button>}
        </div>
        {isOwner && config.started && (
          <div style={{ marginTop: 14 }}>
            <button className="btn ghost sm" onClick={onResetCampaign}>Reset &amp; show Start screen again</button>
          </div>
        )}
      </div>

      <div className="section-title">Tasks</div>
      <div className="card">
        <div className="small-muted" style={{ marginBottom: 8 }}>Any task name or XP value can be changed here — changes save instantly. You can also add new tasks or delete existing ones.</div>
        {flatTasks.map((tk) => (
          <div className="edit-task-row" key={tk.id}>
            <input
              type="text" value={tk.name} disabled={!isOwner}
              onChange={(e) => updateTask(tk.catKey, tk.id, "name", e.target.value)}
            />
            <input
              type="number" value={tk.xp} disabled={!isOwner}
              onChange={(e) => updateTask(tk.catKey, tk.id, "xp", Number(e.target.value) || 1)}
            />
            {isOwner && (
              <button className="iconbtn" title="Delete task" onClick={() => deleteTask(tk.catKey, tk.id)}>✕</button>
            )}
          </div>
        ))}
        {isOwner && (
          <>
            <div className="edit-task-row" style={{ borderBottom: "none", marginTop: 6 }}>
              <input
                type="text" placeholder="New task name" value={newTask.name}
                onChange={(e) => setNewTask((s) => ({ ...s, name: e.target.value }))}
              />
              <input
                type="number" value={newTask.xp}
                onChange={(e) => setNewTask((s) => ({ ...s, xp: Number(e.target.value) || 1 }))}
              />
            </div>
            <div className="field-row" style={{ marginTop: 4 }}>
              <select value={newTask.catKey} onChange={(e) => setNewTask((s) => ({ ...s, catKey: e.target.value }))}>
                <option value="strength">Strength</option>
                <option value="intellect">Intellect</option>
                <option value="discipline">Discipline</option>
              </select>
              <button className="btn sm" onClick={addTask}>+ Add Task</button>
            </div>
          </>
        )}
      </div>

      <div className="section-title">Skills &amp; Achievements</div>
      <div className="card">
        <div className="small-muted" style={{ marginBottom: 8 }}>Changes save instantly.</div>
        {skillRows.map((sr) => (
          <div className="edit-task-row" key={sr.key}>
            <input
              type="text" value={sr.name} disabled={!isOwner || !sr.editableName}
              onChange={(e) => setBookName(sr.key, e.target.value)}
            />
            <input
              type="number" value={sr.xp} disabled={!isOwner}
              onChange={(e) => setSkillXP(sr.key, e.target.value)}
            />
          </div>
        ))}
      </div>

      <div className="section-title">Sharing</div>
      <div className="card">
        <div className="small-muted">Share this app's link with anyone — they'll log in with the viewer password to see live progress without editing.</div>
      </div>
    </>
  );
}

/* ============================= SPARKLE LAYER ============================= */
// Ambient particles that make each theme visibly *look* like its name across
// the whole app — not just as a tiny picker icon.
function themeParticles(theme, celebration) {
  if (celebration) return { shapes: [{ shape: "star", color: "#ffe873" }, { shape: "dot", color: "#ff9de2" }, { shape: "dot", color: "#7c5cff" }], anim: "float" };
  switch (theme) {
    case "dark": return { shapes: [{ shape: "star", color: "#f2f2ff" }, { shape: "dot", color: "#cfd6ff" }], anim: "twinkleDrift" };
    case "light": return { shapes: [{ shape: "dot", color: "#ffd166" }, { shape: "cloud", color: "#ffffff" }], anim: "drift" };
    default: return { shapes: [{ shape: "dot", color: "#ffffff" }], anim: "float" };
  }
}
function SparkleLayer({ theme, celebration }) {
  const { shapes, anim } = useMemo(() => themeParticles(theme, celebration), [theme, celebration]);
  const particles = useMemo(() => {
    return Array.from({ length: 14 }).map((_, i) => {
      const { shape, color } = shapes[i % shapes.length];
      const size = 6 + Math.random() * 8;
      if (anim === "drift") {
        return { key: i, shape, color, size, duration: 14 + Math.random() * 12, delay: Math.random() * 14, style: { top: `${5 + Math.random() * 45}%`, left: "-10%" }, cls: "drift" };
      }
      if (anim === "fall") {
        return { key: i, shape, color, size, duration: 8 + Math.random() * 8, delay: Math.random() * 10, style: { left: `${Math.random() * 100}%`, top: "-40px" }, cls: "fall" };
      }
      if (anim === "twinkleDrift") {
        return { key: i, shape, color, size: size * 0.8, duration: 1.4 + Math.random() * 1.8, delay: Math.random() * 3, style: { top: `${Math.random() * 90}%`, left: `${Math.random() * 100}%` }, cls: "twinkleDrift" };
      }
      return { key: i, shape, color, size, duration: 8 + Math.random() * 10, delay: Math.random() * 10, style: { left: `${Math.random() * 100}%`, bottom: "-40px" }, cls: "float" };
    });
  }, [shapes, anim]);
  return (
    <div className="sparkle-layer">
      {particles.map((p) => (
        <span
          key={p.key} className={`${p.cls} shape-${p.shape}`}
          style={{
            ...p.style, width: p.size, height: p.size, background: p.color, color: p.color,
            animationDuration: `${p.duration}s`, animationDelay: `${p.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

/* ============================= MAIN APP ============================= */
const TABS = [
  { id: "home", label: "Home", ic: "🏠" },
  { id: "goals", label: "Milestone & Goals", ic: "🏆" },
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
  const [isOwner, setIsOwner] = useState(false);
  const [authRole, setAuthRole] = useState(null); // null | 'owner' | 'viewer'
  const [installEvent, setInstallEvent] = useState(null);
  const [syncStatus, setSyncStatus] = useState(SYNC_ENABLED ? "loading" : "offline");

  const dirtyRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const saveTimerRef = useRef(null);

  // Wrapped setters: mark the sync guard dirty the INSTANT a local edit
  // happens, synchronously — not one render-cycle later inside a useEffect.
  // Without this, an incoming Firestore snapshot could land in that gap and
  // silently overwrite a just-made edit (e.g. a newly added task) before the
  // guard was up. Every child component below is given these, not the raw
  // setState functions, so no local edit anywhere can be lost this way.
  const setConfigSafe = useCallback((updater) => { dirtyRef.current = true; setConfig(updater); }, []);
  const setDaysSafe = useCallback((updater) => { dirtyRef.current = true; setDays(updater); }, []);
  const setAchievementsSafe = useCallback((updater) => { dirtyRef.current = true; setAchievements(updater); }, []);
  const setPlansSafe = useCallback((updater) => { dirtyRef.current = true; setPlans(updater); }, []);

  const scrollRef = useRef(null);
  const [ptrY, setPtrY] = useState(-50);
  const [ptrSpin, setPtrSpin] = useState(false);
  const touchState = useRef({ startY: null, pulling: false });

  /* ---- load from localStorage on mount ---- */
  useEffect(() => {
    setConfig((prev) => {
      const merged = { ...prev, ...lsGet(LS_KEYS.config, {}) };
      return { ...merged, tasks: sanitizeTasks(merged.tasks) };
    });
    setAchievements((prev) => ({ ...prev, ...lsGet(LS_KEYS.achievements, {}) }));
    setDays(lsGet(LS_KEYS.days, {}));
    setPlans(lsGet(LS_KEYS.plans, {}));
    setPenaltyLog(lsGet(LS_KEYS.penaltyLog, []));
    const savedAuth = lsGet(LS_KEYS.auth, null);
    if (savedAuth) { setAuthRole(savedAuth); setIsOwner(savedAuth === "owner"); }
    setLoaded(true);
  }, []);

  /* ---- persist to localStorage on every change (offline cache) ---- */
  useEffect(() => { if (loaded) lsSet(LS_KEYS.config, config); }, [config, loaded]);
  useEffect(() => { if (loaded) lsSet(LS_KEYS.achievements, achievements); }, [achievements, loaded]);
  useEffect(() => { if (loaded) lsSet(LS_KEYS.days, days); }, [days, loaded]);
  useEffect(() => { if (loaded) lsSet(LS_KEYS.plans, plans); }, [plans, loaded]);
  useEffect(() => { if (loaded) lsSet(LS_KEYS.penaltyLog, penaltyLog); }, [penaltyLog, loaded]);
  useEffect(() => { if (loaded && authRole) lsSet(LS_KEYS.auth, authRole); }, [authRole, loaded]);

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
            setConfig((prev) => {
              const merged = { ...prev, ...(data.config || {}) };
              return { ...merged, tasks: sanitizeTasks(merged.tasks) };
            });
            setAchievements((prev) => ({ ...DEFAULT_ACH, ...(data.achievements || {}) }));
            setDays(data.days || {});
            setPlans(data.plans || {});
            setPenaltyLog(data.penaltyLog || []);
          }
          setSyncStatus("synced");
        } else if (isOwner) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /* ---- Firestore: debounced write-back whenever local state changes ---- */
  useEffect(() => {
    if (!loaded || !SYNC_ENABLED) return;
    if (applyingRemoteRef.current) { applyingRemoteRef.current = false; return; }
    if (!isOwner) return;

    dirtyRef.current = true;
    setSyncStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const ref = doc(db, ASCEND_COLLECTION, MAIN_DOC_ID);
      setDoc(ref, { config, achievements, days, plans, penaltyLog })
        .then(() => { dirtyRef.current = false; setSyncStatus("synced"); })
        .catch(() => {
          // Even on failure, release the dirty guard — otherwise this
          // device ignores every future incoming update until its next
          // local edit happens to succeed, which can be a very long time.
          dirtyRef.current = false;
          setSyncStatus("error");
        });
    }, 600);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, achievements, days, plans, penaltyLog, loaded, isOwner]);

  /* ---- derived scoring ---- */
  const score = useMemo(() => finalScore(days, config, achievements), [days, config, achievements]);
  const rank = useMemo(() => rankFor(score, achievements.finalAscent), [score, achievements.finalAscent]);
  const arcLabel = currentArcLabel(config);
  currentArcLabel.__lastLabel = `${arcLabel} · Week ${currentWeek(config)} / 33`;
  const gameCompleted = !!config.gameCompleted;

  /* ---- rank-up auto-check ----
     Owner-only: these auto-checks run any time `score` recomputes, which
     happens on EVERY device (including viewers) whenever new data arrives.
     If a viewer's setConfigSafe/setAchievementsSafe fires here, that device's
     dirtyRef gets stuck "true" forever (viewers never run the setDoc that
     clears it), silently blocking all future incoming Firestore updates on
     that device. Only the owner should ever mutate/persist derived state. */
  const checkRankUp = useCallback(() => {
    if (!isOwner) return;
    if (achievements.finalAscent) return;
    const s = finalScore(days, config, achievements);
    const tier = tierFor(s);
    if (tier > config.lastRankTier) {
      const nextMs = achievements.milestones.findIndex((m) => !m);
      setAchievementsSafe((prev) => {
        if (nextMs === -1) return prev;
        const next = [...prev.milestones];
        next[nextMs] = true;
        return { ...prev, milestones: next };
      });
      setConfigSafe((prev) => ({ ...prev, lastRankTier: tier }));
    }
  }, [days, config, achievements, isOwner]);

  useEffect(() => { if (loaded) checkRankUp(); }, [score, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- penalty auto-log (owner-only, see note above) ---- */
  const checkPenaltyAutoLog = useCallback(() => {
    if (!isOwner) return;
    const w = currentWeek(config);
    const misses = weekMissCount(days, config.tasks, config, w);
    const pen = penaltyForMisses(misses);
    setConfigSafe((prev) => (prev.__penaltyLevel === pen.level ? prev : { ...prev, __penaltyLevel: pen.level }));
    setPenaltyLog((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.week !== w || last.level !== pen.level) {
        return [...prev, { week: w, level: pen.level, name: pen.name, ts: todayStr() }];
      }
      return prev;
    });
  }, [days, config, isOwner]);

  useEffect(() => { if (loaded) checkPenaltyAutoLog(); }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /* ---- pull to refresh ---- */
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
    <div
      className="ascend-app" data-theme={config.theme} data-celebration={gameCompleted ? "true" : "false"}
      style={{ "--accent": config.accent, "--accent2": config.accent }}
    >
      <style>{STYLES}</style>
      <SparkleLayer theme={config.theme} celebration={gameCompleted} />
      <div className="app">
        <div className={`ptr ${ptrSpin ? "spin" : ""} ${ptrY <= -50 ? "hidden" : ""}`} style={{ top: ptrY }}>🔄</div>

        {!authRole ? (
          <div className="scroll">
            <LoginGate
              config={config} setConfig={setConfigSafe}
              onAuthed={(role) => { setAuthRole(role); setIsOwner(role === "owner"); }}
            />
          </div>
        ) : (
          <>
            <Hud score={score} rank={rank} syncStatus={syncStatus} showBadge={activeTab === "home"} gameCompleted={gameCompleted} />
            <div
              className="scroll" id="page" ref={scrollRef}
              onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
            >
              {!config.started ? (
                <StartGate isOwner={isOwner} onStart={() => setConfigSafe((prev) => ({ ...prev, started: true }))} />
              ) : (
                <>
                  {activeTab === "home" && (
                    <HomeTab
                      config={config} setConfig={setConfigSafe} achievements={achievements} setAchievements={setAchievementsSafe}
                      days={days} setDays={setDaysSafe} plans={plans} setPlans={setPlansSafe} isOwner={isOwner}
                      onAfterTaskToggle={() => { checkRankUp(); checkPenaltyAutoLog(); }}
                    />
                  )}
                  {activeTab === "goals" && (
                    <MilestoneGoalsTab
                      achievements={achievements} setAchievements={setAchievementsSafe}
                      config={config} setConfig={setConfigSafe} isOwner={isOwner}
                      afterAchChange={checkRankUp}
                    />
                  )}
                  {activeTab === "penalties" && (
                    <PenaltiesTab config={config} days={days} setDays={setDaysSafe} achievements={achievements} penaltyLog={penaltyLog} isOwner={isOwner} />
                  )}
                  {activeTab === "settings" && (
                    <SettingsTab
                      config={config} setConfig={setConfigSafe} isOwner={isOwner} setIsOwner={setIsOwner}
                      onResetCampaign={() => setConfigSafe((prev) => ({ ...prev, started: false }))}
                      onLogout={() => { setAuthRole(null); setIsOwner(false); lsSet(LS_KEYS.auth, null); }}
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
          </>
        )}

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
