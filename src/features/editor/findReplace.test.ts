import { describe, expect, it } from "vitest";
import { findMatches, replaceAllMatches, replaceMatch } from "./findReplace";

describe("findReplace", () => {
  it("finds case-insensitive matches by default", () => {
    const matches = findMatches("Foo foo FOO", "foo");
    expect(matches).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it("respects case sensitivity", () => {
    expect(findMatches("Foo foo", "foo", { caseSensitive: true })).toEqual([{ start: 4, end: 7 }]);
  });

  it("matches LF queries against CRLF documents and returns original offsets", () => {
    expect(findMatches("第一行\r\n第二行", "第一行\n第二行")).toEqual([{ start: 0, end: 8 }]);
  });

  it("replaces one match", () => {
    const { text, nextCaret } = replaceMatch("a b a", { start: 2, end: 3 }, "X");
    expect(text).toBe("a X a");
    expect(nextCaret).toBe(3);
  });

  it("replaces all matches", () => {
    const { text, count } = replaceAllMatches("foo bar foo", "foo", "baz");
    expect(text).toBe("baz bar baz");
    expect(count).toBe(2);
  });
});
