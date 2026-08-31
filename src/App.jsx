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
    label: "Strength & Fitness", icon: "dumbbell",
    tasks: [
      { id: "walk", name: "4 km walk", xp: 10 },
      { id: "exercise", name: "Exercise", xp: 12 },
      { id: "protein", name: "60g protein", xp: 8 },
    ],
  },
  intellect: {
    label: "Intellect", icon: "brain",
    tasks: [
      { id: "study", name: "Study", xp: 20 },
      { id: "revision", name: "Revision", xp: 10 },
      { id: "questions", name: "Questions", xp: 10 },
    ],
  },
  discipline: {
    label: "Discipline", icon: "flame",
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


/* ============================= ICONS =============================
   Small stroke-based icon set (no external library, no emoji) so every
   glyph in the app shares one visual language and renders identically
   across platforms. */
function Icon({ name, size = 18, className = "", style }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", className: `icon icon-${name}${className ? ` ${className}` : ""}`, style };
  switch (name) {
    case "home": return <svg {...p}><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9" /></svg>;
    case "trophy": return <svg {...p}><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" /><path d="M8 5H5a2 2 0 0 0 0 4h1.6" /><path d="M16 5h3a2 2 0 0 1 0 4h-1.6" /><path d="M12 13v3" /><path d="M9 20h6" /><path d="M10 16.5h4l.5 3.5h-5l.5-3.5Z" /></svg>;
    case "shield": return <svg {...p}><path d="M12 3.2 19 6v6c0 4.6-3 8.2-7 9.3-4-1.1-7-4.7-7-9.3V6l7-2.8Z" /><path d="m9.3 12 1.9 1.9 3.5-3.8" /></svg>;
    case "gear": return <svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 13a7.8 7.8 0 0 0 0-2l1.9-1.4-2-3.4-2.2.5a7.9 7.9 0 0 0-1.7-1L15 3.5h-4l-.4 2.2a7.9 7.9 0 0 0-1.7 1l-2.2-.5-2 3.4L6.6 11a7.8 7.8 0 0 0 0 2l-1.9 1.4 2 3.4 2.2-.5c.5.4 1.1.75 1.7 1l.4 2.2h4l.4-2.2c.6-.25 1.2-.6 1.7-1l2.2.5 2-3.4L19.4 13Z" /></svg>;
    case "lock": return <svg {...p}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
    case "unlock": return <svg {...p}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-1.9" /></svg>;
    case "eye": return <svg {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>;
    case "rocket": return <svg {...p}><path d="M12 2.2c2.4 2 3.8 5.3 3.8 8.7 0 1.9-.5 3.6-1 4.8l-2.8 2.8-2.8-2.8c-.5-1.2-1-2.9-1-4.8 0-3.4 1.4-6.7 3.8-8.7Z" /><circle cx="12" cy="9.2" r="1.4" /><path d="m8.6 14.8-2.3 2.3L5.5 21l3.9-.8 2-2.4" /><path d="m15.4 14.8 2.3 2.3.8 3.9-3.9-.8-2-2.4" /></svg>;
    case "mountain": return <svg {...p}><path d="M3 19 9 8l4 6 2-3 6 8H3Z" /><circle cx="17.3" cy="6.3" r="1.4" /></svg>;
    case "note": return <svg {...p}><rect x="4.5" y="3" width="15" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;
    case "clipboard": return <svg {...p}><rect x="6" y="4" width="12" height="17" rx="2" /><rect x="9" y="2.2" width="6" height="3.6" rx="1" /><path d="m9 12 2 2 4-4.2" /></svg>;
    case "utensils": return <svg {...p}><path d="M6 3v6a1.5 1.5 0 0 0 3 0V3" /><path d="M7.5 9V21" /><path d="M17 3c-1.7 0-3 2-3 4.5S15.3 12 17 12v9" /></svg>;
    case "bolt": return <svg {...p}><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></svg>;
    case "cloud": return <svg {...p}><path d="M7.5 18a4 4 0 0 1-.6-7.95A5 5 0 0 1 16.2 8.3 4.3 4.3 0 0 1 17 16.9" /><path d="M7.5 18h9.2" /></svg>;
    case "save": return <svg {...p}><path d="M5 4h11l3 3v13H5V4Z" /><path d="M8 4v5h8V4" /><path d="M8 14h8v6H8v-6Z" /></svg>;
    case "cloud-off": return <svg {...p}><path d="M3 3l18 18" /><path d="M7.5 18a4 4 0 0 1-.6-7.95A5 5 0 0 1 16.2 8.3" /><path d="M17.6 16.9A4.3 4.3 0 0 0 17 9.1" /><path d="M9.8 18h6.9" /></svg>;
    case "alert": return <svg {...p}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4" /><path d="M12 17h.01" /></svg>;
    case "graduation": return <svg {...p}><path d="M2 9 12 4l10 5-10 5-10-5Z" /><path d="M6 11.5V16c0 1.4 2.8 3 6 3s6-1.6 6-3v-4.5" /><path d="M22 9v6" /></svg>;
    case "dumbbell": return <svg {...p}><path d="M6 7v10M4 9v6M20 7v10M22 9v6" /><path d="M6 12h12" /></svg>;
    case "brain": return <svg {...p}><path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5.4V19a2 2 0 0 0 2 2h1" /><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5.4V19a2 2 0 0 1-2 2h-1" /><path d="M12 3v18" /></svg>;
    case "flame": return <svg {...p}><path d="M12 2.2c1 4-4 5-4 9a4 4 0 0 0 8 0c0-1-.5-2-1-3 1 .5 2 2 2 4a5 5 0 0 1-10 0c0-4.7 2.6-7.7 5-10Z" /></svg>;
    case "refresh": return <svg {...p}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></svg>;
    case "chevron-left": return <svg {...p}><path d="M15 5 8 12l7 7" /></svg>;
    case "chevron-right": return <svg {...p}><path d="m9 5 7 7-7 7" /></svg>;
    case "x": return <svg {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>;
    case "check": return <svg {...p}><path d="M5 12.5 9.5 17 19 7" /></svg>;
    default: return null;
  }
}

// Renders a named icon; falls back to showing the raw string as-is if it's
// not a recognized icon name (keeps old saved data — e.g. a legacy emoji —
// from breaking, since icon fields are persisted in user config/Firestore).
function CatIcon({ icon, size = 16, className, style }) {
  const rendered = Icon({ name: icon, size, className, style });
  return rendered || <span style={{ fontSize: size, lineHeight: 1 }}>{icon}</span>;
}

// Emoji equivalents for the built-in category icon keys, for spots (like the
// Aspects ring strip) that want a plain emoji instead of a line-art icon.
// Falls back to the raw icon field itself for legacy/custom values, since
// that may already be an emoji a user saved in the past.
const ICON_EMOJI = { dumbbell: "💪", brain: "🧠", flame: "🔥", graduation: "🎓" };
function iconEmoji(icon) {
  return ICON_EMOJI[icon] || icon;
}

/* ============================= STYLES ============================= */
const STYLES = `
html, body{margin:0; padding:0; height:100%; -webkit-tap-highlight-color:transparent;}
#root, #__next{height:100%;}
.ascend-app{
  --bg:#0a0c14; --bg2:#11141f; --card:#161a28; --card2:#1d2233; --card3:#242a3f; --nav-bg:#232a42;
  --line:rgba(255,255,255,0.08); --line-soft:rgba(255,255,255,0.05); --text:#eef0f6; --sub:#8890a6; --sub2:#5c6580;
  --accent:#7c5cff; --accent2:#a78bfa; --accent-glow:rgba(124,92,255,0.45);
  --green:#3ddc84; --yellow:#ffcc4d; --red:#ff5c5c; --blue:#3d8bff;
  --radius:18px; --radius-sm:12px; --radius-lg:22px;
  --shadow-sm:0 2px 8px rgba(0,0,0,0.16);
  --shadow:0 8px 30px rgba(0,0,0,0.35);
  --shadow-lg:0 16px 48px rgba(0,0,0,0.45);
  --spring:cubic-bezier(.34,1.56,.64,1);
  --ease:cubic-bezier(.22,1,.36,1);
  --bg-glow:radial-gradient(ellipse 120% 60% at 50% -10%, rgba(124,92,255,0.16), transparent 60%);
  --font: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-display: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
.ascend-app[data-theme="light"]{
  --bg:#f3f1ea; --bg2:#ffffff; --card:#ffffff; --card2:#f6f4ee; --card3:#efece2; --nav-bg:#ffffff;
  --line:rgba(20,20,30,0.08); --line-soft:rgba(20,20,30,0.05); --text:#191a22; --sub:#5c6072; --sub2:#8a8fa3;
  --accent-glow:rgba(124,92,255,0.22);
  --shadow-sm:0 2px 6px rgba(30,20,10,0.06);
  --shadow:0 8px 24px rgba(30,20,10,0.10);
  --shadow-lg:0 20px 44px rgba(30,20,10,0.14);
  --bg-glow:radial-gradient(ellipse 120% 60% at 50% -10%, rgba(124,92,255,0.10), transparent 60%);
}
.ascend-app[data-celebration="true"]{
  --bg:#1a1200; --bg2:#231800; --card:#2a1d00; --card2:#3a2900; --card3:#48330a; --nav-bg:#3f2c05;
  --line:rgba(255,215,0,0.35); --line-soft:rgba(255,215,0,0.18); --text:#fff8dc; --sub:#ffd76a; --sub2:#e0b840;
  --accent:#ffd700; --accent2:#fff2a8; --accent-glow:rgba(255,215,0,0.5);
  --shadow:0 0 40px rgba(255,215,0,0.3);
  --shadow-lg:0 0 60px rgba(255,215,0,0.38);
  --bg-glow:radial-gradient(ellipse 120% 60% at 50% -10%, rgba(255,215,0,0.16), transparent 60%);
}
.ascend-app{box-sizing:border-box; width:100%; min-height:100vh; background:var(--bg); color:var(--text);
  font-family:var(--font); transition:background .4s ease,color .4s ease; overscroll-behavior-y:none; position:relative;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; text-rendering:optimizeLegibility;
  letter-spacing:-.1px;}
.ascend-app::before{content:''; position:fixed; inset:0; background:var(--bg-glow); pointer-events:none; z-index:0; transition:background .4s ease;}
.ascend-app[data-celebration="true"]{background:linear-gradient(135deg,#1a1200,#2a1d00,#3a2900,#1a1200); background-size:300% 300%; animation:ascendGold 6s ease infinite;}
@keyframes ascendGold{0%{background-position:0% 50%;}50%{background-position:100% 50%;}100%{background-position:0% 50%;}}
.ascend-app *{box-sizing:border-box; -webkit-tap-highlight-color:transparent;}
.ascend-app button,.ascend-app input,.ascend-app textarea,.ascend-app select{font-family:inherit; color:inherit;}
.ascend-app button:focus-visible,.ascend-app input:focus-visible,.ascend-app textarea:focus-visible,.ascend-app select:focus-visible,.ascend-app [tabindex]:focus-visible{
  outline:2px solid var(--accent); outline-offset:2px; border-radius:4px;}
.ascend-app select{background:var(--card2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px; cursor:pointer;}
.ascend-app .app{max-width:520px; margin:0 auto; min-height:100vh; display:flex; flex-direction:column; position:relative; overflow:hidden; z-index:1;}
.ascend-app .scroll{flex:1; overflow-y:auto; padding:14px 14px 108px; -webkit-overflow-scrolling:touch; position:relative;}
.ascend-app .scroll::-webkit-scrollbar{width:0;height:0;}

.ascend-app .sparkle-layer{position:fixed; inset:0; pointer-events:none; z-index:5; overflow:hidden;}
.ascend-app .sparkle-layer span{position:absolute; opacity:.85; display:block;}
.ascend-app .sparkle-layer span.float{animation-name:ascendFloatUp; animation-timing-function:linear; animation-iteration-count:infinite;}
.ascend-app .sparkle-layer span.shape-dot{border-radius:50%; box-shadow:0 0 6px currentColor;}
.ascend-app .sparkle-layer span.shape-star{border-radius:2px; clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%); box-shadow:0 0 5px currentColor;}
@keyframes ascendFloatUp{0%{transform:translateY(0) rotate(0deg); opacity:0;}10%{opacity:.9;}100%{transform:translateY(-110vh) rotate(360deg); opacity:0;}}
.ascend-app .ptr{position:absolute; top:-50px; left:50%; transform:translateX(-50%); width:34px; height:34px; border-radius:50%;
  background:var(--card); border:1px solid var(--line); display:flex; align-items:center; justify-content:center;
  font-size:16px; transition:top .2s ease; z-index:15; box-shadow:var(--shadow);}
.ascend-app .ptr.spin{animation:ascendSpin .7s linear infinite;}
@keyframes ascendSpin{to{transform:translateX(-50%) rotate(360deg);}}

.ascend-app .hud{position:sticky; top:0; z-index:20; padding:14px 14px 10px; background:linear-gradient(180deg,var(--bg) 55%,transparent);
  backdrop-filter:blur(6px);}
.ascend-app .hud-card{background:linear-gradient(165deg,var(--card3),var(--card)); border:1px solid var(--line);
  border-radius:14px; padding:16px; box-shadow:var(--shadow-lg); position:relative; overflow:hidden;}
.ascend-app[data-theme="light"]:not([data-celebration="true"]) .hud-card{background:linear-gradient(165deg,#fff2f7,#ffffff);}
.ascend-app .hud-card::after{content:''; position:absolute; inset:0; background:radial-gradient(circle at 15% 0%, var(--accent-glow), transparent 55%);
  opacity:.7; pointer-events:none;}
.ascend-app[data-theme="light"]:not([data-celebration="true"]) .hud-card::after{background:radial-gradient(circle at 15% 0%, rgba(255,140,190,0.16), transparent 55%);}
.ascend-app .hud-top{display:flex; align-items:center; gap:16px; position:relative;}
.ascend-app .rank-core{position:relative; width:78px; height:78px; flex:none; border-radius:50%;
  display:flex; align-items:center; justify-content:center; font-weight:800; font-size:21px; letter-spacing:.5px;
  font-family:var(--font-display);
  background:radial-gradient(circle at 35% 30%, var(--rc2), var(--rc1) 70%);
  box-shadow:0 0 0 4px var(--card), 0 0 28px 3px var(--rc1), inset 0 0 14px rgba(255,255,255,0.25);
  color:#0a0c14; transition:all .6s var(--ease);}

/* -- rank badge wrap: aura ring + tier-progress ring + rank-up burst -- */
.ascend-app .rank-badge-wrap{position:relative; flex:none;}
.ascend-app .rank-badge-wrap .rank-core{position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); z-index:2;}
.ascend-app .rank-aura{position:absolute; inset:0; border-radius:50%; z-index:1; pointer-events:none;
  background:conic-gradient(from 0deg, transparent 0%, var(--rc2) 12%, transparent 26%, transparent 100%);
  -webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 4px));
  mask:radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 4px));
  animation:rankAuraSpin 5s linear infinite; opacity:.85;}
@keyframes rankAuraSpin{to{transform:rotate(360deg);}}
.ascend-app .rank-progress-ring{position:absolute; inset:0; z-index:1; pointer-events:none;}
.ascend-app .rank-progress-ring circle{fill:none;}
.ascend-app .rank-progress-ring .rpr-bg{stroke:var(--card2); opacity:.6;}
.ascend-app[data-theme="light"]:not([data-celebration="true"]) .rank-progress-ring .rpr-bg{stroke:rgba(20,20,30,0.15); opacity:1;}
.ascend-app .rank-progress-ring .rpr-fg{stroke-linecap:round; transition:stroke-dashoffset .8s var(--ease);}
.ascend-app .rank-burst{position:absolute; inset:0; z-index:3; pointer-events:none;}
.ascend-app .rank-burst .flash{position:absolute; top:50%; left:50%; width:78px; height:78px; margin:-39px 0 0 -39px;
  border-radius:50%; background:radial-gradient(circle, #fff 0%, var(--rc2) 45%, transparent 72%);
  opacity:0; animation:rankBurstFlash .9s ease-out forwards;}
.ascend-app .rank-burst .bring{position:absolute; top:50%; left:50%; width:78px; height:78px; margin:-39px 0 0 -39px;
  border-radius:50%; border:2px solid var(--rc2); opacity:0; transform:scale(.35); animation:rankBurstRing 1s ease-out forwards;}
.ascend-app .rank-burst .bring.r2{animation-delay:.15s;}
.ascend-app .rank-burst .bring.r3{animation-delay:.3s;}
@keyframes rankBurstFlash{0%{opacity:.85; transform:scale(.3);}100%{opacity:0; transform:scale(1.5);}}
@keyframes rankBurstRing{0%{opacity:.9; transform:scale(.35);}100%{opacity:0; transform:scale(2.3);}}
.ascend-app .hud-mid{flex:1; min-width:0;}
.ascend-app .hud-label{font-size:10.5px; text-transform:uppercase; letter-spacing:1.8px; color:var(--sub2); font-weight:800;}
.ascend-app .hud-score{font-family:var(--font-display); font-size:36px; font-weight:800; letter-spacing:-1px; line-height:1.05; margin-top:2px;
  background:linear-gradient(180deg,var(--text),var(--text) 60%,var(--sub)); -webkit-background-clip:text; background-clip:text;}
.ascend-app .hud-score span{font-size:15px; color:var(--sub); font-weight:700; -webkit-text-fill-color:var(--sub); margin-left:2px;}
.ascend-app .hud-bar-track{margin-top:10px; height:10px; border-radius:8px; background:var(--card2); overflow:hidden; border:1px solid var(--line); position:relative;}
.ascend-app .hud-bar-fill{height:100%; border-radius:8px; background:linear-gradient(90deg,var(--accent),var(--accent2)); transition:width .6s var(--ease);
  box-shadow:0 0 12px var(--accent-glow); position:relative; overflow:hidden;}
.ascend-app .hud-bar-fill::after{content:''; position:absolute; inset:0; background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,0.35) 50%,transparent 70%);
  background-size:200% 100%; animation:ascendShimmer 2.6s linear infinite;}
@keyframes ascendShimmer{0%{background-position:200% 0;}100%{background-position:-40% 0;}}
.ascend-app .hud-meta{display:flex; justify-content:space-between; align-items:center; margin-top:8px; font-size:11px; color:var(--sub); gap:8px;}
.ascend-app .hud-meta > span:first-child{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.ascend-app .sync-pill{display:inline-flex; align-items:center; gap:4px; flex:none; font-weight:700; font-size:10.5px;
  padding:3px 8px 3px 6px; border-radius:20px; background:var(--card2); border:1px solid var(--line); color:var(--sub);}
.ascend-app .sync-pill .icon{opacity:.85;}
.ascend-app .sync-pill[data-state="synced"]{color:var(--green);}
.ascend-app .sync-pill[data-state="saving"]{color:var(--blue);}
.ascend-app .sync-pill[data-state="error"]{color:var(--red);}
.ascend-app .sync-pill[data-state="offline"]{color:var(--sub);}

.ascend-app .celebrate{margin-top:14px; border-radius:16px; padding:14px; text-align:center; font-weight:800;
  background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#1a1200; position:relative; overflow:hidden; box-shadow:var(--shadow);}
.ascend-app .celebrate .pop{position:absolute; animation:ascendPop 1.6s ease-in-out infinite;}
@keyframes ascendPop{0%,100%{transform:translateY(0) scale(1);}50%{transform:translateY(-6px) scale(1.15);}}
.ascend-app .celebrate.grand{font-size:16px; letter-spacing:.5px;}

.ascend-app .tabbar{position:fixed; left:0; right:0; bottom:calc(14px + env(safe-area-inset-bottom)); z-index:30; display:flex;
  background:color-mix(in srgb, var(--nav-bg) 95%, transparent);
  backdrop-filter:blur(18px); -webkit-backdrop-filter:blur(18px);
  border:1px solid color-mix(in srgb, var(--text) 12%, var(--line));
  border-radius:24px; box-shadow:0 10px 30px rgba(0,0,0,0.4), 0 2px 10px rgba(0,0,0,0.22);
  padding:6px; gap:2px; max-width:492px; margin:0 auto; width:calc(100% - 28px);}
.ascend-app .tab{flex:1; border:none; background:transparent; padding:8px 2px; border-radius:12px; font-size:10.5px; font-weight:700;
  color:var(--sub); display:flex; flex-direction:column; align-items:center; gap:4px; cursor:pointer; letter-spacing:.3px;
  transition:color .15s ease, background .2s var(--spring), transform .15s var(--spring);}
.ascend-app .tab:active{transform:scale(.93);}
.ascend-app .tab .ic{display:flex;}
.ascend-app .tab .ic .icon{transition:transform .3s var(--spring);}
.ascend-app .tab.active{color:var(--accent); background:color-mix(in srgb, var(--accent) 14%, transparent);}
.ascend-app .tab.active .ic .icon{transform:translateY(-1px) scale(1.08);}

.ascend-app .section-title{font-size:12.5px; font-weight:800; text-transform:uppercase; letter-spacing:1.4px; color:var(--sub2);
  margin:24px 2px 10px; display:flex; align-items:center; gap:8px; justify-content:space-between; line-height:1.3;}
.ascend-app .section-title .icon{color:var(--accent); opacity:.9;}
.ascend-app .card{background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow); margin-bottom:12px;
  transition:box-shadow .2s ease, transform .2s var(--spring);}
.ascend-app .card.subtle{background:var(--card2); box-shadow:none; border-color:var(--line-soft);}
.ascend-app .card.hero{background:linear-gradient(165deg,var(--card3),var(--card)); box-shadow:var(--shadow-lg); border-color:var(--line);}

.ascend-app .icon-chip{width:34px; height:34px; border-radius:11px; display:flex; align-items:center; justify-content:center; flex:none;
  background:color-mix(in srgb, var(--tone, var(--accent)) 16%, var(--card2)); color:var(--tone, var(--accent));}
.ascend-app .icon-chip.sm{width:28px; height:28px; border-radius:9px;}
.ascend-app .icon-chip.lg{width:44px; height:44px; border-radius:14px;}

.ascend-app .trio{display:grid; grid-template-columns:repeat(4,1fr); gap:6px;}
.ascend-app .trio-card{background:var(--card); border:1px solid var(--line); border-radius:14px; padding:10px 5px; text-align:center; cursor:pointer;
  box-shadow:var(--shadow-sm); transition:transform .15s var(--spring), box-shadow .15s ease;}
.ascend-app .trio-card:active{transform:scale(.95);}
.ascend-app .trio-card .icon-chip{margin:0 auto;}
.ascend-app .trio-card b{display:block; font-size:14px; margin-top:6px; line-height:1.2;}
.ascend-app .trio-card span{font-size:9px; color:var(--sub); text-transform:uppercase; letter-spacing:.4px; line-height:1.3;}
.ascend-app .compact-detail{margin-top:10px;}

.ascend-app .aspect-strip{display:flex; justify-content:space-between; gap:6px; margin-top:6px;}
.ascend-app .aspect-mini{flex:1; text-align:center; cursor:pointer; padding:6px 2px; transition:transform .12s ease;}
.ascend-app .aspect-mini:active{transform:scale(.96);}
.ascend-app .aspect-mini .name{font-size:11px; font-weight:700; margin-top:8px; line-height:1.35;}
.ascend-app .aspect-mini .emoji{font-size:12px; line-height:1; filter:grayscale(1) brightness(0) invert(1); display:inline-block; margin-right:3px; vertical-align:-1px;}
.ascend-app[data-theme="light"]:not([data-celebration="true"]) .aspect-mini .emoji{filter:grayscale(1) brightness(0);}
.ascend-app[data-theme="light"]:not([data-celebration="true"]) .ring .bg{stroke:rgba(20,20,30,0.15);}
.ascend-app .ring{width:48px; height:48px; margin:0 auto;}
.ascend-app .ring.big{width:72px; height:72px;}
.ascend-app .ring circle{fill:none; stroke-width:6;}
.ascend-app .ring.big circle{stroke-width:7;}
.ascend-app .ring .bg{stroke:var(--card2);}
.ascend-app .ring .fg{stroke:var(--accent); stroke-linecap:round; transition:stroke-dashoffset .6s ease;}
.ascend-app .ring text{font-size:12px; font-weight:800; fill:var(--text);}
.ascend-app .ring.big text{font-size:16px;}

.ascend-app .task-group{margin-bottom:10px;}
.ascend-app .task-group-title{font-size:11px; font-weight:800; color:var(--sub2); text-transform:uppercase; letter-spacing:1px; margin:16px 2px 8px;}
.ascend-app .task-row{display:flex; align-items:center; gap:12px; padding:12px 14px; margin-bottom:8px;
  background:var(--card2); border:1px solid var(--line-soft); border-radius:14px; cursor:pointer;
  transition:transform .15s var(--spring), background .25s ease, border-color .25s ease, box-shadow .2s ease;}
.ascend-app .task-row:last-child{margin-bottom:0;}
.ascend-app .task-row:active{transform:scale(.98);}
.ascend-app .task-row:hover{border-color:var(--line);}
.ascend-app .task-row.done{background:color-mix(in srgb, var(--accent) 9%, var(--card2)); border-color:color-mix(in srgb, var(--accent) 28%, var(--line-soft));}
.ascend-app .task-row.static{cursor:default;}
.ascend-app .task-row.static:active{transform:none;}
.ascend-app .task-row.locked{cursor:default;}
.ascend-app .chk{width:24px; height:24px; border-radius:8px; border:2px solid var(--sub2); flex:none; cursor:pointer;
  display:flex; align-items:center; justify-content:center; background:transparent; position:relative;
  transition:background .25s var(--spring), border-color .25s var(--spring), transform .15s var(--spring), box-shadow .3s ease;}
.ascend-app .chk:active{transform:scale(.88);}
.ascend-app .chk.on{background:var(--accent); border-color:var(--accent); color:#fff; box-shadow:0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent);}
.ascend-app .chk .chk-mark{animation:ascendCheckPop .32s var(--spring);}
@keyframes ascendCheckPop{0%{transform:scale(0) rotate(-20deg); opacity:0;}100%{transform:scale(1) rotate(0); opacity:1;}}
.ascend-app .task-name{flex:1; font-size:14px; font-weight:600; line-height:1.35; transition:color .25s ease;}
.ascend-app .task-xp{font-size:11px; color:var(--sub); font-weight:800; letter-spacing:.2px; flex:none;
  background:var(--card3); padding:4px 10px; border-radius:20px; transition:background .25s ease, color .25s ease;}
.ascend-app .task-row.done .task-name{color:var(--sub); text-decoration:line-through; text-decoration-color:var(--sub2); text-decoration-thickness:1.5px;}
.ascend-app .task-row.done .task-xp{background:color-mix(in srgb, var(--accent) 20%, var(--card3)); color:var(--accent);}
.ascend-app .task-row.static .task-name{font-weight:500;}
.ascend-app .task-row.static{background:var(--card2);}

.ascend-app .field-row{display:flex; gap:8px; margin-top:10px;}
.ascend-app .field-row input,.ascend-app .field-row textarea{flex:1; background:var(--card2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px; transition:border-color .15s ease;}
.ascend-app textarea{width:100%; min-height:70px; resize:vertical; background:var(--card2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px; margin-top:8px; transition:border-color .15s ease; line-height:1.4;}
.ascend-app input:focus,.ascend-app textarea:focus{border-color:var(--accent);}
.ascend-app .btn{background:var(--accent); color:#fff; border:none; padding:10px 16px; border-radius:10px; font-weight:700; font-size:13px; cursor:pointer;
  display:inline-flex; align-items:center; justify-content:center; gap:6px; letter-spacing:.2px; line-height:1.2;
  box-shadow:0 4px 14px var(--accent-glow);
  transition:transform .18s var(--spring), opacity .12s ease, box-shadow .18s ease;}
.ascend-app .btn:active:not(:disabled){transform:scale(.95);}
.ascend-app[data-celebration="true"] .btn{color:#1a1200;}
.ascend-app .btn.ghost{background:transparent; border:1px solid var(--line); color:var(--text);}
.ascend-app .btn.sm{padding:7px 12px; font-size:12px;}
.ascend-app .btn:disabled{opacity:.4; cursor:not-allowed;}
.ascend-app .btn.big{width:100%; padding:16px; font-size:16px; border-radius:16px;}
.ascend-app .btn.gold{background:linear-gradient(135deg,#ffd700,#fff2a8); color:#1a1200;}
.ascend-app .progress-line{display:flex; align-items:center; gap:10px; margin-top:6px;}
.ascend-app .progress-line .track{flex:1; height:10px; border-radius:6px; background:var(--card2); overflow:hidden;}
.ascend-app .progress-line .fill{height:100%; background:linear-gradient(90deg,var(--green),#8ff0b0); transition:width .5s var(--ease); box-shadow:0 0 10px rgba(61,220,132,0.35);}
.ascend-app .small-muted{font-size:11.5px; color:var(--sub);}

.ascend-app .day-header{display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; font-size:12.5px; flex-wrap:wrap;}
.ascend-app .day-header-note{flex:1 1 200px; min-width:0; line-height:1.4;}
.ascend-app .day-header .btn{flex:none;}
.ascend-app .week-card{background:linear-gradient(165deg,var(--card2),var(--card)); position:relative; overflow:hidden; border-radius:14px;}
.ascend-app[data-theme="light"]:not([data-celebration="true"]) .week-card{background:linear-gradient(165deg,#fff2f7,#ffffff);}
.ascend-app .week-card::after{content:''; position:absolute; inset:0; background:radial-gradient(circle at 100% 0%, var(--accent-glow), transparent 55%);
  opacity:.5; pointer-events:none;}
.ascend-app[data-theme="light"]:not([data-celebration="true"]) .week-card::after{background:radial-gradient(circle at 100% 0%, rgba(255,140,190,0.16), transparent 55%);}
.ascend-app .week-nav{display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:16px; position:relative;}
.ascend-app .week-nav-mid{display:flex; flex:1; align-items:center; justify-content:space-between; gap:8px; min-width:0;}
.ascend-app .week-nav-mid > span:first-child{display:flex; align-items:center; gap:5px; min-width:0;}
.ascend-app .week-nav-mid b{font-size:15px; font-family:var(--font-display); letter-spacing:-.2px; white-space:nowrap;}
.ascend-app .legend-info-btn{width:16px; height:16px; border-radius:50%; border:1px solid var(--line); background:var(--card2);
  color:var(--sub); font-size:10px; font-style:italic; font-weight:700; font-family:Georgia,serif; line-height:1;
  display:flex; align-items:center; justify-content:center; cursor:pointer;
  padding:0; flex:none; transition:transform .15s var(--spring), background .15s ease, color .15s ease, border-color .15s ease;}
.ascend-app .legend-info-btn:active{transform:scale(.88);}
.ascend-app .legend-info-btn.active{background:color-mix(in srgb, var(--accent) 18%, var(--card3)); color:var(--accent2); border-color:var(--accent);}
.ascend-app .badge.accent{background:color-mix(in srgb, var(--accent) 18%, var(--card3)); color:var(--accent2);}
.ascend-app .navbtn{width:34px; height:34px; border-radius:11px; border:1px solid var(--line); background:var(--card2); color:var(--text);
  display:flex; align-items:center; justify-content:center; cursor:pointer; flex:none;
  transition:transform .15s var(--spring), background .15s ease, opacity .15s ease;}
.ascend-app .navbtn:active:not(:disabled){transform:scale(.9);}
.ascend-app .navbtn:disabled{opacity:.35; cursor:not-allowed;}
.ascend-app .week-path{position:relative; padding-top:2px;}
.ascend-app .week-path-line{position:absolute; top:12px; left:calc(100%/14); right:calc(100%/14); height:3px; border-radius:3px;
  background:var(--line); overflow:hidden; z-index:0;}
.ascend-app .week-path-fill{height:100%; background:linear-gradient(90deg,var(--accent),var(--accent2)); border-radius:3px; transition:width .6s var(--ease);}
.ascend-app .dots{display:flex; position:relative; z-index:1;}
.ascend-app .day-dot{flex:1; display:flex; flex-direction:column; align-items:center; gap:7px; font-size:10px; color:var(--sub); cursor:pointer;}
.ascend-app .dot{width:23px; height:23px; border-radius:50%; background:var(--card2); border:2px solid var(--line);
  transition:transform .18s var(--spring), box-shadow .18s ease; position:relative;}
.ascend-app .day-dot:active .dot{transform:scale(.82);}
.ascend-app .dot.g{background:linear-gradient(150deg,#6bffb0,var(--green)); border-color:var(--green); box-shadow:0 2px 10px rgba(61,220,132,0.4);}
.ascend-app .dot.y{background:linear-gradient(150deg,#ffe08a,var(--yellow)); border-color:var(--yellow); box-shadow:0 2px 10px rgba(255,204,77,0.35);}
.ascend-app .dot.r{background:linear-gradient(150deg,#ff8a8a,var(--red)); border-color:var(--red); box-shadow:0 2px 10px rgba(255,92,92,0.35);}
.ascend-app .dot.b{background:linear-gradient(150deg,#7fc2ff,var(--blue)); border-color:var(--blue); box-shadow:0 2px 10px rgba(61,139,255,0.35);}
.ascend-app .dot.today{box-shadow:0 0 0 3px var(--accent), 0 0 10px var(--accent-glow);}
.ascend-app .dot.today::after{content:''; position:absolute; inset:-5px; border-radius:50%; border:2px solid var(--accent);
  opacity:.55; animation:ascendDotPulse 1.8s ease-out infinite;}
@keyframes ascendDotPulse{0%{transform:scale(.75); opacity:.6;}100%{transform:scale(1.35); opacity:0;}}
.ascend-app .dot.selected{box-shadow:0 0 0 2px var(--text);}
.ascend-app .dow-label{font-weight:600; transition:color .2s ease;}
.ascend-app .dow-label.is-today{color:var(--accent); font-weight:800;}
.ascend-app .dow-label.is-sel:not(.is-today){color:var(--text); font-weight:800;}
.ascend-app .legend-row{display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px;}
.ascend-app .legend-popover{padding:9px 10px; background:var(--card2); border:1px solid var(--line); border-radius:var(--radius-sm);
  animation:ascendLegendIn .18s var(--spring);}
.ascend-app .legend-item{display:flex; align-items:center; gap:6px; white-space:nowrap;}
.ascend-app .legend-dot{width:8px; height:8px; border-radius:50%; display:inline-block; flex:none;}
@keyframes ascendLegendIn{from{opacity:0; transform:translateY(-4px);}to{opacity:1; transform:translateY(0);}}

.ascend-app .ach-row{margin-bottom:16px;}
.ascend-app .ach-head{display:flex; justify-content:space-between; font-size:13px; font-weight:700; margin-bottom:6px;}
.ascend-app .stepper{display:flex; gap:6px;}
.ascend-app .step{flex:1; height:14px; border-radius:5px; background:var(--card2); border:1px solid var(--line); cursor:pointer;
  transition:background .2s var(--spring), transform .15s var(--spring), box-shadow .2s ease;}
.ascend-app .step:active{transform:scaleY(.8);}
.ascend-app .step.on{background:var(--accent); border-color:var(--accent); box-shadow:0 0 8px var(--accent-glow);}
.ascend-app .chapter-input{display:flex; align-items:center; gap:8px; margin-top:8px;}
.ascend-app .chapter-input input{width:70px; background:var(--card2); border:1px solid var(--line); border-radius:8px; padding:8px; text-align:center; font-size:14px;}

.ascend-app .milestone-grid{display:flex; flex-wrap:wrap; gap:8px;}
.ascend-app .ms{padding:10px 12px; border-radius:12px; border:1px solid var(--line-soft); background:var(--card2); font-size:12.5px; font-weight:700; cursor:pointer; flex:1 1 30%; text-align:center;
  transition:transform .15s var(--spring), background .2s ease, border-color .2s ease, box-shadow .2s ease;}
.ascend-app .ms:active{transform:scale(.96);}
.ascend-app .ms.on{background:var(--green); color:#08130c; border-color:var(--green); box-shadow:0 2px 10px rgba(61,220,132,0.3);}

.ascend-app .pen-active{padding:16px; border-radius:var(--radius); text-align:center; font-weight:800;}
.ascend-app .pen-level0{background:color-mix(in srgb,var(--green) 18%,var(--card));}
.ascend-app .pen-level1{background:color-mix(in srgb,var(--yellow) 20%,var(--card));}
.ascend-app .pen-level2,.ascend-app .pen-level3{background:color-mix(in srgb,#ff9a3d 22%,var(--card));}
.ascend-app .pen-level4,.ascend-app .pen-level5{background:color-mix(in srgb,var(--red) 24%,var(--card));}
.ascend-app .pen-list .task-row{align-items:flex-start;}
.ascend-app .badge{font-size:10px; font-weight:800; padding:3px 8px; border-radius:20px; background:var(--card3); color:var(--sub);}
.ascend-app .pen-meter{display:flex; gap:4px; margin-top:10px;}
.ascend-app .pen-meter .seg{flex:1; height:8px; border-radius:4px; background:var(--card2); border:1px solid var(--line); transition:background .2s ease, box-shadow .2s ease;}
.ascend-app .pen-meter .seg.on{background:var(--red); box-shadow:0 0 6px rgba(255,92,92,0.4);}

.ascend-app .swatch-row{display:flex; gap:10px; flex-wrap:wrap; margin-top:8px;}
.ascend-app .theme-swatch{width:68px; height:68px; border-radius:16px; border:2px solid var(--line); cursor:pointer; display:flex; align-items:center; justify-content:center; background:var(--card2); overflow:hidden; position:relative; transition:transform .12s ease, border-color .12s ease;}
.ascend-app .theme-swatch:active{transform:scale(.95);}
.ascend-app .theme-swatch.sel{border-color:var(--accent); transform:scale(1.06);}
.ascend-app .theme-swatch span.tlabel{position:absolute; bottom:1px; left:0; right:0; font-size:7px; text-align:center; font-weight:700; background:rgba(0,0,0,0.35); color:#fff; padding:1px 0;}
.ascend-app .swatch{width:34px; height:34px; border-radius:50%; border:2px solid var(--line); cursor:pointer; transition:transform .12s ease;}
.ascend-app .swatch:active{transform:scale(.9);}
.ascend-app .swatch.sel{border-color:var(--text); transform:scale(1.1);}
.ascend-app .toggle-row{display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; margin-bottom:8px;
  background:var(--card2); border:1px solid var(--line-soft); border-radius:14px; transition:border-color .2s ease;}
.ascend-app .toggle-row:last-child{margin-bottom:0;}
.ascend-app .switch{width:46px; height:26px; border-radius:20px; background:var(--card3); border:1px solid var(--line); position:relative; cursor:pointer; transition:background .15s ease; flex:none;}
.ascend-app .switch.on{background:var(--accent); border-color:var(--accent);}
.ascend-app .switch::after{content:''; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; transition:left .2s var(--spring); box-shadow:0 1px 3px rgba(0,0,0,0.25);}
.ascend-app .switch.on::after{left:22px;}
.ascend-app .edit-task-row{display:flex; gap:8px; align-items:center; padding:9px 10px; margin-bottom:6px;
  background:var(--card2); border:1px solid var(--line-soft); border-radius:12px;}
.ascend-app .edit-task-row:last-child{margin-bottom:0;}
.ascend-app .edit-task-row input[type=text]{flex:1; background:var(--card3); border:1px solid var(--line); border-radius:8px; padding:7px 9px; font-size:13px;}
.ascend-app .edit-task-row input[type=number]{width:56px; background:var(--card3); border:1px solid var(--line); border-radius:8px; padding:7px 6px; font-size:13px; text-align:center;}
.ascend-app .iconbtn{background:none; border:none; color:var(--sub); font-size:16px; cursor:pointer; padding:4px 6px;
  display:inline-flex; align-items:center; justify-content:center; border-radius:6px; transition:color .15s ease, background .15s ease;}
.ascend-app .iconbtn:hover{color:var(--red); background:var(--card3);}
.ascend-app .lockbar{display:flex; align-items:center; gap:8px; background:var(--card2); border:1px solid var(--line); border-radius:12px; padding:10px 12px; margin-bottom:14px; font-size:12.5px;}
.ascend-app .icon{vertical-align:-3px; flex:none;}
.ascend-app .lockbar .icon{color:var(--accent);}
.ascend-app .hidden{display:none !important;}
.ascend-app .arc-desc{font-size:12px; color:var(--sub); margin-bottom:8px;}
.ascend-app .log-row{display:flex; justify-content:space-between; align-items:center; padding:9px 12px; margin-bottom:6px;
  background:var(--card2); border:1px solid var(--line-soft); border-radius:11px; font-size:12px;}
.ascend-app .log-row:last-child{margin-bottom:0;}
.ascend-app .log-row span{display:inline-flex; align-items:center; gap:5px;}

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

/* -- thin progress ring drawn around the rank badge, no label -- */
function RankProgressRing({ pct, size = 92, stroke = 3, color }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - clamp(pct, 0, 1));
  return (
    <svg className="rank-progress-ring" viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
      <circle className="rpr-bg" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
      <circle
        className="rpr-fg" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke}
        strokeDasharray={c} strokeDashoffset={off} style={{ stroke: color }}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/* -- rank badge: core + spinning aura halo + tier-progress ring + rank-up burst -- */
function RankBadge({ rank, score, size = 78 }) {
  const ringSize = size + 14;
  const prevTierRef = useRef(rank.tier);
  const [burst, setBurst] = useState(false);

  useEffect(() => {
    if (rank.tier > prevTierRef.current) {
      setBurst(true);
      const t = setTimeout(() => setBurst(false), 1000);
      prevTierRef.current = rank.tier;
      return () => clearTimeout(t);
    }
    prevTierRef.current = rank.tier;
  }, [rank.tier]);

  const progress = useMemo(() => {
    if (rank.name === "S+") return 1;
    const t = tierFor(score);
    if (t >= 5) return 1; // maxed out at S from score alone; S+ only via Final Ascent
    return clamp((score - t * 18) / 18, 0, 1);
  }, [score, rank.name]);

  return (
    <div className="rank-badge-wrap" style={{ width: ringSize, height: ringSize }}>
      <div className="rank-aura" style={{ "--rc1": rank.glow[0], "--rc2": rank.glow[1] }} />
      <RankProgressRing pct={progress} size={ringSize} color={rank.glow[1]} />
      <div className="rank-core" style={{ "--rc1": rank.glow[0], "--rc2": rank.glow[1], width: size, height: size }}>
        {rank.name}
      </div>
      {burst && (
        <div className="rank-burst" style={{ "--rc1": rank.glow[0], "--rc2": rank.glow[1] }}>
          <div className="flash" />
          <div className="bring" />
          <div className="bring r2" />
          <div className="bring r3" />
        </div>
      )}
    </div>
  );
}

function TaskRow({ id, name, xp, done, onToggle, disabled, unit = "XP" }) {
  return (
    <div className={`task-row ${done ? "done" : ""} ${disabled ? "locked" : ""}`} onClick={disabled ? undefined : onToggle}>
      <div className={`chk ${done ? "on" : ""}`}>
        {done && <Icon name="check" size={13} className="chk-mark" />}
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
const SYNC_META = {
  synced: { icon: "cloud", label: "Synced" },
  saving: { icon: "save", label: "Saving…" },
  loading: { icon: "cloud", label: "Connecting…" },
  offline: { icon: "cloud-off", label: "Offline — saved on this device" },
  error: { icon: "alert", label: "Sync error — saved on this device" },
};
function Hud({ score, rank, syncStatus, showBadge, gameCompleted }) {
  const syncMeta = SYNC_META[syncStatus] || SYNC_META.synced;
  return (
    <div className="hud">
      <div className="hud-card">
        <div className="hud-top">
          {showBadge && <RankBadge rank={rank} score={score} />}
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
              <span className="sync-pill" data-state={syncStatus}>
                <Icon name={syncMeta.icon} size={12} />
                {syncMeta.label}
              </span>
            </div>
          </div>
        </div>
      </div>
      {gameCompleted && (
        <div className="celebrate grand">
          <span className="pop" style={{ left: "8%", top: 6 }}><Icon name="trophy" size={18} /></span>
          <span className="pop" style={{ right: "8%", top: 6, animationDelay: ".3s" }}><Icon name="trophy" size={18} /></span>
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
        <div className="big-badge"><Icon name="lock" size={40} /></div>
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
        <div className="big-badge"><Icon name="lock" size={40} /></div>
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
        <div className="big-badge"><Icon name="lock" size={40} /></div>
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
      <div className="big-badge"><Icon name="lock" size={40} /></div>
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
      <div className="big-badge"><Icon name="mountain" size={40} /></div>
      <h2 style={{ margin: "0 0 8px" }}>ASCEND: The Takeover</h2>
      <p className="small-muted" style={{ maxWidth: 280 }}>
        33 weeks. 231 days. Campaign start: 17 Aug 2026.
      </p>
      {isOwner ? (
        <button className="btn big" style={{ maxWidth: 260, marginTop: 18 }} onClick={onStart}>
          <Icon name="rocket" size={16} /> Begin the Campaign
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
  const [showLegend, setShowLegend] = useState(false);

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
          <div className="icon-chip sm" style={{ "--tone": "var(--blue)" }}><Icon name="note" size={15} /></div>
          <b>{plannerCount}</b>
          <span>Today's Plan</span>
        </div>
        <div className="trio-card" onClick={() => setCompactExpanded((s) => ({ ...s, recap: !s.recap }))}>
          <div className="icon-chip sm" style={{ "--tone": "var(--accent)" }}><Icon name="clipboard" size={15} /></div>
          <b>{recapDone.length}</b>
          <span>Daily Recap</span>
        </div>
        <div className="trio-card" onClick={() => setCompactExpanded((s) => ({ ...s, protein: !s.protein }))}>
          <div className="icon-chip sm" style={{ "--tone": "var(--green)" }}><Icon name="utensils" size={15} /></div>
          <b>{rec.protein || 0}g</b>
          <span>Protein</span>
        </div>
        <div className="trio-card" onClick={() => document.getElementById("aspect-detail")?.scrollIntoView({ behavior: "smooth" })}>
          <div className="icon-chip sm" style={{ "--tone": "var(--yellow)" }}><Icon name="bolt" size={15} /></div>
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
      <div className="card week-card">
        {(() => {
          const weekStatuses = Array.from({ length: 7 }).map((_, i) => {
            const d = addDays(wStart, i);
            const dr = days[d];
            let cls = "";
            if (d > t) cls = "";
            else if (dr && dr.leave) cls = "y";
            else if (dr && dr.leaveOrdinary) cls = "b";
            else if (dr) cls = dayXP(days, config.tasks, d) >= config.threshold ? "g" : "r";
            else cls = d < t ? "r" : "";
            return { d, cls };
          });
          const elapsedDays = weekStatuses.filter((s) => s.d <= t).length;
          const onTrackDays = weekStatuses.filter((s) => s.cls === "g" || s.cls === "y" || s.cls === "b").length;
          return (
            <>
              <div className="week-nav">
                <button
                  className="navbtn" disabled={viewWeekN <= 1}
                  onClick={() => setViewWeekN((w) => clamp(w - 1, 1, currentWeekN))}
                ><Icon name="chevron-left" size={17} /></button>
                <div className="week-nav-mid">
                  <span>
                    <b>Week {viewWeekN}</b>
                    <button
                      type="button"
                      className={`legend-info-btn ${showLegend ? "active" : ""}`}
                      aria-label="Show dot color legend"
                      aria-expanded={showLegend}
                      onClick={() => setShowLegend((v) => !v)}
                    >
                      i
                    </button>
                  </span>
                  {elapsedDays > 0 && <span className="badge accent">{onTrackDays}/{elapsedDays} on track</span>}
                </div>
                <button
                  className="navbtn" disabled={viewWeekN >= currentWeekN}
                  onClick={() => setViewWeekN((w) => clamp(w + 1, 1, currentWeekN))}
                ><Icon name="chevron-right" size={17} /></button>
              </div>
              <div className="week-path">
                <div className="week-path-line"><div className="week-path-fill" style={{ width: `${(elapsedDays / 7) * 100}%` }} /></div>
                <div className="dots">
                  {weekStatuses.map(({ d, cls }, i) => (
                    <div className="day-dot" key={d} onClick={() => { if (d <= t) openDay(d); }}>
                      <div className={`dot ${cls} ${d === t ? "today" : ""} ${d === sel ? "selected" : ""}`} />
                      <span className={`dow-label ${d === t ? "is-today" : ""} ${d === sel ? "is-sel" : ""}`}>{dow[i]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          );
        })()}
        {showLegend && (
          <div className="small-muted legend-row legend-popover" style={{ marginTop: 10 }}>
            <span className="legend-item"><span className="legend-dot" style={{ background: "var(--green)" }} />sufficient XP</span>
            <span className="legend-item"><span className="legend-dot" style={{ background: "var(--yellow)" }} />paid leave</span>
            <span className="legend-item"><span className="legend-dot" style={{ background: "var(--blue)" }} />leave</span>
            <span className="legend-item"><span className="legend-dot" style={{ background: "var(--red)" }} />insufficient XP</span>
            <span className="legend-item">ring = today (IST)</span>
          </div>
        )}
        {sel !== t && (
          <div className="day-header" style={{ marginTop: 10 }}>
            <span className="small-muted day-header-note">Viewing &amp; editing {fmtDate(sel)} — everything planned and done that day is in Daily Recap above</span>
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
              <Ring pct={pct} size={64} />
              <div className="name"><span className="emoji">{iconEmoji(cat.icon)}</span><span>{cat.label}</span></div>
            </div>
          );
        })}
        <div className="aspect-mini" onClick={() => setOpenAspect((a) => (a === "skills" ? null : "skills"))}>
          <Ring pct={skillsPct(config, achievements)} size={64} />
          <div className="name"><span className="emoji">{iconEmoji("graduation")}</span><span>Skills</span></div>
        </div>
      </div>
      {openAspect && openAspect !== "skills" && (
        <div className="card" id="aspect-detail" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
            <CatIcon icon={config.tasks[openAspect].icon} size={15} /> {config.tasks[openAspect].label}
          </div>
          {config.tasks[openAspect].tasks.map((tk) => (
            <TaskRowStatic key={tk.id} name={tk.name} xp={tk.xp} />
          ))}
        </div>
      )}
      {openAspect === "skills" && (
        <div className="card" id="aspect-detail" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="graduation" size={15} /> Skills
          </div>
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
          {isOwner
            ? <><Icon name="unlock" size={14} /> Owner mode — you can edit everything.</>
            : <><Icon name="lock" size={14} /> View-only mode — you can watch progress but not edit it.</>}
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
                  <span>{l.role === "owner" ? <><Icon name="unlock" size={12} /> Owner</> : <><Icon name="eye" size={12} /> Viewer</>}</span>
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
              <button className="iconbtn" title="Delete task" onClick={() => deleteTask(tk.catKey, tk.id)}><Icon name="x" size={14} /></button>
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
// Ambient celebration particles for the "Final Ascent" completion state only —
// the earlier per-theme twinkling stars / floating dots have been removed.
function themeParticles(celebration) {
  if (celebration) return { shapes: [{ shape: "star", color: "#ffe873" }, { shape: "dot", color: "#ff9de2" }, { shape: "dot", color: "#7c5cff" }], anim: "float" };
  return null;
}
function SparkleLayer({ celebration }) {
  const parts = useMemo(() => themeParticles(celebration), [celebration]);
  const particles = useMemo(() => {
    if (!parts) return [];
    const { shapes, anim } = parts;
    return Array.from({ length: 14 }).map((_, i) => {
      const { shape, color } = shapes[i % shapes.length];
      const size = 6 + Math.random() * 8;
      return { key: i, shape, color, size, duration: 8 + Math.random() * 10, delay: Math.random() * 10, style: { left: `${Math.random() * 100}%`, bottom: "-40px" }, cls: anim };
    });
  }, [parts]);
  if (!parts) return null;
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
  { id: "home", label: "Home", ic: "home" },
  { id: "goals", label: "Milestone & Goals", ic: "trophy" },
  { id: "penalties", label: "Penalties", ic: "shield" },
  { id: "settings", label: "Settings", ic: "gear" },
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
      <SparkleLayer celebration={gameCompleted} />
      <div className="app">
        <div className={`ptr ${ptrSpin ? "spin" : ""} ${ptrY <= -50 ? "hidden" : ""}`} style={{ top: ptrY }}><Icon name="refresh" size={16} /></div>

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
                  <span className="ic"><Icon name={tab.ic} size={19} /></span>
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
