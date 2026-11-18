// Reading the files the user drops in — browser port of har2json.py.
//
// A Neptun .har file contains every request the browser made, including the
// user's session cookies and tokens. We only ever read it here, in the browser:
// it is never uploaded anywhere. Only the GetSubjectsCourses responses are kept.

/** Decode a HAR response body (plain text or base64-encoded UTF-8). */
function responseText(content) {
  const text = content?.text;
  if (!text) return null;
  if (content.encoding !== "base64") return text;
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Pull every GetSubjectsCourses response out of a parsed HAR, once per subject
 * (if a subject was opened several times, the last response wins).
 * Returns { subjects: [{subjectId, data}], skipped } — `subjects` is the same
 * list that har2json.py writes to targyak.json.
 */
export function extractFromHar(har) {
  const bySubject = new Map();
  let skipped = 0;
  for (const entry of har?.log?.entries ?? []) {
    const url = entry.request?.url ?? "";
    if (!url.includes("GetSubjectsCourses")) continue;
    const text = responseText(entry.response?.content);
    if (!text || entry.response?.status !== 200) {
      skipped++;
      continue;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      skipped++;
      continue;
    }
    let subjectId = url;
    try {
      subjectId = new URL(url).searchParams.get("subjectId") ?? url;
    } catch {
      /* keep the raw URL as the key */
    }
    bySubject.set(subjectId, { subjectId, data });
  }
  return { subjects: [...bySubject.values()], skipped };
}

/**
 * Turn one dropped file into a document solver.loadData() understands.
 * Returns { kind, data, label } where kind is "har" | "subjects" | "neptun" | "native".
 * Throws an Error with a Hungarian message if the file can't be used.
 */
export function parseInputFile(fileName, text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${fileName}: nem érvényes JSON / HAR fájl.`);
  }

  if (json?.log?.entries) {
    const { subjects, skipped } = extractFromHar(json);
    if (subjects.length === 0) {
      throw new Error(
        `${fileName}: nem találtam benne tárgyadatot (GetSubjectsCourses kérést). ` +
          "Be volt kapcsolva a Preserve log, és lenyitottad a tárgyakat a mentés előtt?",
      );
    }
    const extra = skipped ? `, ${skipped} hibás kérés kihagyva` : "";
    return { kind: "har", data: subjects, label: `${subjects.length} tárgy${extra}` };
  }
  if (Array.isArray(json)) {
    if (!json.every((s) => Array.isArray(s?.data?.data))) {
      throw new Error(`${fileName}: ismeretlen lista formátum.`);
    }
    return { kind: "subjects", data: json, label: `${json.length} tárgy` };
  }
  if (Array.isArray(json?.data)) {
    return { kind: "neptun", data: json, label: "1 tárgy (Neptun válasz)" };
  }
  if (Array.isArray(json?.courses)) {
    return { kind: "native", data: json, label: `${json.courses.length} kurzus (saját formátum)` };
  }
  throw new Error(`${fileName}: nem ismerem fel a formátumát.`);
}
