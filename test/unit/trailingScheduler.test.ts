import { describe, expect, it, vi } from "vitest";

// The scheduler lives in the vscode-client package but is vscode-free by
// design (it paces the coverage recompute off the save path) — import the
// source directly; no extension host needed.
import { TrailingScheduler } from "../../packages/vscode-client/src/util/trailingScheduler";

describe("TrailingScheduler", () => {
  it("runs once, delayMs after the LAST schedule() of a burst", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const s = new TrailingScheduler(fn, 1000);
      s.schedule();
      vi.advanceTimersByTime(600);
      s.schedule(); // burst continues — timer re-arms
      vi.advanceTimersByTime(600);
      expect(fn).not.toHaveBeenCalled(); // only 600ms since last schedule
      vi.advanceTimersByTime(400);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(s.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel drops the pending run", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const s = new TrailingScheduler(fn, 100);
      s.schedule();
      s.cancel();
      vi.advanceTimersByTime(500);
      expect(fn).not.toHaveBeenCalled();
      expect(s.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush runs pending work immediately; no-op when idle", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const s = new TrailingScheduler(fn, 100);
      s.flush(); // idle — nothing happens
      expect(fn).not.toHaveBeenCalled();
      s.schedule();
      s.flush();
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(fn).toHaveBeenCalledTimes(1); // timer was consumed by flush
    } finally {
      vi.useRealTimers();
    }
  });
});
