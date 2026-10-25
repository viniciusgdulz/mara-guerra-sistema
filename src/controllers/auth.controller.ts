import type { SQL } from "bun";
import { cookieSessao, criarLimitador, lerToken, origemPermitida, temPerfil } from "../auth";
import { login, logout, obterUsuario } from "../services/auth.service";
import { errorResponse } from "../http-error";

export function criarAuthController(getDb: () => SQL, producao: boolean, origem?: string) {
  const permitirTentativa = criarLimitador();
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const consulta = path === "/api/auth/me" || path.startsWith("/api/admin");
    const metodo = consulta ? "GET" : "POST";
    const erro = (status: number, mensagem: string, headers?: HeadersInit) => {
      const responseHeaders = new Headers(headers);
      responseHeaders.set("Cache-Control", "no-store");
      return errorResponse(request, status, mensagem, responseHeaders);
    };
    if (request.method !== metodo) return erro(405, "Método não permitido", { Allow: metodo });
    if (!consulta && !origemPermitida(request, origem, producao)) return erro(403, "Origem não permitida.");

    if (path === "/api/auth/login") {
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return erro(415, "Envie os dados em JSON.");
      // Lê com limite real, inclusive quando Content-Length não foi enviado.
      const reader = request.body?.getReader();
      if (!reader) return erro(400, "Dados de login inválidos.");
      const chunks: Uint8Array[] = [];
      let tamanho = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        tamanho += value.length;
        if (tamanho > 4096) { await reader.cancel(); return erro(413, "Dados de login muito grandes."); }
        chunks.push(value);
      }
      let dados;
      try { dados = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
      catch { return erro(400, "Dados de login inválidos."); }
      if (!dados || typeof dados.email !== "string" || typeof dados.senha !== "string") return erro(400, "Dados de login inválidos.");
      const email = dados.email.trim().toLowerCase();
      if (!email || email.length > 254 || !dados.senha || dados.senha.length > 128) return erro(400, "Dados de login inválidos.");
      if (!permitirTentativa(email)) return erro(429, "Muitas tentativas. Aguarde antes de tentar novamente.", { "Retry-After": "900" });
      const resultado = await login(getDb(), email, dados.senha);
      if (!resultado) return erro(401, "E-mail ou senha inválidos.");
      const anterior = lerToken(request, producao);
      if (anterior) await logout(getDb(), anterior);
      return Response.json({ usuario: resultado.usuario }, { headers: { "Cache-Control": "no-store", "Set-Cookie": cookieSessao(resultado.token, producao) } });
    }
    const token = lerToken(request, producao);
    if (path === "/api/auth/logout") {
      if (token) await logout(getDb(), token);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "Set-Cookie": cookieSessao("", producao, true) } });
    }
    const usuario = token ? await obterUsuario(getDb(), token) : null;
    if (!usuario) return erro(401, "Entre na sua conta para continuar.");
    if (path.startsWith("/api/admin")) {
      if (!temPerfil(usuario, ["administrador"])) return erro(403, "Você não tem permissão para esta operação.");
      return erro(404, "Não encontrado");
    }
    return Response.json({ usuario }, { headers: { "Cache-Control": "no-store" } });
  };
}
