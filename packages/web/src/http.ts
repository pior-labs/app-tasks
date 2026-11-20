export const jsonHeaders = { 'Content-Type': 'application/json' };

// Prefer the server's human-readable message for a rejected request. The code
// tells which field the message is about.
export async function serverError(response: Response, fallback: string) {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      const code = 'error' in body && typeof body.error === 'string' ? body.error : '';
      return { message: body.message, code };
    }
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return { message: fallback, code: '' };
}
