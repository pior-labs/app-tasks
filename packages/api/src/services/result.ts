// What a service call answers: a value, or a failure the caller reports. The
// HTTP routes turn a failure into its status code and the JSON body
// { error, message } (src/http.ts), and the MCP tools into a tool error with
// the same message, so both interfaces refuse the same things in the same words.
//
// - invalid: the request itself is wrong (HTTP 400);
// - not_found: the task or list does not exist or is not the user's (HTTP 404);
// - conflict: the request clashes with stored data (HTTP 409).
export type FailureKind = 'invalid' | 'not_found' | 'conflict';
export type Failure = { kind: FailureKind; error: string; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure };

export const success = <T>(value: T): Result<T> => ({ ok: true, value });
export const failure = (reason: Failure): { ok: false; failure: Failure } => ({ ok: false, failure: reason });
export const invalid = (error: string, message: string): Failure => ({ kind: 'invalid', error, message });
