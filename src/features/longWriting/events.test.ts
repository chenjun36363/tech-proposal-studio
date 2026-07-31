import { describe, expect, it } from "vitest";
import { appendLongWritingEvent, createLongWritingEvent, sanitizeLongWritingEventDetails } from "./events";

describe("long-writing events", () => {
  it("removes secret-shaped fields and truncates diagnostic text", () => {
    const safe = sanitizeLongWritingEventDetails({
      apiKey: "should-not-persist",
      Authorization: "Bearer secret",
      model: "deepseek",
      message: "x".repeat(700),
      attempt: 2,
    });
    expect(safe).toEqual({ model: "deepseek", message: "x".repeat(500), attempt: 2 });
  });

  it("keeps only the bounded latest event history", () => {
    const events = Array.from({ length: 4 }, (_, index) => createLongWritingEvent("worker_started", `event-${index}`, { at: `2026-07-31T00:00:0${index}.000Z` }));
    expect(appendLongWritingEvent(events.slice(0, 3), events[3], 3).map(event => event.message)).toEqual(["event-1", "event-2", "event-3"]);
  });
});
