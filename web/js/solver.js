// Uni schedule optimizer. Used by the web app (through worker.js) and by cli.mjs.
//
// Picks one option (section) for every course so that nothing overlaps,
// every mandatory course is included, and the weighted "badness" score
// (days on campus, 8 am starts, gaps, late finishes ...) is as low as possible.
//
// tests/solver.test.mjs checks the results against saved ones: run `npm test` after a change.
//
// Data shapes (plain objects, so they can be sent to a Web Worker):
//   Meeting { day: 0..6 (Mon..Sun), start: minutes, end: minutes, weeks: bitmask }
//   Option  { course: string, name: string, meetings: Meeting[] }
//   Course  { name: string, mandatory: boolean, options: Option[] }

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const EVEN = 0;
export const ODD = 1;
// Week parities as a bitmask: bit 0 = even ISO weeks, bit 1 = odd ISO weeks.
export const EVERY_WEEK = 0b11;
const WEEK_NAMES = { even: 0b01, odd: 0b10, every: EVERY_WEEK };

export const DEFAULT_WEIGHTS = {
  day: 100, // per day you have to go in
  early: 30, // per class starting before `early_before`
  gap_hour: 10, // per hour of idle time between classes, beyond GAP_ALLOWANCE
  late: 15, // per class ending after `late_after`
  optional_missing: 40, // per optional course left out
};
export const DEFAULT_SETTINGS = { early_before: "09:00", late_after: "18:00" };
// Free minutes between two classes before it counts as a gap (time to change rooms).
export const GAP_ALLOWANCE = 30;

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":");
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

export function toHHMM(minutes) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function weeksName(weeks) {
  if (weeks === EVERY_WEEK) return "every";
  return weeks & (1 << ODD) ? "odd" : "even";
}

const inWeek = (m, week) => (m.weeks & (1 << week)) !== 0;

export function overlaps(a, b) {
  return a.day === b.day && a.start < b.end && b.start < a.end && (a.weeks & b.weeks) !== 0;
}

const meetingKey = (m) => `${m.day},${m.start},${m.end},${m.weeks}`;

/** Drops meetings listed twice (same time, different room), keeping first-seen order. */
function uniqueMeetings(meetings) {
  const seen = new Map();
  for (const m of meetings) if (!seen.has(meetingKey(m))) seen.set(meetingKey(m), m);
  return [...seen.values()];
}

// ---------------------------------------------------------------- loading

export function loadNative(data) {
  const courses = [];
  for (const c of data.courses ?? []) {
    const options = c.options.map((o) => ({
      course: c.name,
      name: o.name,
      meetings: o.meetings.map((m) => ({
        day: DAYS.indexOf(m.day),
        start: toMinutes(m.start),
        end: toMinutes(m.end),
        weeks: WEEK_NAMES[m.weeks ?? "every"],
      })),
    }));
    courses.push({ name: c.name, mandatory: c.mandatory ?? true, options });
  }
  return courses;
}

/** ISO weekday (1 = Mon) and ISO week number of a "YYYY-MM-DD" date, timezone-free. */
function isoCalendar(ymd) {
  const [y, mo, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday); // Thursday of the same ISO week
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return { weekday, week };
}

/** One weekly slot of a Neptun section; its week parity comes from the actual dates. */
function neptunMeeting(info, dates) {
  let weeks = 0;
  for (const d of dates ?? []) {
    const ymd = d.fromTime.slice(0, 10);
    const hhmm = d.fromTime.slice(11, 16);
    const { weekday, week } = isoCalendar(ymd);
    if (weekday === info.dayOfWeek && hhmm === info.startTime) weeks |= 1 << week % 2;
  }
  return {
    day: info.dayOfWeek - 1,
    start: toMinutes(info.startTime),
    end: toMinutes(info.endTime),
    weeks: weeks || EVERY_WEEK,
  };
}

/** Neptun course list: each subject + type (lecture, practice, lab ...) becomes one course. */
export function loadNeptun(data, includeRestricted, language, warnings) {
  const courses = new Map();
  for (const s of data.data) {
    if (!s.classInstanceInfos || s.classInstanceInfos.length === 0) continue; // e.g. exam-only course
    const name = `${s.title} ${s.type.toLowerCase()}`;
    const key = `${s.subjectId}\u0000${s.type}`;
    if (!courses.has(key)) courses.set(key, { name, mandatory: true, options: [] });
    const course = courses.get(key);
    const requirement = (s.signinRequirementText ?? "").split(/\s+/).filter(Boolean).join(" ");
    let reason = null;
    let kind = null;
    if (s.language !== language) {
      kind = "language";
      reason = `taught in ${s.language ?? "None"}`;
    } else if (requirement.toUpperCase().includes("IMSC")) {
      kind = "imsc";
      reason = "IMSc group";
      // A section you are already signed up for is kept despite other restrictions.
    } else if (requirement && !s.isSigned && !includeRestricted) {
      kind = "restricted";
      reason = `restricted, ${requirement}`;
    }
    if (reason) {
      warnings.push({
        kind,
        course: name,
        code: s.code,
        detail: kind === "language" ? s.language ?? null : requirement,
        message: `skipping ${name} (${s.code}): ${reason}`,
      });
      continue;
    }
    const meetings = uniqueMeetings(
      s.classInstanceInfos.map((i) => neptunMeeting(i, s.classInstanceTimeTableList)),
    );
    course.options.push({ course: name, name: s.code, meetings });
  }
  return [...courses.values()];
}

/**
 * Combine already-parsed JSON documents (our format, a Neptun response,
 * or har.js output) into one problem.
 */
export function loadData(datas, { includeRestricted = false, language = "magyar" } = {}) {
  const courses = [];
  const weights = { ...DEFAULT_WEIGHTS };
  const settings = { ...DEFAULT_SETTINGS };
  const warnings = [];
  for (const data of datas) {
    if (Array.isArray(data)) {
      for (const subject of data) courses.push(...loadNeptun(subject.data, includeRestricted, language, warnings));
    } else if (Array.isArray(data.data)) {
      courses.push(...loadNeptun(data, includeRestricted, language, warnings));
    } else {
      courses.push(...loadNative(data));
      Object.assign(weights, data.weights ?? {});
      Object.assign(settings, data.settings ?? {});
    }
  }
  for (const c of courses) {
    if (c.options.length === 0) {
      warnings.push({ kind: "empty", course: c.name, message: `warning: ${c.name} has no available section` });
    }
  }
  return { courses, weights, settings, warnings };
}

// ---------------------------------------------------------------- scoring

export class Scorer {
  constructor(weights, settings, optionalNames) {
    this.w = weights;
    this.earlyBefore = toMinutes(settings.early_before);
    this.lateAfter = toMinutes(settings.late_after);
    this.optionalNames = new Set(optionalNames);
    this.nOptional = this.optionalNames.size;
  }

  /** Penalty counts for an average week (mean of an even and an odd week). */
  breakdown(chosen) {
    let days = 0, early = 0, late = 0, gapMinutes = 0;
    for (const week of [EVEN, ODD]) {
      const meetings = [];
      for (const o of chosen) for (const m of o.meetings) if (inWeek(m, week)) meetings.push(m);
      const byDay = new Map();
      for (const m of meetings) {
        if (!byDay.has(m.day)) byDay.set(m.day, []);
        byDay.get(m.day).push(m);
      }
      for (const dayMeetings of byDay.values()) {
        dayMeetings.sort((a, b) => a.start - b.start);
        for (let i = 1; i < dayMeetings.length; i++) {
          gapMinutes += Math.max(0, dayMeetings[i].start - dayMeetings[i - 1].end - GAP_ALLOWANCE);
        }
      }
      days += byDay.size;
      for (const m of meetings) {
        if (m.start < this.earlyBefore) early++;
        if (m.end > this.lateAfter) late++;
      }
    }
    let nOptionalTaken = 0;
    for (const o of chosen) if (this.optionalNames.has(o.course)) nOptionalTaken++;
    return {
      days: days / 2,
      early: early / 2,
      gap_hours: gapMinutes / 120,
      late: late / 2,
      optional_missing: this.nOptional - nOptionalTaken,
    };
  }

  score(chosen) {
    const b = this.breakdown(chosen);
    return (
      b.days * this.w.day +
      b.early * this.w.early +
      b.gap_hours * this.w.gap_hour +
      b.late * this.w.late +
      b.optional_missing * this.w.optional_missing
    );
  }

  /**
   * Cost that can only grow as more options are added (used for pruning).
   * Gaps are excluded because filling a gap can shrink it, and courses
   * not yet decided might still be taken, so they are not counted missing.
   */
  lowerBound(chosen, optionalLeft) {
    const b = this.breakdown(chosen);
    return (
      b.days * this.w.day +
      b.early * this.w.early +
      b.late * this.w.late +
      (b.optional_missing - optionalLeft) * this.w.optional_missing
    );
  }
}

// ---------------------------------------------------------------- search

/** Sections meeting at exactly the same times are interchangeable: search them once. */
export function mergeSameTime(course) {
  const groups = new Map();
  for (const o of course.options) {
    const key = [...new Set(o.meetings.map(meetingKey))].sort().join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const options = [...groups.values()].map((g) => ({
    course: course.name,
    name: g.map((o) => o.name).join(", "),
    meetings: g[0].meetings,
  }));
  return { name: course.name, mandatory: course.mandatory, options };
}

/**
 * Branch-and-bound search. Returns up to `top` [score, chosenOptions] pairs, best first.
 * `onProgress(nodes)` (optional) is called every 50 000 search nodes.
 */
export function solve(coursesIn, scorer, top, onProgress) {
  if (top < 1) return [];
  const courses = coursesIn.map(mergeSameTime);
  // Most constrained first: fewer options -> earlier failures -> faster search.
  const order = [...courses].sort(
    (a, b) => (a.mandatory ? 0 : 1) - (b.mandatory ? 0 : 1) || a.options.length - b.options.length,
  );
  const optionalAfter = [];
  for (let i = 0; i <= order.length; i++) optionalAfter.push(order.slice(i).filter((c) => !c.mandatory).length);

  // Kept schedules. On equal scores the earliest-found one is evicted first;
  // the final list is sorted by (score, discovery order).
  const best = []; // { score, n, chosen }
  let counter = 0;
  let nodes = 0;

  const worstIndex = () => {
    let wi = 0;
    for (let i = 1; i < best.length; i++) {
      const a = best[i], w = best[wi];
      if (a.score > w.score || (a.score === w.score && a.n < w.n)) wi = i;
    }
    return wi;
  };
  const worstKept = () => (best.length >= top ? best[worstIndex()].score : Infinity);

  const search = (i, chosen, taken) => {
    if (onProgress && ++nodes % 50000 === 0) onProgress(nodes);
    if (scorer.lowerBound(chosen, optionalAfter[i]) > worstKept()) return;
    if (i === order.length) {
      const s = scorer.score(chosen);
      if (s < worstKept()) {
        best.push({ score: s, n: counter++, chosen: [...chosen] });
        if (best.length > top) best.splice(worstIndex(), 1);
      }
      return;
    }
    const course = order[i];
    for (const opt of course.options) {
      if (opt.meetings.some((m) => taken.some((t) => overlaps(m, t)))) continue;
      chosen.push(opt);
      search(i + 1, chosen, taken.concat(opt.meetings));
      chosen.pop();
    }
    if (!course.mandatory) search(i + 1, chosen, taken);
  };

  search(0, [], []);
  return best.sort((a, b) => a.score - b.score || a.n - b.n).map((e) => [e.score, e.chosen]);
}

// ---------------------------------------------------------------- clash explanation
// Web-only helpers (no counterpart in main.py): they explain an empty result.

/** True if every mandatory course can get a section without clashes (optional ones can always be skipped). */
function mandatoryFit(courses) {
  const order = courses
    .filter((c) => c.mandatory)
    .map(mergeSameTime)
    .sort((a, b) => a.options.length - b.options.length);
  const search = (i, taken) => {
    if (i === order.length) return true;
    for (const opt of order[i].options) {
      if (opt.meetings.some((m) => taken.some((t) => overlaps(m, t)))) continue;
      if (search(i + 1, taken.concat(opt.meetings))) return true;
    }
    return false;
  };
  return search(0, []);
}

/**
 * When no schedule exists, find a smallest group of mandatory courses that can never be
 * taken together (deletion filter: drop each course in turn, keep it out if the rest still
 * clash). Returns their names, or [] if the mandatory courses do fit.
 */
export function findConflict(courses) {
  let group = courses.filter((c) => c.mandatory);
  if (mandatoryFit(group)) return [];
  for (const c of [...group]) {
    const without = group.filter((x) => x !== c);
    if (!mandatoryFit(without)) group = without;
  }
  return group.map((c) => c.name);
}

// ---------------------------------------------------------------- output

/** Every meeting of a schedule, sorted by day and start time. */
export function scheduleSlots(chosen) {
  const rows = [];
  for (const o of chosen) for (const m of o.meetings) rows.push([m, o]);
  return rows.sort((a, b) => a[0].day - b[0].day || a[0].start - b[0].start);
}

export function scheduleToDict(rank, score, chosen, scorer) {
  return {
    rank,
    score,
    breakdown: scorer.breakdown(chosen),
    choices: chosen.map((o) => ({ course: o.course, option: o.name })),
    slots: scheduleSlots(chosen).map(([m, o]) => ({
      course: o.course,
      option: o.name,
      day: DAYS[m.day],
      day_index: m.day,
      start: toHHMM(m.start),
      end: toHHMM(m.end),
      weeks: weeksName(m.weeks),
    })),
  };
}

/** Solve already-loaded courses. Used by the web app after the user's own edits. */
export function optimizeCourses(courses, weights, settings, top = 3, onProgress) {
  const scorer = new Scorer(weights, settings, courses.filter((c) => !c.mandatory).map((c) => c.name));
  const results = solve(courses, scorer, top, onProgress);
  return results.map(([s, c], i) => scheduleToDict(i + 1, s, c, scorer));
}

/**
 * Parsed JSON documents in, JSON-ready result out. Also what `node cli.mjs --json` prints:
 * { schedules: [{rank, score, breakdown, choices, slots}], warnings: [string], weights, settings }
 * An empty `schedules` list means the mandatory courses always clash.
 */
export function optimize(datas, { top = 3, includeRestricted = false, language = "magyar" } = {}) {
  const { courses, weights, settings, warnings } = loadData(datas, { includeRestricted, language });
  return {
    schedules: optimizeCourses(courses, weights, settings, top),
    warnings: warnings.map((w) => w.message),
    weights,
    settings,
  };
}
