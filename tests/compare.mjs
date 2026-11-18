// Runs the JS solver on the given files and prints the result as JSON.
// Usage: node tests/compare.mjs [--top N] [--include-restricted] [--language L] file.json|file.har ...
// Used by tests/compare.py to check that web/js/solver.js matches main.py.
import { readFileSync } from "node:fs";
import { optimize } from "../web/js/solver.js";
import { parseInputFile } from "../web/js/har.js";

const args = process.argv.slice(2);
const opts = { top: 3, includeRestricted: false, language: "magyar" };
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--top") opts.top = Number(args[++i]);
  else if (args[i] === "--include-restricted") opts.includeRestricted = true;
  else if (args[i] === "--language") opts.language = args[++i];
  else files.push(args[i]);
}
const datas = files.map((f) => parseInputFile(f, readFileSync(f, "utf-8")).data);
process.stdout.write(JSON.stringify(optimize(datas, opts)));
