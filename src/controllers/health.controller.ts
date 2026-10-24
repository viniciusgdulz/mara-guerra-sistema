export function healthController(request: Request): Response {
  const response = Response.json({ status: "ok", message: "Servidor funcionando" });
  response.headers.set("Cache-Control", "no-store");
  return request.method === "HEAD"
    ? new Response(null, { headers: response.headers }) : response;
}
