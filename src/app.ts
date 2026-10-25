import { healthController } from "./controllers/health.controller";
import { isHealthRoute } from "./routes/health.routes";
import { errorResponse } from "./http-error";
import { criarAuthController } from "./controllers/auth.controller";
import { isAuthRoute } from "./routes/auth.routes";
import { createConnection } from "./db/connection";
import type { SQL } from "bun";

let db: SQL | undefined;
const auth = criarAuthController(() => db ??= createConnection(), Bun.env.NODE_ENV === "production", Bun.env.APP_ORIGIN);

export async function closeConnection(): Promise<void> {
  if (db) await db.close({ timeout: 5 });
}

// Somente os arquivos públicos registrados nesta lista podem ser servidos.
const staticFiles = new Map([
  ["/", new URL("../public/index.html", import.meta.url)],
  ["/index.html", new URL("../public/index.html", import.meta.url)],
  ["/css/styles.css", new URL("../public/css/styles.css", import.meta.url)],
  ["/js/app.js", new URL("../public/js/app.js", import.meta.url)],
]);

export async function handleRequest(request: Request): Promise<Response> {
  try {
    return await routeRequest(request);
  } catch {
    return errorResponse(request, 500, "Erro interno do servidor", { "Cache-Control": "no-store" });
  }
}

async function routeRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (isAuthRoute(pathname) || pathname === "/api/admin" || pathname.startsWith("/api/admin/")) {
    return auth(request);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(request, 405, "Método não permitido", { Allow: "GET, HEAD" });
  }

  if (isHealthRoute(pathname)) {
    return healthController(request);
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return errorResponse(request, 404, "Não encontrado");
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
