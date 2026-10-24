import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { handleRequest } from "../src/app";

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handleRequest });
afterAll(() => server.stop(true));
const request = (path: string, init?: RequestInit) => fetch(new URL(path, server.url), init);

describe("Servidor HTTP", () => {
  test("GET /api/health informa o funcionamento", async () => {
    const response = await request("/api/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok", message: "Servidor funcionando" });
  });
  test.each(["/", "/index.html"])("serve HTML em %s", async (path) => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Mara Guerra Estética Avançada — Sistema de Gestão");
  });
  test.each([
    ["/css/styles.css", "text/css"],
    ["/js/app.js", "javascript"],
  ])("serve o arquivo %s", async (path, type) => {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(type);
    expect((await response.text()).length).toBeGreaterThan(0);
  });
  test.each(["/inexistente", "/.env", "/src/server.ts", "/%2e%2e%2fsrc/server.ts"])(
    "retorna 404 para %s", async (path) => {
      expect((await request(path)).status).toBe(404);
    },
  );
  test("recusa POST", async () => {
    const response = await request("/api/health", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Método não permitido" });
  });
  test.each(["/api", "/api/inexistente"])("retorna 404 JSON para %s", async (path) => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Não encontrado" });
  });
  test.each(["/inexistente", "/api/inexistente"])("HEAD %s retorna 404 sem corpo", async (path) => {
    const response = await request(path, { method: "HEAD" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
  test.each(["GET", "HEAD"])("%s retorna 500 seguro em uma falha inesperada", async (method) => {
    const fileSpy = spyOn(Bun, "file").mockImplementation(() => {
      throw new Error("Informação interna confidencial");
    });
    try {
      const response = await request("/", { method });
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      if (method === "HEAD") {
        expect(await response.text()).toBe("");
      } else {
        expect(await response.json()).toEqual({ error: "Erro interno do servidor" });
      }
    } finally {
      fileSpy.mockRestore();
    }
  });
  test.each(["/", "/api/health"])("HEAD %s retorna sem corpo", async (path) => {
    const response = await request(path, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
