export function errorResponse(
  request: Request,
  status: number,
  message: string,
  headers?: HeadersInit,
): Response {
  const response = Response.json({ error: message }, { status, headers });
  return request.method === "HEAD"
    ? new Response(null, { status, headers: response.headers }) : response;
}
