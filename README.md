# orarend – uni timetable optimizer

Give it every course you need to take and all the sections (time slots) each course is offered in. It picks one section per course so that:

- nothing overlaps,
- every mandatory course is included,
- the schedule is as comfortable as possible: few days on campus, few early starts, few gaps, few late finishes.

It shows the best few timetables, each with its score.

## Requirements

Node.js 18 or newer for the command line and the tests. There are no other dependencies. The web app only needs a browser.

## Usage

```bash
node cli.mjs example.json            # show the 3 best schedules
node cli.mjs example.json --top 10   # show the 10 best
node cli.mjs settings.json adatb.json szoftlab.json   # several files, incl. Neptun exports
node cli.mjs neptun.har              # a Neptun HAR file works directly
node cli.mjs neptun.har --json      # machine-readable output
```

All files are combined into one problem. `weights` and `settings` are read from files in our own format. Run `node cli.mjs --help` for every option.

Example output:

```
#1  score 270  |  2 days, 1 early, 0.0h gaps, 0 late, 1 optional skipped
  Mon
    08:00-10:00  Calculus lecture (EA1)
    10:00-12:00  Calculus practice (GY1)
    12:00-14:00  Programming (G2)
    14:00-16:00  Physics (P1)
  Wed
    10:00-12:00  Discrete Math (D2)
    12:00-14:00  Programming (G2)
```

If the mandatory courses always clash, it prints `No valid schedule: the mandatory courses always clash.`

`--json` prints the same JSON the web app works with:
`{"schedules": [{"rank", "score", "breakdown", "choices", "slots"}], "warnings", "weights", "settings"}`.

## Web app

`web/` is a static site that does everything in the browser: drop in the Neptun `.har` file (or single Neptun responses, or a file in our own format), set your preferences, and it shows the best timetables as a weekly grid. Nothing is uploaded anywhere. This matters because a `.har` file contains the user's Neptun session.

The easiest way to get the data in is the **Neptun → Órarend** bookmarklet on the page: drag it to the bookmarks bar, click it on Neptun's course sign-up page, open the subjects, then press *Megnyitás* in the small panel. It only watches the page's own `GetSubjectsCourses` responses (no requests of its own, no cookies or tokens) and hands them to the app with `postMessage`, or saves them as `targyak.json` (*Letöltés*). The app accepts these messages only from the Neptun tab that opened it, and only from a host listed in `NEPTUN_HOSTS` in `web/js/bookmarklet.js` (currently `neptun.bme.hu`, over HTTPS); add your university's Neptun host there to use it elsewhere. See [Importing from Neptun](#importing-from-neptun).

Per course you can mark it mandatory or optional, leave it out, or switch off individual sections (e.g. to stay in the same group as a friend). Preferences are remembered in the browser.

Run it locally (ES modules and Web Workers don't work from `file://`):

```bash
npm start                       # then open http://localhost:8000 (another port: node serve.mjs 8080)
```

Deploy to Firebase Hosting (free Spark plan, `firebase.json` already points at `web/`):

```bash
npm install -g firebase-tools
firebase login
firebase use --add               # pick the Firebase project once; writes .firebaserc, leaves firebase.json alone
firebase hosting:channel:deploy teszt   # optional: temporary preview URL (expires in 7 days)
firebase deploy --only hosting   # prints the public URL, e.g. https://<project>.web.app
```

Don't run `firebase init hosting`: `firebase.json` is already set up and init may overwrite it.
To publish a change later, just run `firebase deploy --only hosting` again. Older releases can be rolled back in the Firebase console under Hosting.

| File | Role |
|---|---|
| `web/js/solver.js` | The optimizer: loading, scoring, search |
| `web/js/har.js` | Reads HAR files and detects which kind of input file it got |
| `web/js/bookmarklet.js` | The Neptun bookmarklet (runs inside the Neptun page, so it must stay self-contained) |
| `web/js/worker.js` | Runs the search in a Web Worker so the page stays responsive and can cancel it |
| `web/js/app.js` | UI only: files, preferences, course toggles, result rendering |
| `web/index.html`, `web/style.css` | Page and baseline styles |
| `cli.mjs` | Command-line front end for the same solver |
| `serve.mjs` | Local web server for `web/` (`npm start`) |

## Tests

```bash
npm test
```

`tests/solver.test.mjs` runs the solver on every case in `tests/expected/` and checks that the result is the same as the saved one. Each file there holds the command-line arguments of one case and its expected result.

The input files are [example.json](example.json) (our own format) and [tests/fixtures/neptun.json](tests/fixtures/neptun.json), real Neptun course lists that exercise the Neptun import: language and IMSc filtering, odd/even weeks from the class dates and merging same-time sections.

If you change the solver on purpose (for example a new scoring rule), the tests will fail. Check that the new results are what you wanted, then save them with `UPDATE=1 npm test` and look over the diff in `tests/expected/` before committing.

## Input format

The input is a JSON file. See [example.json](example.json) for a complete example.

```json
{
  "settings": { "early_before": "09:00", "late_after": "18:00" },
  "weights":  { "day": 100, "early": 30, "gap_hour": 10, "late": 15, "optional_missing": 40 },
  "courses": [
    {
      "name": "Programming",
      "mandatory": true,
      "options": [
        { "name": "G1", "meetings": [
          { "day": "Tue", "start": "10:00", "end": "12:00" },
          { "day": "Thu", "start": "10:00", "end": "12:00" } ] },
        { "name": "G2", "meetings": [
          { "day": "Mon", "start": "12:00", "end": "14:00" } ] }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `courses[].name` | Course name |
| `courses[].mandatory` | `true` (default) means the course must be in every schedule. `false` means it can be skipped, at a cost. |
| `courses[].options` | The sections you can choose from. Exactly one is chosen, or none for a skipped optional course. |
| `options[].meetings` | Every time slot of that section. A section can meet several times a week. |
| `day` | `Mon`, `Tue`, `Wed`, `Thu`, `Fri` or `Sat` |
| `start`, `end` | `HH:MM`, 24-hour clock |
| `weeks` | Optional. `odd` or `even` for a class held every other week (by ISO week number). Default: `every`. |
| `settings` | Optional. Sets what counts as "early" and "late". |
| `weights` | Optional. Sets how much each kind of inconvenience costs. Any key you leave out uses its default. |

## Importing from Neptun

On the course sign-up page, open the browser dev tools (Network tab), open a subject's course list, and save the JSON response of the course-list request (the one with a `data` array) to a file. Do this once per subject, then pass all the files to `cli.mjs` or drop them into the web app.

### All subjects at once with the bookmarklet (easiest)

1. On the web app, drag the blue **Neptun → Órarend** button to the bookmarks bar (Ctrl+Shift+B shows the bar).
2. Open Neptun's course sign-up page (**Tárgyfelvétel**) and click the bookmark. A small panel appears in the bottom-right corner.
3. Open each subject you want. The panel lists what it captured.
4. Press **Megnyitás**: the web app opens with the subjects loaded. **Letöltés** saves the same data as `targyak.json`, which works with the web app and `cli.mjs`.

Click the bookmark before opening the subjects: it only sees responses that arrive after it starts. If one was missed, reload the page, click the bookmark again and reopen that subject. The bookmark contains the code as it was when you dragged it, so drag it again after the bookmarklet changes.

### All subjects at once with a HAR file

Instead of saving each response one by one, you can record all of them in a single HAR file:

1. On the course sign-up page, open the dev tools Network tab and turn on **Preserve log** (Chrome) or **Persist Logs** (Firefox), so nothing is lost when the page reloads.
2. Click through every subject you need, so that each one's course list loads.
3. Save the whole log: in Chrome, right-click any request and choose **Save all as HAR with content** (or use the download icon in the Network tab). In Firefox, right-click and choose **Save All As HAR**.

Then drop the HAR file into the web app, or pass it straight to the command line:

```bash
node cli.mjs settings.json neptun.har
```

It collects every `GetSubjectsCourses` response from the HAR file and keeps one per subject. If you opened a subject more than once, the last response is used. It ignores failed or empty responses. If it finds none at all, check that Preserve log was on and that you opened the subjects before saving.

A HAR file contains your Neptun session cookies, so don't share it, and delete it once you're done.

- Every subject + course type (Gyakorlat, Labor, Előadás ...) becomes one mandatory course. The section codes (`G1 páros`, `Li3` ...) are the options.
- Whether a section meets every week, odd weeks or even weeks comes from its real dates (`classInstanceTimeTableList`). So `G1 páros` and `G1 páratlan` at the same time don't clash.
- Only sections taught in `magyar` are kept (change it with `--language`). IMSc groups are always skipped. Sections with any other sign-up requirement are skipped unless you pass `--include-restricted`, but a section you are already signed up for is kept. A message on stderr names each skipped section and why. Full sections are kept.
- Sections that meet at exactly the same times are shown as one option, e.g. `(G1, G2, G3)`.

## How the score works

Lower is better. A schedule's score is the sum of these penalties. Each one is counted for an average week, meaning the mean of an even and an odd week, so biweekly classes count half:

| Penalty | Default weight | Counted |
|---|---|---|
| `day` | 100 | per day with at least one class |
| `early` | 30 | per class starting before `early_before` (default 09:00) |
| `gap_hour` | 10 | per hour of idle time between classes on the same day; the first 30 minutes of each gap are free (time to change rooms) |
| `late` | 15 | per class ending after `late_after` (default 18:00) |
| `optional_missing` | 40 | per optional course left out |

The defaults treat an extra day on campus as the worst thing. To change your priorities, change the weights. For example, set `early` to 200 if you never want 8 am classes.

## How the search works

The search lives in `solve()` in [web/js/solver.js](web/js/solver.js).

1. **Ordering.** Mandatory courses come first. Within each group, courses with fewer options come first, so the search hits clashes early and drops dead ends quickly.
2. **Backtracking.** For each course in turn, it tries each section that doesn't overlap anything already chosen. For an optional course, it also tries skipping it.
3. **Pruning (branch and bound).** It keeps the best `--top` schedules found so far in a heap. Before going deeper, it calculates a lower bound on the score of any schedule that could come out of the current partial one. If that bound is already worse than the worst schedule being kept, the whole branch is skipped.
   - The bound counts days, early classes and late classes, because adding more classes can only raise these. It also counts optional courses that have already been skipped.
   - It leaves out gaps, because a class added later can fill a gap and make it smaller.
4. **Result.** It returns the kept schedules sorted from best to worst, each with a breakdown of what made up its score.

## Code overview

All in [web/js/solver.js](web/js/solver.js):

| Part | Role |
|---|---|
| Meeting, Option, Course | Plain objects: one time slot, one section, one course (shapes at the top of the file) |
| `loadData()` | Reads the parsed input files and fills in the default weights and settings |
| `Scorer` | Computes the penalty breakdown, the total score and the lower bound used for pruning |
| `solve()` | Runs the branch-and-bound search |
| `optimize()` | Parsed JSON in, JSON-ready result out (used by `cli.mjs` and the tests) |
