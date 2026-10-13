/**
 * The transient class of an error, or null: rate_limit (HTTP 429), server_error (HTTP 5xx), unavailable (the service
 * said so), or timeout. Retry notices name this class.
 * @param {any} error
 * @returns {'rate_limit' | 'server_error' | 'unavailable' | 'timeout' | null}
 */
export function transientClass(error: any): "rate_limit" | "server_error" | "unavailable" | "timeout" | null;
/**
 * Run one provider request, and run it again after a transient failure. Model calls and classification share this policy.
 * `transient` says which errors to retry; `canRetry` says whether the run still allows another request.
 * `beforeRetry(error, attempt)` runs after the wait and before the next attempt; `attempt` is the number of that next
 * attempt (2 or 3 of `attempts`).
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ transient: (error: any) => boolean, signal?: AbortSignal, canRetry?: () => boolean, beforeRetry?: (error: any, attempt: number) => unknown }} options
 * @returns {Promise<T>}
 */
export function withRetries<T>(operation: () => Promise<T>, { transient, signal, canRetry, beforeRetry }: {
    transient: (error: any) => boolean;
    signal?: AbortSignal;
    canRetry?: () => boolean;
    beforeRetry?: (error: any, attempt: number) => unknown;
}): Promise<T>;
export function transientStatus(status: any): boolean;
export const attempts: 3;
