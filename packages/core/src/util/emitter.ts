export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (arg: T) => void;

export class TypedEmitter<T> {
  private listeners: Array<Listener<T>> = [];

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      }
    };
  };

  fire(arg: T): void {
    for (const l of this.listeners.slice()) l(arg);
  }

  dispose(): void {
    this.listeners.length = 0;
  }
}
