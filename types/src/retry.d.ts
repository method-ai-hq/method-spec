/**
 * Run one provider request, and run it again after a transient failure. Model calls and classification share this policy.
 * `transient` says which errors to retry; `canRetry` says whether the run still allows another request.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ transient: (error: any) => boolean, signal?: AbortSignal, canRetry?: () => boolean, beforeRetry?: () => void }} options
 * @returns {Promise<T>}
 */
export function withRetries<T>(operation: () => Promise<T>, { transient, signal, canRetry, beforeRetry }: {
    transient: (error: any) => boolean;
    signal?: AbortSignal;
    canRetry?: () => boolean;
    beforeRetry?: () => void;
}): Promise<T>;
export function transientStatus(status: any): boolean;
export const attempts: 3;
