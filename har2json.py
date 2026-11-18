"""
Neptun HAR -> targyak.json

Használat:
    python har2json.py neptun.har
    python har2json.py neptun.har kimenet.json

A HAR-ból kigyűjti az összes GetSubjectsCourses választ,
tárgyanként egyszer (ha többször kattintottál ugyanarra, a legutolsót tartja meg).
"""

import base64
import json
import sys
from urllib.parse import urlparse, parse_qs


def main():
    if len(sys.argv) < 2:
        print("Használat: python har2json.py <fajl.har> [kimenet.json]")
        sys.exit(1)

    har_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else "targyak.json"

    with open(har_path, encoding="utf-8") as f:
        har = json.load(f)

    by_subject = {}
    skipped = 0

    for entry in har["log"]["entries"]:
        url = entry["request"]["url"]
        if "GetSubjectsCourses" not in url:
            continue

        content = entry["response"].get("content", {})
        text = content.get("text")
        if not text or entry["response"].get("status") != 200:
            skipped += 1
            continue
        if content.get("encoding") == "base64":
            text = base64.b64decode(text).decode("utf-8")

        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            skipped += 1
            continue

        subject_id = parse_qs(urlparse(url).query).get("subjectId", [url])[0]
        by_subject[subject_id] = {"subjectId": subject_id, "data": data}

    result = list(by_subject.values())
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"{len(result)} tárgy mentve ide: {out_path}")
    if skipped:
        print(f"{skipped} kérés kihagyva (üres válasz vagy hiba)")
    if not result:
        print("Nem találtam GetSubjectsCourses választ. Be volt kapcsolva a Preserve log, "
              "és rákattintottál a tárgyakra a mentés előtt?")


if __name__ == "__main__":
    main()