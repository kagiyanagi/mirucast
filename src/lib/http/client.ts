type NextFetchInit = RequestInit & {
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
};

type CacheEntry<T> = {
  value: T;
  staleUntil: number;
};

type ProviderFetchOptions = {
  provider: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  cacheKey?: string;
  staleTtlMs?: number;
  staleOnNonRetryable?: boolean;
  dedupe?: boolean;
  breaker?: ProviderBreakerOptions;
};

/**
 * Per-provider circuit breaker for optional upstreams. After `threshold`
 * consecutive retryable failures the provider is treated as degraded for
 * `cooldownMs`: requests still go out (so Next data cache hits keep serving
 * data) but with a short timeout and no retries, so an outage costs callers
 * ~1s instead of the full timeout on every request.
 */
export type ProviderBreakerOptions = {
  threshold: number;
  cooldownMs: number;
  degradedTimeoutMs: number;
};

type BreakerState = {
  consecutiveFailures: number;
  degradedUntil: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 350;
const staleCache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<unknown>>();
// Pages and route handlers are bundled separately and each gets its own copy
// of this module, so breaker state lives on globalThis to be shared by the
// whole server process.
const breakersGlobal = globalThis as typeof globalThis & {
  __providerBreakers?: Map<string, BreakerState>;
};
const breakers = (breakersGlobal.__providerBreakers ??= new Map<
  string,
  BreakerState
>());

export class ProviderFetchError extends Error {
  provider: string;
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
  /**
   * True when the provider was already known to be failing before this
   * request (its breaker had tripped) - callers can skip logging it.
   */
  duringOutage: boolean;

  constructor(input: {
    provider: string;
    message: string;
    status?: number | null;
    retryable?: boolean;
    retryAfterMs?: number | null;
    cause?: unknown;
    duringOutage?: boolean;
  }) {
    super(input.message);
    this.name = "ProviderFetchError";
    this.provider = input.provider;
    this.status = input.status ?? null;
    this.retryable = Boolean(input.retryable);
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.duringOutage = Boolean(input.duringOutage);
    this.cause = input.cause;
  }
}

/**
 * One-line description of a failure for logs. Logging the error object itself
 * dumps the stack plus every DOMException constant for aborted requests.
 */
export function describeError(error: unknown): string {
  const text =
    error instanceof Error ? error.message || error.name : String(error);
  // Some framework errors embed source code after the first line.
  const firstLine = text.split("\n", 1)[0].trim();

  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}...` : firstLine;
}

function getBreaker(provider: string): BreakerState {
  let state = breakers.get(provider);

  if (!state) {
    state = { consecutiveFailures: 0, degradedUntil: 0 };
    breakers.set(provider, state);
  }

  return state;
}

function recordBreakerSuccess(provider: string) {
  const state = getBreaker(provider);

  // While degraded, a success is usually a Next data cache hit and says
  // nothing about the upstream, so only a success after the cooldown counts
  // as recovery.
  if (state.degradedUntil > Date.now()) {
    return;
  }

  state.consecutiveFailures = 0;
  state.degradedUntil = 0;
}

/**
 * Returns true when the provider had already tripped its breaker before this
 * failure, i.e. this failure is part of a known outage.
 */
function recordBreakerFailure(
  provider: string,
  breaker: ProviderBreakerOptions,
): boolean {
  const state = getBreaker(provider);
  const wasAlreadyFailing = state.consecutiveFailures >= breaker.threshold;
  state.consecutiveFailures += 1;

  if (state.consecutiveFailures < breaker.threshold) {
    return false;
  }

  state.degradedUntil = Date.now() + breaker.cooldownMs;

  if (!wasAlreadyFailing) {
    console.warn(
      `${provider} unresponsive after ${breaker.threshold} consecutive failures - ` +
        `using ${breaker.degradedTimeoutMs}ms timeouts without retries; ` +
        `further ${provider} failures are not logged until it recovers`,
    );
  }

  return wasAlreadyFailing;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRequestBodyKey(body: BodyInit | null | undefined): string {
  return typeof body === "string" ? body : "";
}

function createRequestKey(url: string, init: NextFetchInit): string {
  const method = init.method || "GET";
  return `${method}:${url}:${getRequestBodyKey(init.body)}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function getRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

function getBackoffMs(
  attempt: number,
  baseDelayMs: number,
  retryAfterMs: number | null,
): number {
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  return baseDelayMs * 2 ** Math.max(0, attempt - 1);
}

function readStaleCache<T>(
  cacheKey: string | undefined,
  error: unknown,
): T | null {
  if (!cacheKey) {
    return null;
  }

  const entry = staleCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (entry.staleUntil < Date.now()) {
    staleCache.delete(cacheKey);
    return null;
  }

  if (!(error instanceof ProviderFetchError && error.duringOutage)) {
    console.warn(
      `Using stale provider cache for ${cacheKey}: ${describeError(error)}`,
    );
  }
  return entry.value as T;
}

function writeStaleCache<T>(
  cacheKey: string | undefined,
  value: T,
  staleTtlMs: number | undefined,
) {
  if (!cacheKey || !staleTtlMs) {
    return;
  }

  staleCache.set(cacheKey, {
    value,
    staleUntil: Date.now() + staleTtlMs,
  });
}

async function fetchJsonOnce<T>(
  url: string,
  init: NextFetchInit,
  options: Required<
    Pick<
      ProviderFetchOptions,
      "provider" | "timeoutMs" | "retries" | "retryDelayMs"
    >
  >,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ProviderFetchError({
        provider: options.provider,
        message: `${options.provider} request failed with HTTP ${response.status}`,
        status: response.status,
        retryable: isRetryableStatus(response.status),
        retryAfterMs: getRetryAfterMs(response),
      });
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ProviderFetchError) {
      throw error;
    }

    throw new ProviderFetchError({
      provider: options.provider,
      message: timedOut
        ? `${options.provider} request timed out after ${options.timeoutMs}ms`
        : error instanceof Error
          ? `${options.provider} request failed: ${error.message}`
          : `${options.provider} request failed`,
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry<T>(
  url: string,
  init: NextFetchInit,
  options: ProviderFetchOptions,
): Promise<T> {
  const breaker = options.breaker;
  const breakerState = breaker ? getBreaker(options.provider) : null;
  const degraded = Boolean(
    breaker && breakerState && breakerState.degradedUntil > Date.now(),
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const normalizedOptions = {
    provider: options.provider,
    timeoutMs:
      degraded && breaker
        ? Math.min(timeoutMs, breaker.degradedTimeoutMs)
        : timeoutMs,
    retries: degraded ? 0 : (options.retries ?? DEFAULT_RETRIES),
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  };

  for (let attempt = 0; attempt <= normalizedOptions.retries; attempt += 1) {
    try {
      const value = await fetchJsonOnce<T>(url, init, normalizedOptions);
      writeStaleCache(options.cacheKey, value, options.staleTtlMs);
      if (breaker) {
        recordBreakerSuccess(options.provider);
      }
      return value;
    } catch (error) {
      const providerError =
        error instanceof ProviderFetchError
          ? error
          : new ProviderFetchError({
              provider: options.provider,
              message: `${options.provider} request failed`,
              retryable: true,
              cause: error,
            });
      const attemptsRemaining = attempt < normalizedOptions.retries;

      if (!providerError.retryable || !attemptsRemaining) {
        if (breaker) {
          // A non-retryable answer (404 etc.) still proves the upstream is up.
          if (providerError.retryable) {
            providerError.duringOutage = recordBreakerFailure(
              options.provider,
              breaker,
            );
          } else {
            recordBreakerSuccess(options.provider);
          }
        }

        const canUseStale =
          providerError.retryable || options.staleOnNonRetryable === true;
        const cached = canUseStale
          ? readStaleCache<T>(options.cacheKey, providerError)
          : null;
        if (cached) {
          return cached;
        }

        throw providerError;
      }

      await sleep(
        getBackoffMs(
          attempt + 1,
          normalizedOptions.retryDelayMs,
          providerError.retryAfterMs,
        ),
      );
    }
  }

  throw new ProviderFetchError({
    provider: options.provider,
    message: `${options.provider} request failed`,
  });
}

export async function fetchJson<T>(
  url: string,
  init: NextFetchInit,
  options: ProviderFetchOptions,
): Promise<T> {
  const requestKey = options.cacheKey || createRequestKey(url, init);

  if (options.dedupe !== false) {
    const existing = inFlightRequests.get(requestKey);
    if (existing) {
      return existing as Promise<T>;
    }
  }

  const request = fetchJsonWithRetry<T>(url, init, options).finally(() => {
    if (options.dedupe !== false) {
      inFlightRequests.delete(requestKey);
    }
  });

  if (options.dedupe !== false) {
    inFlightRequests.set(requestKey, request);
  }

  return request;
}
