// Somente os arquivos públicos registrados nesta lista podem ser servidos.
const staticFiles = new Map([
  ["/", new URL("../public/index.html", import.meta.url)],
  ["/index.html", new URL("../public/index.html", import.meta.url)],
  ["/css/styles.css", new URL("../public/css/styles.css", import.meta.url)],
  ["/js/app.js", new URL("../public/js/app.js", import.meta.url)],
]);

export async function handleRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Método não permitido", {
      status: 405, headers: { Allow: "GET, HEAD" },
    });
  }

  if (pathname === "/api/health") {
    const response = Response.json({ status: "ok", message: "Servidor funcionando" });
    response.headers.set("Cache-Control", "no-store");
    return request.method === "HEAD"
      ? new Response(null, { headers: response.headers }) : response;
  }

  const fileUrl = staticFiles.get(pathname);
  if (fileUrl) {
    const file = Bun.file(fileUrl);
    if (await file.exists()) {
      return new Response(request.method === "HEAD" ? null : file, {
        headers: { "Content-Type": file.type },
      });
    }
  }
  return new Response(request.method === "HEAD" ? null : "Não encontrado", { status: 404 });
}
