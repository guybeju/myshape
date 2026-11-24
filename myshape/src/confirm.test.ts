import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRM_TTL_MS, ConfirmStore, bindingOf } from "./confirm.js";

describe("ConfirmStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a 32-character code that expires after two minutes", () => {
    const store = new ConfirmStore();
    const issued = store.issue("x");
    expect(issued.confirm).toMatch(/^[0-9a-f]{32}$/);
    expect(issued.expires_at).toBe(Date.now() + CONFIRM_TTL_MS);
    expect(CONFIRM_TTL_MS).toBe(120_000);
    expect(store.issue("x").confirm).not.toBe(issued.confirm);
  });

  it("redeems a code once, for the binding it was issued for", () => {
    const store = new ConfirmStore();
    const { confirm } = store.issue("answer:1");
    expect(store.redeem(confirm, "answer:1")).toBe(true);
    expect(store.redeem(confirm, "answer:1")).toBe(false);
    expect(store.redeem("0".repeat(32), "answer:1")).toBe(false);
  });

  it("voids a code presented for another binding", () => {
    const store = new ConfirmStore();
    const { confirm } = store.issue("answer:1");
    expect(store.redeem(confirm, "answer:2")).toBe(false);
    expect(store.redeem(confirm, "answer:1")).toBe(false);
  });

  it("rejects a code at and after its expiry", () => {
    const store = new ConfirmStore(1000);
    const early = store.issue("a");
    vi.advanceTimersByTime(999);
    expect(store.redeem(early.confirm, "a")).toBe(true);
    const late = store.issue("a");
    vi.advanceTimersByTime(1000);
    expect(store.redeem(late.confirm, "a")).toBe(false);
  });

  it("forgets expired codes when a new one is issued", () => {
    const store = new ConfirmStore(1000);
    const old = store.issue("a");
    vi.advanceTimersByTime(1000);
    store.issue("b");
    vi.setSystemTime(new Date("2026-11-16T00:00:00.500Z"));
    expect(store.redeem(old.confirm, "a")).toBe(false);
  });
});

describe("bindingOf", () => {
  it("separates parts so that they cannot run into each other", () => {
    expect(bindingOf("a", "bc")).not.toBe(bindingOf("ab", "c"));
    expect(bindingOf("a", "b")).not.toBe(bindingOf("b", "a"));
    expect(bindingOf("a", "b")).toBe(bindingOf("a", "b"));
    expect(bindingOf("a", "b")).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
  });
});
