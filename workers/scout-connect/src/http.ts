export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function htmlPage(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// SECURITY: never leak stack traces or internal error text to the client —
// only an HttpError's own deliberate message is exposed.
export function handleError(e: unknown): Response {
  if (e instanceof HttpError) {
    return json({ error: e.message }, e.status);
  }
  console.error("unhandled route error", e);
  return json({ error: "internal" }, 500);
}
