import { describe, expect, it } from "vitest";
import {
  WEEKDAYS,
  describeRule,
  formatRule,
  isOccurrence,
  isTimeZone,
  localLabel,
  minGapMinutes,
  occurrenceAfter,
  occurrenceKey,
  occurrencesBetween,
  parseOccurrenceKey,
  parseRule,
  wallClock,
  zonedInstant,
} from "#board/schedule-time.js";
import type { Rule, Weekday } from "#board/schedule-time.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A seeded generator (mulberry32), so a failing case can be replayed from its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] as T;
}

function between(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

// Zones without daylight saving (Taipei, Kathmandu at +5:45, UTC), with the
// usual one-hour shift at night (New York, London), a half-hour shift (Lord
// Howe), a two-hour shift (Troll), and shifts at local midnight (Santiago
// skips 00:00 to 01:00; Havana repeats 00:00 to 01:00), checked with Intl.
const ZONES = [
  "Asia/Taipei",
  "Asia/Kathmandu",
  "UTC",
  "America/New_York",
  "Europe/London",
  "Australia/Lord_Howe",
  "Antarctica/Troll",
  "America/Santiago",
  "America/Havana",
] as const;

const FROM = Date.UTC(2025, 0, 1);
const TO = Date.UTC(2028, 0, 1);

function randomRule(random: () => number): Rule {
  const hour = between(random, 0, 23);
  const minute = pick(random, [0, 15, 30, 45, between(random, 0, 59)]);
  if (random() < 0.5) return { kind: "daily", hour, minute };
  const days = WEEKDAYS.filter(() => random() < 0.4);
  return { kind: "weekly", days: days.length === 0 ? ["mon"] : days, hour, minute };
}

/**
 * Every instant within a day of `local` whose wall clock in `zone` is
 * exactly `local`, found by scanning, without zonedInstant.
 */
function scanned(zone: string, local: number): number[] {
  const found: number[] = [];
  for (let at = local - 16 * 60 * MINUTE; at <= local + 16 * 60 * MINUTE; at += 15 * MINUTE) {
    if (wallClock(zone, at) === local) found.push(at);
  }
  return found;
}

function weekdayOf(zone: string, ms: number): Weekday {
  return WEEKDAYS[new Date(wallClock(zone, ms)).getUTCDay()] as Weekday;
}

function localDate(zone: string, ms: number): string {
  return new Date(wallClock(zone, ms)).toISOString().slice(0, 10);
}

describe("rules", () => {
  it("reads and writes the two kinds of rule", () => {
    expect(parseRule("daily 06:00")).toEqual({ kind: "daily", hour: 6, minute: 0 });
    expect(parseRule("weekly mon,thu 10:30")).toEqual({
      kind: "weekly",
      days: ["mon", "thu"],
      hour: 10,
      minute: 30,
    });
    expect(formatRule({ kind: "weekly", days: ["mon"], hour: 10, minute: 0 })).toBe(
      "weekly mon 10:00",
    );
    expect(describeRule({ kind: "weekly", days: ["mon", "thu"], hour: 9, minute: 5 })).toBe(
      "每週一、四 09:05",
    );
    expect(describeRule({ kind: "daily", hour: 6, minute: 0 })).toBe("每天 06:00");
  });

  it.each([
    "daily 6:00",
    "daily 24:00",
    "daily 06:60",
    "weekly 10:00",
    "weekly thu,mon 10:00",
    "weekly mon,funday 10:00",
    "monthly 1 10:00",
    "daily  06:00",
    "",
  ])("refuses %j", (text) => {
    expect(parseRule(text)).toBeNull();
  });

  it("knows real zones and refuses made-up ones", () => {
    expect(isTimeZone("Asia/Taipei")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("daylight saving", () => {
  it("moves a skipped local time forward by the gap", () => {
    // New York skips 02:00 to 03:00 on 2026-03-08: 02:30 becomes 03:30 EDT.
    const at = zonedInstant("America/New_York", Date.UTC(2026, 2, 8, 2, 30));
    expect(new Date(at).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // Santiago skips 00:00 to 01:00 on 2025-09-07: midnight becomes 01:00.
    const midnight = zonedInstant("America/Santiago", Date.UTC(2025, 8, 7, 0, 0));
    expect(new Date(midnight).toISOString()).toBe("2025-09-07T04:00:00.000Z");
  });

  it("counts the first instance of a repeated local time", () => {
    // New York repeats 01:00 to 02:00 on 2026-11-01: 01:30 is the EDT one.
    const at = zonedInstant("America/New_York", Date.UTC(2026, 10, 1, 1, 30));
    expect(new Date(at).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("falls once on the day a daily time happens twice", () => {
    const rule: Rule = { kind: "daily", hour: 1, minute: 30 };
    const found = occurrencesBetween(
      rule,
      "America/New_York",
      Date.UTC(2026, 10, 1),
      Date.UTC(2026, 10, 2, 12),
    );
    expect(found.map((ms) => new Date(ms).toISOString())).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("matches a scan of the zone's wall clock for every rule, zone and date", () => {
    const random = generator(20_261_126);
    for (let run = 0; run < 400; run += 1) {
      const zone = pick(random, ZONES);
      const local = Date.UTC(
        between(random, 2025, 2027),
        between(random, 0, 11),
        between(random, 1, 28),
        between(random, 0, 23),
        pick(random, [0, 15, 30, 45]),
      );
      const at = zonedInstant(zone, local);
      const exact = scanned(zone, local);
      if (exact.length > 0) {
        expect(at, `${zone} ${new Date(local).toISOString()}`).toBe(exact[0]);
      } else {
        const jump =
          wallClock(zone, at + DAY) - (at + DAY) - (wallClock(zone, at - DAY) - (at - DAY));
        expect(jump).toBeGreaterThan(0);
        expect(wallClock(zone, at) - local, `${zone} ${new Date(local).toISOString()}`).toBe(jump);
      }
    }
  });
});

describe("occurrences", () => {
  it("falls on the rule's weekdays at most once a local date, always later than the last", () => {
    const random = generator(7);
    for (let run = 0; run < 60; run += 1) {
      const rule = randomRule(random);
      const zone = pick(random, ZONES);
      const start = between(random, FROM, TO - 120 * DAY);
      const found = occurrencesBetween(rule, zone, start, start + 120 * DAY);
      const dates = found.map((ms) => localDate(zone, ms));
      expect(new Set(dates).size).toBe(found.length);
      for (const [index, ms] of found.entries()) {
        if (index > 0) expect(ms).toBeGreaterThan(found[index - 1] as number);
        if (rule.kind === "weekly") expect(rule.days).toContain(weekdayOf(zone, ms));
        expect(isOccurrence(rule, zone, ms)).toBe(true);
      }
      const expected = rule.kind === "daily" ? 120 : (120 / 7) * rule.days.length;
      expect(Math.abs(found.length - expected)).toBeLessThanOrEqual(rule.kind === "daily" ? 1 : 3);
    }
  });

  it("never leaves out an occurrence: the next one after any instant is the first in the window", () => {
    const random = generator(99);
    for (let run = 0; run < 200; run += 1) {
      const rule = randomRule(random);
      const zone = pick(random, ZONES);
      const after = between(random, FROM, TO);
      const next = occurrenceAfter(rule, zone, after);
      expect(next).toBeGreaterThan(after);
      expect(occurrencesBetween(rule, zone, after, next - 1)).toEqual([]);
      expect(occurrenceAfter(rule, zone, next - 1)).toBe(next);
    }
  });

  it("keeps two occurrences at least the rule's least gap apart, across every shift", () => {
    const random = generator(4242);
    for (let run = 0; run < 80; run += 1) {
      const rule = randomRule(random);
      const zone = pick(random, ZONES);
      const start = between(random, FROM, TO - 400 * DAY);
      const found = occurrencesBetween(rule, zone, start, start + 400 * DAY);
      for (let index = 1; index < found.length; index += 1) {
        const gap = ((found[index] as number) - (found[index - 1] as number)) / MINUTE;
        expect(gap).toBeGreaterThanOrEqual(minGapMinutes(rule));
      }
    }
  });

  it("knows the least gap of each kind of rule", () => {
    expect(minGapMinutes({ kind: "daily", hour: 6, minute: 0 })).toBe(1320);
    expect(minGapMinutes({ kind: "weekly", days: ["mon"], hour: 6, minute: 0 })).toBe(
      7 * 1440 - 120,
    );
    expect(minGapMinutes({ kind: "weekly", days: ["mon", "thu"], hour: 6, minute: 0 })).toBe(
      3 * 1440 - 120,
    );
    expect(minGapMinutes({ kind: "weekly", days: ["sun", "sat"], hour: 6, minute: 0 })).toBe(1320);
  });

  it("finds the next occurrence across a day and a week boundary", () => {
    const rule: Rule = { kind: "weekly", days: ["mon"], hour: 10, minute: 0 };
    // Sunday 2026-11-29 23:59 in Taipei, then Monday 10:00 itself.
    const sunday = Date.UTC(2026, 10, 29, 15, 59);
    expect(new Date(occurrenceAfter(rule, "Asia/Taipei", sunday)).toISOString()).toBe(
      "2026-11-30T02:00:00.000Z",
    );
    const monday = Date.UTC(2026, 10, 30, 2, 0);
    expect(new Date(occurrenceAfter(rule, "Asia/Taipei", monday)).toISOString()).toBe(
      "2026-12-07T02:00:00.000Z",
    );
    // 23:30 daily in Kathmandu, asked at 23:40 local: tomorrow's.
    const daily: Rule = { kind: "daily", hour: 23, minute: 30 };
    const late = Date.UTC(2026, 10, 26, 17, 55);
    expect(localLabel("Asia/Kathmandu", occurrenceAfter(daily, "Asia/Kathmandu", late))).toBe(
      "11-27（五）23:30",
    );
  });
});

describe("keys and labels", () => {
  it("writes the key in UTC and the label in the schedule's zone", () => {
    const at = Date.UTC(2026, 10, 30, 2, 0);
    expect(occurrenceKey("weekly-sync", at)).toBe("weekly-sync:20261130T0200Z");
    expect(localLabel("Asia/Taipei", at)).toBe("11-30（一）10:00");
  });

  it("reads back every key it writes", () => {
    const random = generator(31);
    for (let run = 0; run < 200; run += 1) {
      const at = Math.floor(between(random, FROM, TO) / MINUTE) * MINUTE;
      const series = pick(random, ["a", "mail-0600", "x.y_z", "a:b"]);
      expect(parseOccurrenceKey(occurrenceKey(series, at))).toEqual({ series, at });
    }
  });

  it.each(["weekly-sync", "weekly-sync:20261130T0200", "x:20261332T0200Z", ":20261130T0200Z"])(
    "refuses %j as a key",
    (key) => {
      expect(parseOccurrenceKey(key)).toBeNull();
    },
  );
});
