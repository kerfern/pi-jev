export interface EnforcementScope {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export class EnforcementEpoch {
  private generation = 0;
  private controller = new AbortController();
  private readonly callScopes = new Map<string, EnforcementScope>();

  capture(): EnforcementScope {
    return { generation: this.generation, signal: this.controller.signal };
  }

  captureCall(toolCallId: string): EnforcementScope {
    const existing = this.callScopes.get(toolCallId);
    if (existing) return existing;
    const scope = this.capture();
    this.callScopes.set(toolCallId, scope);
    return scope;
  }

  callScope(toolCallId: string): EnforcementScope | undefined {
    return this.callScopes.get(toolCallId);
  }

  releaseCall(toolCallId: string): void {
    this.callScopes.delete(toolCallId);
  }

  isCurrent(scope: EnforcementScope): boolean {
    return scope.generation === this.generation && !scope.signal.aborted;
  }

  invalidate(): void {
    this.controller.abort();
    this.generation += 1;
    this.controller = new AbortController();
  }
}

export const ENFORCEMENT_CANCELLED: unique symbol = Symbol("ENFORCEMENT_CANCELLED");
export type EnforcementCancelled = typeof ENFORCEMENT_CANCELLED;

export function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  return active.length === 1 ? active[0] : AbortSignal.any(active);
}

export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | EnforcementCancelled> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ENFORCEMENT_CANCELLED);

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      resolve(ENFORCEMENT_CANCELLED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
