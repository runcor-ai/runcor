// WaitSignal — sentinel return value for flow handlers to signal wait

/** Options for creating a WaitSignal */
export interface WaitSignalOptions {
  /** Human-readable reason for waiting */
  reason?: string;
  /** When the external system is expected to resume */
  expectedResumeBy?: Date;
  /** Arbitrary serializable data to attach to the wait */
  waitData?: unknown;
}

/** Branded sentinel returned by flow handlers to pause execution */
export interface WaitSignal {
  readonly __brand: 'WaitSignal';
  readonly reason?: string;
  readonly expectedResumeBy?: Date;
  readonly waitData?: unknown;
}

/** Create a WaitSignal that a flow handler returns to pause execution */
export function createWaitSignal(options?: WaitSignalOptions): WaitSignal {
  return Object.freeze({
    __brand: 'WaitSignal' as const,
    ...(options?.reason !== undefined && { reason: options.reason }),
    ...(options?.expectedResumeBy !== undefined && { expectedResumeBy: options.expectedResumeBy }),
    ...(options?.waitData !== undefined && { waitData: options.waitData }),
  });
}

/** Type guard: returns true if the value is a WaitSignal */
export function isWaitSignal(value: unknown): value is WaitSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__brand' in value &&
    (value as Record<string, unknown>).__brand === 'WaitSignal'
  );
}
