// Command-line front end for web/js/solver.js: same solver as the web app, results in the terminal.
//
// Usage: node cli.mjs [--top N] [--include-restricted] [--language L] [--json] file ...
// Files can be our own format (see example.json), Neptun responses, a list of them (like tests/fixtures/neptun.json) or a Neptun .har.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { findConflict, loadData, optimize } from "./web/js/solver.js";
import { parseInputFile } from "./web/js/har.js";

const HELP = `Find the best uni timetable.

Usage: node cli.mjs [options] file ...

Files: our own format (see example.json), Neptun course lists or a Neptun .har file.

Options:
  --top N               how many schedules to show (default: 3)
  --include-restricted  keep Neptun sections with a sign-up requirement (IMSc groups are never kept)
  --language L          only keep Neptun sections taught in this language (default: magyar)
  --json                print the result as JSON (the same shape the web app uses)
  -h, --help            show this help`;

const { values: args, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    top: { type: "string", default: "3" },
    "include-restricted": { type: "boolean", default: false },
    language: { type: "string", default: "magyar" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (args.help || files.length === 0) {
  console.log(HELP);
  process.exit(args.help ? 0 : 1);
}

const datas = files.map((f) => parseInputFile(f, readFileSync(f, "utf-8")).data);
const opts = { includeRestricted: args["include-restricted"], language: args.language };
const result = optimize(datas, { ...opts, top: Number(args.top) });

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

for (const w of result.warnings) console.error(w);
if (result.schedules.length === 0) {
  console.log("No valid schedule: the mandatory courses always clash.");
  const conflict = findConflict(loadData(datas, opts).courses);
  if (conflict.length) console.log(`These can never be taken together: ${conflict.join(", ")}`);
  process.exit(0);
}
for (const { rank, score, breakdown: b, slots } of result.schedules) {
  console.log(
    `#${rank}  score ${Math.round(score)}  |  ${b.days} days, ${b.early} early, ` +
      `${b.gap_hours.toFixed(1)}h gaps, ${b.late} late, ${b.optional_missing} optional skipped`,
  );
  let day = null;
  for (const s of slots) {
    if (s.day !== day) console.log(`  ${(day = s.day)}`);
    const weeks = s.weeks === "every" ? "" : ` [${s.weeks} weeks]`;
    console.log(`    ${s.start}-${s.end}${weeks}  ${s.course} (${s.option})`);
  }
  console.log();
}
