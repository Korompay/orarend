// Runs the search off the main thread, so the page stays responsive and the
// search can be cancelled (the page simply terminates this worker).
import { optimizeCourses, findConflict } from "./solver.js";

self.onmessage = ({ data }) => {
  const { courses, weights, settings, top } = data;
  try {
    const schedules = optimizeCourses(courses, weights, settings, top, (nodes) =>
      self.postMessage({ type: "progress", nodes }),
    );
    // No schedule: work out which mandatory courses can't be taken together.
    const conflict = schedules.length ? [] : findConflict(courses);
    self.postMessage({ type: "done", schedules, conflict });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message ?? err) });
  }
};
