// Checks web/js/solver.js against saved results in tests/expected/.
//
// Run:                                    npm test
// After a change that is meant to alter results, look over the diff, then save the new results:
//                                         UPDATE=1 npm test
//
// Each tests/expected/*.json holds the command-line arguments of one case and the result
// optimize() gave for them. Add a case by copying a file and changing its "args".
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { optimize } from "../web/js/solver.js";
import { parseInputFile } from "../web/js/har.js";

const ROOT = new URL("../", import.meta.url);
const EXPECTED = new URL("expected/", import.meta.url);

function run(args) {
  const opts = { top: 3, includeRestricted: false, language: "magyar" };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--top") opts.top = Number(args[++i]);
    else if (args[i] === "--include-restricted") opts.includeRestricted = true;
    else if (args[i] === "--language") opts.language = args[++i];
    else files.push(args[i]);
  }
  const datas = files.map((f) => parseInputFile(f, readFileSync(new URL(f, ROOT), "utf-8")).data);
  return optimize(datas, opts);
}

for (const name of readdirSync(EXPECTED).filter((f) => f.endsWith(".json")).sort()) {
  const path = new URL(name, EXPECTED);
  const saved = JSON.parse(readFileSync(path, "utf-8"));
  test(saved.args.join(" "), () => {
    const result = run(saved.args);
    if (process.env.UPDATE) {
      writeFileSync(path, JSON.stringify({ args: saved.args, result }, null, 2) + "\n");
    } else {
      assert.deepEqual(result, saved.result);
    }
  });
}
