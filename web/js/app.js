// Page logic: files in, preferences, per-course tweaks, results out.
// The search itself runs in worker.js (solver.js); this file only does the UI.
import { loadData, DEFAULT_WEIGHTS, DEFAULT_SETTINGS, EVERY_WEEK, ODD, toHHMM } from "./solver.js";
import { parseInputFile } from "./har.js";

const DAY_LABELS = ["Hétfő", "Kedd", "Szerda", "Csütörtök", "Péntek", "Szombat", "Vasárnap"];
const DAY_SHORT = ["H", "K", "Sze", "Cs", "P", "Szo", "V"];
const WEEK_LABEL = { odd: "páratlan hét", even: "páros hét" };
const DEFAULT_PREFS = { ...DEFAULT_WEIGHTS, ...DEFAULT_SETTINGS, top: 3, language: "magyar", include_restricted: false };
const PREFS_KEY = "orarend.prefs.v1";

const state = {
  files: [], // { id, name, label, data }
  overrides: new Map(), // course name -> { mandatory?: boolean, excluded: boolean, disabled: Set<section code> }
  openCourses: new Set(), // course names whose section list is expanded
  loaded: null, // last loadData() result
  worker: null,
  nextId: 1,
  hasResults: false,
};

const $ = (id) => document.getElementById(id);
const fmt = (x) => x.toLocaleString("hu-HU", { maximumFractionDigits: 1 });

/** Tiny DOM builder. Text children are inserted as text, never as HTML. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) node.style.setProperty(sk, sv);
        else node.style[sk] = sv;
      }
    } else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (typeof v === "boolean") node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

/**
 * One accent colour per subject (a subject's lecture and lab share it), taken from the
 * design system's icon palette and used only for small marks: dots and the edge of a block.
 * Subjects get colours in the order they were loaded, so the first nine are all different.
 */
const PALETTE = ["blue", "orange", "purple", "green", "pink", "teal", "indigo", "red", "gray"];
const subjectColors = new Map();
const subjectOf = (courseName) => courseName.replace(/\s+\S+$/, "") || courseName;
function colorOf(courseName) {
  const subject = subjectOf(courseName);
  if (!subjectColors.has(subject)) subjectColors.set(subject, PALETTE[subjectColors.size % PALETTE.length]);
  return `var(--icon-${subjectColors.get(subject)})`;
}

function formatMeeting(m) {
  const weeks = m.weeks === EVERY_WEEK ? "" : m.weeks & (1 << ODD) ? " (ptl.)" : " (ps.)";
  return `${DAY_SHORT[m.day]} ${toHHMM(m.start)}–${toHHMM(m.end)}${weeks}`;
}

// ---------------------------------------------------------------- preferences

const form = $("prefs");

function readPrefs() {
  const p = {};
  for (const [key, def] of Object.entries(DEFAULT_PREFS)) {
    const input = form.elements[key];
    if (typeof def === "boolean") p[key] = input.checked;
    else if (typeof def === "number") {
      const n = Number(input.value);
      p[key] = input.value === "" || !Number.isFinite(n) ? def : n;
    } else p[key] = input.value.trim() || def;
  }
  p.top = Math.min(50, Math.max(1, Math.round(p.top)));
  return p;
}

function writePrefs(p) {
  for (const [key, def] of Object.entries(DEFAULT_PREFS)) {
    const input = form.elements[key];
    const v = p[key] ?? def;
    if (typeof def === "boolean") input.checked = Boolean(v);
    else input.value = v;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(readPrefs()));
  } catch {
    /* storage unavailable: preferences just won't be remembered */
  }
}

function restorePrefs() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") ?? {};
  } catch {
    saved = {};
  }
  writePrefs({ ...DEFAULT_PREFS, ...saved });
}

form.addEventListener("submit", (e) => e.preventDefault());
form.addEventListener("change", (e) => {
  savePrefs();
  if (e.target.name === "language" || e.target.name === "include_restricted") refreshCourses();
  markStale();
});
$("reset-prefs").addEventListener("click", () => {
  writePrefs(DEFAULT_PREFS);
  savePrefs();
  refreshCourses();
  markStale();
});

// ---------------------------------------------------------------- files

async function handleFiles(fileList) {
  const errors = [];
  let added = 0;
  for (const file of fileList) {
    try {
      const parsed = parseInputFile(file.name, await file.text());
      state.files.push({ id: state.nextId++, name: file.name, label: parsed.label, data: parsed.data });
      added++;
      if (parsed.kind === "native") {
        // Our own format may carry weights/settings: put them into the form.
        writePrefs({ ...readPrefs(), ...(parsed.data.weights ?? {}), ...(parsed.data.settings ?? {}) });
        savePrefs();
      }
    } catch (err) {
      errors.push(err.message);
    }
  }
  const box = $("file-error");
  box.hidden = errors.length === 0;
  box.textContent = errors.join("\n");
  renderFiles();
  refreshCourses();
  if (added) run({ reveal: true });
}

function renderFiles() {
  const list = $("file-list");
  list.hidden = state.files.length === 0;
  list.replaceChildren(
    ...state.files.map((f) =>
      el(
        "li",
        { class: "file-row" },
        el("span", { class: "name", title: f.name }, f.name),
        el("span", { class: "meta" }, f.label),
        el(
          "button",
          {
            type: "button",
            class: "icon-button",
            title: "Eltávolítás",
            "aria-label": `${f.name} eltávolítása`,
            onclick: () => {
              state.files = state.files.filter((x) => x.id !== f.id);
              renderFiles();
              refreshCourses();
              markStale();
            },
          },
          "✕",
        ),
      ),
    ),
  );
}

const dropzone = $("dropzone");
const fileInput = $("file-input");
fileInput.addEventListener("change", () => {
  handleFiles([...fileInput.files]);
  fileInput.value = "";
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("over");
  handleFiles([...e.dataTransfer.files]);
});
// A file dropped next to the drop zone should not navigate away from the page.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---------------------------------------------------------------- courses

function override(name) {
  if (!state.overrides.has(name)) state.overrides.set(name, { excluded: false, disabled: new Set() });
  return state.overrides.get(name);
}

function refreshCourses() {
  const prefs = readPrefs();
  state.loaded = state.files.length
    ? loadData(state.files.map((f) => f.data), { includeRestricted: prefs.include_restricted, language: prefs.language })
    : null;
  renderCourses();
}

function renderCourses() {
  const courses = state.loaded?.courses ?? [];
  $("courses-hint").textContent = courses.length
    ? "Döntsd el tárgyanként, kötelező-e, és nyisd le, ha csak bizonyos kurzusai jöhetnek szóba."
    : "Az export betöltése után itt jelennek meg.";
  $("run").disabled = courses.length === 0;

  subjectColors.clear();
  const list = $("course-list");
  list.hidden = courses.length === 0;
  list.replaceChildren(...courses.map(courseItem));

  const skipped = (state.loaded?.warnings ?? []).filter((w) => w.kind !== "empty");
  $("skipped").hidden = skipped.length === 0;
  $("skipped-summary").textContent = `${skipped.length} kurzus kiszűrve`;
  $("skipped-list").replaceChildren(
    ...skipped.map((w) => {
      const why =
        w.kind === "language" ? `nyelv: ${w.detail ?? "?"}` : w.kind === "imsc" ? "IMSc csoport" : `feltétel: ${w.detail}`;
      return el("li", {}, `${w.course} (${w.code}) · ${why}`);
    }),
  );
}

const MODES = [
  ["mandatory", "Kötelező"],
  ["optional", "Választható"],
  ["excluded", "Kihagyom"],
];
let modeGroup = 0;

function courseItem(c) {
  const ov = override(c.name);
  const mandatory = ov.mandatory ?? c.mandatory;
  const mode = ov.excluded ? "excluded" : mandatory ? "mandatory" : "optional";
  const allowed = c.options.filter((o) => !ov.disabled.has(o.name)).length;
  const problem = !ov.excluded && allowed === 0;
  const changed = () => {
    renderCourses();
    markStale();
  };
  const group = `mode-${modeGroup++}`;

  const segmented = el(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": `${c.name}: felvétel módja` },
    MODES.map(([value, label]) =>
      el(
        "label",
        {},
        el("input", {
          type: "radio",
          name: group,
          value,
          checked: mode === value,
          onchange: () => {
            ov.excluded = value === "excluded";
            if (value !== "excluded") ov.mandatory = value === "mandatory";
            changed();
          },
        }),
        el("span", {}, label),
      ),
    ),
  );

  const sections = el(
    "details",
    {
      class: "disclosure",
      open: state.openCourses.has(c.name),
      ontoggle: (e) => (e.target.open ? state.openCourses.add(c.name) : state.openCourses.delete(c.name)),
    },
    el("summary", {}, allowed === c.options.length ? `${c.options.length} kurzus` : `${allowed} / ${c.options.length} kurzus`),
    el(
      "ul",
      { class: "sections" },
      [...c.options]
        .sort((x, y) => x.name.localeCompare(y.name, "hu", { numeric: true }))
        .map((o) =>
          el(
            "li",
            {},
            el(
              "label",
              {},
              el("input", {
                type: "checkbox",
                checked: !ov.disabled.has(o.name),
                onchange: (e) => {
                  if (e.target.checked) ov.disabled.delete(o.name);
                  else ov.disabled.add(o.name);
                  changed();
                },
              }),
              el("span", { class: "code" }, o.name),
              el("span", { class: "times" }, o.meetings.map(formatMeeting).join(", ")),
            ),
          ),
        ),
    ),
  );

  return el(
    "li",
    { class: `course${ov.excluded ? " excluded" : ""}` },
    el(
      "div",
      { class: "course-head" },
      el("span", { class: "dot", style: { "--c": colorOf(c.name) } }),
      el("span", { class: "course-name" }, c.name),
    ),
    segmented,
    !ov.excluded && c.options.length > 0 && sections,
    problem &&
      el(
        "p",
        { class: "problem-text" },
        mandatory ? "Nincs engedélyezett kurzusa, így nem lesz órarend." : "Nincs engedélyezett kurzusa, kimarad.",
      ),
  );
}

/** Courses as the solver should see them, after the user's tweaks. */
function solverCourses() {
  return (state.loaded?.courses ?? [])
    .filter((c) => !override(c.name).excluded)
    .map((c) => {
      const ov = override(c.name);
      return {
        name: c.name,
        mandatory: ov.mandatory ?? c.mandatory,
        options: c.options.filter((o) => !ov.disabled.has(o.name)),
      };
    });
}

// ---------------------------------------------------------------- search

const status = (text) => ($("status").textContent = text);

function markStale() {
  if (state.hasResults && !state.worker) status("Változtattál valamin, keress újra.");
}

function stopWorker() {
  state.worker?.terminate();
  state.worker = null;
  $("cancel").hidden = true;
}

function run({ reveal = false } = {}) {
  stopWorker();
  const courses = solverCourses();
  if (courses.length === 0) return;
  const blocked = courses.filter((c) => c.mandatory && c.options.length === 0).map((c) => c.name);
  if (blocked.length) {
    showMessage(`Ezeknek a kötelező tárgyaknak nincs választható kurzusa: ${blocked.join(", ")}.`);
    status("");
    return;
  }

  const prefs = readPrefs();
  const weights = Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, prefs[k]]));
  const settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, prefs[k]]));
  const hasOptional = courses.some((c) => !c.mandatory);

  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  state.worker = worker;
  $("cancel").hidden = false;
  status("Keresés…");
  const t0 = performance.now();

  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      status(`Keresés… ${data.nodes.toLocaleString("hu-HU")} állapot`);
      return;
    }
    stopWorker();
    if (data.type === "error") {
      status("");
      showMessage(`Hiba a számítás közben: ${data.message}`);
      return;
    }
    const ms = Math.round(performance.now() - t0);
    status(`${data.schedules.length} órarend · ${ms < 1000 ? `${ms} ms` : `${fmt(ms / 1000)} s`}`);
    renderResults(data.schedules, hasOptional);
    // In the one-column layout the results sit below a long sidebar: bring them into view.
    if (reveal && matchMedia("(max-width: 1024px)").matches) {
      $("results-title").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };
  worker.onerror = (e) => {
    e.preventDefault();
    stopWorker();
    status("");
    showMessage(
      location.protocol === "file:"
        ? "Az oldalt webszerverről kell megnyitni, nem fájlként. Helyben: a web mappában futtasd a `python -m http.server` parancsot, majd nyisd meg a http://localhost:8000 címet."
        : `Nem sikerült elindítani a számítást (${e.message || "ismeretlen hiba"}). Próbáld frissebb böngészőben.`,
    );
  };
  worker.postMessage({ courses, weights, settings, top: prefs.top });
}

$("run").addEventListener("click", () => run());
$("cancel").addEventListener("click", () => {
  stopWorker();
  status("Leállítva.");
});

// ---------------------------------------------------------------- results

function showMessage(text, title = "Nincs eredmény") {
  state.hasResults = false;
  $("results").replaceChildren(el("div", { class: "empty" }, el("h3", {}, title), el("p", {}, text)));
}

function renderResults(schedules, hasOptional) {
  if (schedules.length === 0) {
    showMessage(
      "A kötelező tárgyak minden kombinációban ütköznek. Jelölj néhányat választhatónak, vagy engedélyezz több kurzust.",
      "Nincs érvényes órarend",
    );
    return;
  }
  state.hasResults = true;
  $("results").replaceChildren(...schedules.map((s) => scheduleCard(s, hasOptional)));
}

function scheduleCard(s, hasOptional) {
  const b = s.breakdown;
  const facts = [
    `${fmt(b.days)} nap`,
    `${fmt(b.early)} korai`,
    `${fmt(b.gap_hours)} óra lyuk`,
    `${fmt(b.late)} késői`,
    hasOptional && `${b.optional_missing} kihagyott`,
  ].filter(Boolean);

  const choices = [...s.choices].sort((x, y) => x.course.localeCompare(y.course, "hu"));
  return el(
    "article",
    { class: "schedule", "aria-label": `${s.rank}. órarend` },
    el(
      "div",
      { class: "schedule-head" },
      el("span", { class: "rank" }, `${s.rank}.`),
      el("span", { class: "score" }, fmt(s.score), el("small", {}, " pont")),
      el("span", { class: "facts" }, facts.map((f) => el("span", { class: "fact" }, f))),
    ),
    el("div", { class: "week-scroll" }, weekGrid(s.slots)),
    el(
      "details",
      { class: "disclosure choices" },
      el("summary", {}, "Felveendő kurzusok"),
      el(
        "ul",
        { class: "group" },
        choices.map((c) =>
          el(
            "li",
            { class: "choice-row" },
            el(
              "span",
              { class: "course-cell" },
              el("span", { class: "dot", style: { "--c": colorOf(c.course) } }),
              el("span", {}, c.course),
            ),
            el("span", { class: "option-cell" }, c.option, c.option.includes(", ") ? el("small", {}, "bármelyik") : null),
          ),
        ),
      ),
    ),
  );
}

function weekGrid(slots) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const days = [0, 1, 2, 3, 4];
  for (const d of [5, 6]) if (slots.some((x) => x.day_index === d)) days.push(d);
  const h0 = Math.min(8, Math.floor(Math.min(...slots.map((x) => toMin(x.start))) / 60));
  const h1 = Math.max(18, Math.ceil(Math.max(...slots.map((x) => toMin(x.end))) / 60));
  const at = (minutes) => `calc(${(minutes - h0 * 60) / 60} * var(--hour))`;

  const gutter = el("div", { class: "gutter" });
  for (let h = h0 + 1; h < h1; h++) gutter.append(el("span", { style: { top: at(h * 60) } }, `${h}:00`));

  const columns = days.map((d) =>
    el(
      "div",
      { class: "col" },
      slots
        .filter((x) => x.day_index === d)
        .map((x) => {
          const start = toMin(x.start);
          const end = toMin(x.end);
          const weekText = WEEK_LABEL[x.weeks];
          return el(
            "div",
            {
              class: `block ${x.weeks}`,
              style: {
                "--c": colorOf(x.course),
                top: at(start),
                height: `calc(${(end - start) / 60} * var(--hour) - 2px)`,
              },
              title: `${x.course}\n${x.option}\n${DAY_LABELS[d]} ${x.start}–${x.end}${weekText ? `, ${weekText}` : ""}`,
            },
            el("span", { class: "c" }, x.course),
            el("span", { class: "t" }, `${x.start}–${x.end}`),
            el("span", { class: "o" }, x.option, weekText ? ` · ${weekText}` : ""),
          );
        }),
    ),
  );

  return el(
    "div",
    { class: "week", style: { "--days": String(days.length), "--hours": String(h1 - h0) } },
    el("div"),
    days.map((d) => el("div", { class: "dayname" }, DAY_LABELS[d])),
    gutter,
    columns,
  );
}

// ---------------------------------------------------------------- start

restorePrefs();
renderFiles();
refreshCourses();
