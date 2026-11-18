"""Uni schedule optimizer.

Picks one option (section) for every course so that nothing overlaps,
every mandatory course is included, and the weighted "badness" score
(days on campus, 8 am starts, gaps, late finishes ...) is as low as possible.

Usage:
    python main.py courses.json            # show the 3 best schedules
    python main.py courses.json --top 10
    python main.py settings.json adatb.json szoftlab.json   # mix with Neptun exports
"""

import argparse
import heapq
import itertools
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
EVEN, ODD = 0, 1
EVERY_WEEK = frozenset({EVEN, ODD})
WEEK_NAMES = {"even": frozenset({EVEN}), "odd": frozenset({ODD}), "every": EVERY_WEEK}

DEFAULT_WEIGHTS = {
    "day": 100,           # per day you have to go in
    "early": 30,          # per class starting before `early_before`
    "gap_hour": 10,       # per hour of idle time between classes on the same day
    "late": 15,           # per class ending after `late_after`
    "optional_missing": 40,  # per optional course left out
}
DEFAULT_SETTINGS = {"early_before": "09:00", "late_after": "18:00"}


def to_minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


@dataclass(frozen=True)
class Meeting:
    day: int
    start: int  # minutes since midnight
    end: int
    weeks: frozenset[int] = EVERY_WEEK  # week parities (ISO week number % 2) it meets in

    def overlaps(self, other: "Meeting") -> bool:
        return (self.day == other.day and self.start < other.end and other.start < self.end
                and bool(self.weeks & other.weeks))

    def __str__(self) -> str:
        s = f"{DAYS[self.day]} {self.start // 60:02d}:{self.start % 60:02d}-{self.end // 60:02d}:{self.end % 60:02d}"
        if self.weeks != EVERY_WEEK:
            s += " [odd weeks]" if ODD in self.weeks else " [even weeks]"
        return s


@dataclass(frozen=True)
class Option:
    course: str
    name: str
    meetings: tuple[Meeting, ...]


@dataclass
class Course:
    name: str
    mandatory: bool
    options: list[Option] = field(default_factory=list)


def load_native(data: dict) -> list[Course]:
    courses = []
    for c in data.get("courses", []):
        options = []
        for o in c["options"]:
            meetings = tuple(
                Meeting(DAYS.index(m["day"]), to_minutes(m["start"]), to_minutes(m["end"]),
                        WEEK_NAMES[m.get("weeks", "every")])
                for m in o["meetings"]
            )
            options.append(Option(c["name"], o["name"], meetings))
        courses.append(Course(c["name"], c.get("mandatory", True), options))
    return courses


def neptun_meeting(info: dict, dates: list[dict]) -> Meeting:
    """One weekly slot of a Neptun section; its week parity comes from the actual dates."""
    weeks = set()
    for d in dates:
        t = datetime.fromisoformat(d["fromTime"])
        if t.isoweekday() == info["dayOfWeek"] and t.strftime("%H:%M") == info["startTime"]:
            weeks.add(t.isocalendar().week % 2)
    return Meeting(info["dayOfWeek"] - 1, to_minutes(info["startTime"]), to_minutes(info["endTime"]),
                   frozenset(weeks) or EVERY_WEEK)


def load_neptun(data: dict, include_restricted: bool, language: str) -> list[Course]:
    """Neptun course list: each subject + type (lecture, practice, lab ...) becomes one course."""
    courses: dict[tuple[str, str], Course] = {}
    for s in data["data"]:
        if not s["classInstanceInfos"]:
            continue  # no classes, e.g. a Vizsgakurzus (exam-only course)
        name = f"{s['title']} {s['type'].lower()}"
        course = courses.setdefault((s["subjectId"], s["type"]), Course(name, True))
        requirement = " ".join((s.get("signinRequirementText") or "").split())
        if s.get("language") != language:
            reason = f"taught in {s.get('language')}"
        elif "IMSC" in requirement.upper():
            reason = "IMSc group"
        # A section you are already signed up for is kept despite other restrictions.
        elif requirement and not s.get("isSigned") and not include_restricted:
            reason = f"restricted, {requirement}"
        else:
            reason = None
        if reason:
            print(f"skipping {name} ({s['code']}): {reason}", file=sys.stderr)
            continue
        # dict.fromkeys drops slots listed twice (same time, different room).
        meetings = tuple(dict.fromkeys(
            neptun_meeting(i, s["classInstanceTimeTableList"]) for i in s["classInstanceInfos"]))
        course.options.append(Option(name, s["code"], meetings))
    return list(courses.values())


def load(paths: list[str], include_restricted: bool = False, language: str = "magyar") -> tuple[list[Course], dict, dict]:
    courses: list[Course] = []
    weights, settings = dict(DEFAULT_WEIGHTS), dict(DEFAULT_SETTINGS)
    for path in paths:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):  # har2json.py output: [{"subjectId": ..., "data": <Neptun response>}, ...]
            for subject in data:
                courses += load_neptun(subject["data"], include_restricted, language)
        elif isinstance(data.get("data"), list):
            courses += load_neptun(data, include_restricted, language)
        else:
            courses += load_native(data)
            weights.update(data.get("weights", {}))
            settings.update(data.get("settings", {}))
    for c in courses:
        if not c.options:
            print(f"warning: {c.name} has no available section", file=sys.stderr)
    return courses, weights, settings


class Scorer:
    def __init__(self, weights: dict, settings: dict, n_optional: int):
        self.w = weights
        self.early_before = to_minutes(settings["early_before"])
        self.late_after = to_minutes(settings["late_after"])
        self.n_optional = n_optional

    def breakdown(self, chosen: list[Option]) -> dict:
        """Penalty counts for an average week (mean of an even and an odd week)."""
        days = early = late = gap_minutes = 0
        for week in (EVEN, ODD):
            meetings = [m for o in chosen for m in o.meetings if week in m.weeks]
            by_day: dict[int, list[Meeting]] = {}
            for m in meetings:
                by_day.setdefault(m.day, []).append(m)
            for day_meetings in by_day.values():
                day_meetings.sort(key=lambda m: m.start)
                for a, b in itertools.pairwise(day_meetings):
                    gap_minutes += max(0, b.start - a.end)
            days += len(by_day)
            early += sum(1 for m in meetings if m.start < self.early_before)
            late += sum(1 for m in meetings if m.end > self.late_after)
        n_optional_taken = sum(1 for o in chosen if o.course in self.optional_names)
        return {
            "days": days / 2,
            "early": early / 2,
            "gap_hours": gap_minutes / 120,
            "late": late / 2,
            "optional_missing": self.n_optional - n_optional_taken,
        }

    def score(self, chosen: list[Option]) -> float:
        b = self.breakdown(chosen)
        return (
            b["days"] * self.w["day"]
            + b["early"] * self.w["early"]
            + b["gap_hours"] * self.w["gap_hour"]
            + b["late"] * self.w["late"]
            + b["optional_missing"] * self.w["optional_missing"]
        )

    def lower_bound(self, chosen: list[Option], optional_left: int) -> float:
        """Cost that can only grow as more options are added (used for pruning).

        Gaps are excluded because filling a gap can shrink it, and courses
        not yet decided might still be taken, so they are not counted missing.
        """
        b = self.breakdown(chosen)
        return (
            b["days"] * self.w["day"]
            + b["early"] * self.w["early"]
            + b["late"] * self.w["late"]
            + (b["optional_missing"] - optional_left) * self.w["optional_missing"]
        )


def merge_same_time(course: Course) -> Course:
    """Sections meeting at exactly the same times are interchangeable: search them once."""
    groups: dict[frozenset[Meeting], list[Option]] = {}
    for o in course.options:
        groups.setdefault(frozenset(o.meetings), []).append(o)
    options = [Option(course.name, ", ".join(o.name for o in g), g[0].meetings) for g in groups.values()]
    return Course(course.name, course.mandatory, options)


def solve(courses: list[Course], scorer: Scorer, top: int) -> list[tuple[float, list[Option]]]:
    courses = [merge_same_time(c) for c in courses]
    # Most constrained first: fewer options -> earlier failures -> faster search.
    order = sorted(courses, key=lambda c: (not c.mandatory, len(c.options)))
    scorer.optional_names = {c.name for c in courses if not c.mandatory}
    optional_after = [sum(1 for c in order[i:] if not c.mandatory) for i in range(len(order) + 1)]

    best: list[tuple[float, int, list[Option]]] = []  # max-heap via negated score
    counter = itertools.count()

    def worst_kept() -> float:
        return -best[0][0] if len(best) >= top else float("inf")

    def search(i: int, chosen: list[Option], taken: list[Meeting]) -> None:
        if scorer.lower_bound(chosen, optional_after[i]) > worst_kept():
            return
        if i == len(order):
            s = scorer.score(chosen)
            if s < worst_kept():
                heapq.heappush(best, (-s, next(counter), list(chosen)))
                if len(best) > top:
                    heapq.heappop(best)
            return
        course = order[i]
        for opt in course.options:
            if any(m.overlaps(t) for m in opt.meetings for t in taken):
                continue
            chosen.append(opt)
            search(i + 1, chosen, taken + list(opt.meetings))
            chosen.pop()
        if not course.mandatory:
            search(i + 1, chosen, taken)

    search(0, [], [])
    return sorted(((-s, c) for s, _, c in best), key=lambda x: x[0])


def print_schedule(rank: int, score: float, chosen: list[Option], scorer: Scorer) -> None:
    b = scorer.breakdown(chosen)
    print(f"#{rank}  score {score:.0f}  |  {b['days']:g} days, {b['early']:g} early, "
          f"{b['gap_hours']:.1f}h gaps, {b['late']:g} late, {b['optional_missing']} optional skipped")
    rows = sorted(((m, o) for o in chosen for m in o.meetings), key=lambda x: (x[0].day, x[0].start))
    for day, group in itertools.groupby(rows, key=lambda x: x[0].day):
        print(f"  {DAYS[day]}")
        for m, o in group:
            print(f"    {str(m)[4:]}  {o.course} ({o.name})")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Find the best uni timetable.")
    parser.add_argument("files", nargs="+",
                        help="JSON files: our own format (see example.json) or Neptun course lists")
    parser.add_argument("--top", type=int, default=3, help="how many schedules to show")
    parser.add_argument("--include-restricted", action="store_true",
                        help="keep Neptun sections with a sign-up requirement (IMSc groups are never kept)")
    parser.add_argument("--language", default="magyar",
                        help="only keep Neptun sections taught in this language (default: magyar)")
    args = parser.parse_args()

    courses, weights, settings = load(args.files, args.include_restricted, args.language)
    scorer = Scorer(weights, settings, sum(1 for c in courses if not c.mandatory))
    results = solve(courses, scorer, args.top)
    if not results:
        print("No valid schedule: the mandatory courses always clash.")
        return
    for rank, (score, chosen) in enumerate(results, 1):
        print_schedule(rank, score, chosen, scorer)


if __name__ == "__main__":
    main()
