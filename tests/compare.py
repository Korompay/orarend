"""Checks that the browser solver (web/js/solver.js) gives exactly the same result as main.py.

Usage (needs Node.js 18+ on PATH):
    python tests/compare.py                      # runs the built-in cases
    python tests/compare.py my.json --top 10     # or your own files and flags

Run it after every change to main.py or solver.js.
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from main import optimize  # noqa: E402

CASES = [
    ["example.json", "--top", "3"],
    ["example.json", "--top", "10"],
    ["targyak.json", "--top", "1"],
    ["targyak.json", "--top", "5"],
    ["targyak.json", "--top", "20", "--include-restricted"],
    ["targyak.json", "--top", "3", "--language", "angol"],
    ["targyak.json", "example.json", "--top", "5"],
]


def python_result(args: list[str]) -> dict:
    top, restricted, language, files = 3, False, "magyar", []
    it = iter(args)
    for a in it:
        if a == "--top":
            top = int(next(it))
        elif a == "--include-restricted":
            restricted = True
        elif a == "--language":
            language = next(it)
        else:
            files.append(a)
    datas = [json.loads((ROOT / f).read_text(encoding="utf-8")) for f in files]
    return optimize(datas, top, restricted, language)


def js_result(args: list[str]) -> dict:
    out = subprocess.run(["node", str(ROOT / "tests" / "compare.mjs"), *args], cwd=ROOT,
                         capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(out.stdout)


def main() -> None:
    cases = [sys.argv[1:]] if len(sys.argv) > 1 else CASES
    failed = 0
    for args in cases:
        py, js = python_result(args), js_result(args)
        ok = py == js
        failed += not ok
        print(f"{'OK  ' if ok else 'DIFF'}  {' '.join(args)}  "
              f"({len(py['schedules'])} schedules, {len(py['warnings'])} warnings)")
        if not ok:
            for key in py:
                if py[key] != js.get(key):
                    print(f"      differs in '{key}'")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
