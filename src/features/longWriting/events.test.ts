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

  it("records model changes without storing connection secrets", () => {
    const event = createLongWritingEvent("model_changed", "执行模型已切换", {
      details: { providerId: "provider-1", model: "gpt-5.2", apiKey: "must-not-persist" },
    });
    expect(event).toMatchObject({ type: "model_changed", details: { providerId: "provider-1", model: "gpt-5.2" } });
    expect(event.details).not.toHaveProperty("apiKey");
  });

  it("keeps only the bounded latest event history", () => {
    const events = Array.from({ length: 4 }, (_, index) => createLongWritingEvent("worker_started", `event-${index}`, { at: `2026-07-31T00:00:0${index}.000Z` }));
    expect(appendLongWritingEvent(events.slice(0, 3), events[3], 3).map(event => event.message)).toEqual(["event-1", "event-2", "event-3"]);
  });
});
