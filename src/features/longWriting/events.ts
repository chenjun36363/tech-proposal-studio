import type { LongWritingEvent, LongWritingEventDetails, LongWritingEventType } from "./types";

const SECRET_KEY = /api[-_]?key|authorization|credential|cookie|header|password|secret|token/i;
const MAX_DETAIL_LENGTH = 500;
const MAX_EVENTS = 300;

function uid() {
  return `long-writing-event-${Date.now()}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export function sanitizeLongWritingEventDetails(details?: LongWritingEventDetails): LongWritingEventDetails | undefined {
  if (!details) return undefined;
  const safe: LongWritingEventDetails = {};
  for (const [key, value] of Object.entries(details)) {
    if (SECRET_KEY.test(key)) continue;
    if (typeof value === "string") safe[key] = value.slice(0, MAX_DETAIL_LENGTH);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) safe[key] = value;
  }
  return Object.keys(safe).length ? safe : undefined;
}

export function createLongWritingEvent(
  type: LongWritingEventType,
  message: string,
  options: {
    chapterId?: string;
    attempt?: number;
    details?: LongWritingEventDetails;
    at?: string;
  } = {},
): LongWritingEvent {
  return {
    id: uid(),
    type,
    message: message.trim().slice(0, 800),
    chapterId: options.chapterId,
    attempt: options.attempt,
    details: sanitizeLongWritingEventDetails(options.details),
    at: options.at ?? new Date().toISOString(),
  };
}

export function appendLongWritingEvent(
  events: LongWritingEvent[] | undefined,
  event: LongWritingEvent,
  limit = MAX_EVENTS,
): LongWritingEvent[] {
  const next = [...(events ?? []), event];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
