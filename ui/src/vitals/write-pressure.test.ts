import { describe, expect, it } from "vitest";
import { WritePressure } from "./write-pressure";

function at(t: { v: number }) {
  return new WritePressure(() => t.v);
}

describe("WritePressure", () => {
  it("sums bytes across sessions inside the window", () => {
    const t = { v: 0 };
    const p = at(t);
    p.add("s1", 1000);
    t.v = 200;
    p.add("s2", 500);
    expect(p.bytesInLast(5000)).toBe(1500);
  });

  it("counts distinct sessions that produced output — the concurrent-agent signal", () => {
    const t = { v: 0 };
    const p = at(t);
    p.add("s1", 10);
    p.add("s1", 10);
    t.v = 300;
    p.add("s2", 10);
    p.add("s3", 10);
    expect(p.writersInLast(5000)).toBe(3);
  });

  it("forgets everything older than the requested window", () => {
    const t = { v: 0 };
    const p = at(t);
    p.add("old", 9999);
    t.v = 6000; // beyond the 5s ring
    expect(p.bytesInLast(5000)).toBe(0);
    expect(p.writersInLast(5000)).toBe(0);
  });

  it("honours a window shorter than the ring", () => {
    const t = { v: 0 };
    const p = at(t);
    p.add("s1", 100);
    t.v = 2000;
    p.add("s2", 50);
    expect(p.bytesInLast(5000)).toBe(150);
    expect(p.bytesInLast(500)).toBe(50); // only the recent bucket
  });

  it("reuses a ring slot without leaking the previous lap's bytes", () => {
    const t = { v: 0 };
    const p = at(t);
    p.add("s1", 1000);
    t.v = 5000; // same slot index one lap later
    p.add("s2", 7);
    expect(p.bytesInLast(5000)).toBe(7);
    expect(p.writersInLast(5000)).toBe(1);
  });

  it("reports zero on a fresh meter", () => {
    const p = at({ v: 12345 });
    expect(p.bytesInLast(5000)).toBe(0);
    expect(p.writersInLast(5000)).toBe(0);
  });
});
