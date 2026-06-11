/**
 * Trailing-edge scheduler: each `schedule()` (re)starts the delay; `fn` runs
 * once, `delayMs` after the last call. Unlike `debounce`, exposes `cancel`
 * and `flush` so owners can dispose cleanly or force the pending run.
 * vscode-free so the timing behavior is unit-testable.
 */
export class TrailingScheduler {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly fn: () => void,
    private readonly delayMs: number
  ) {}

  /** (Re)arm the trailing timer. */
  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fn();
    }, this.delayMs);
    // Don't keep the process alive solely for a pending coverage compute.
    (this.timer as any).unref?.();
  }

  /** Drop the pending run, if any. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Run the pending work immediately (no-op when nothing is scheduled). */
  flush(): void {
    if (!this.timer) return;
    this.cancel();
    this.fn();
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }
}
