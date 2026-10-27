import type { SQL } from "bun";
import { lerToken, origemPermitida, temPerfil } from "../auth";
import { obterUsuario } from "../services/auth.service";
import { listarProcedimentos } from "../services/procedimentos.service";
import { ajustarRetorno, cadastrarAtendimento, ErroAtendimento, historicoPaciente } from "../services/atendimentos.service";
import { errorResponse } from "../http-error";

export function criarAtendimentosController(getDb: () => SQL, producao: boolean, origem?: string) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    const erro = (status: number, mensagem: string, extras?: Record<string, string>) => errorResponse(request, status, mensagem, { ...headers, ...extras });
    try {
      const url = new URL(request.url);
      // Autoriza antes de validar rota ou parâmetros, inclusive nos subcaminhos.
      const token = lerToken(request, producao);
      const usuario = token ? await obterUsuario(getDb(), token) : null;
      if (!usuario) return erro(401, "Entre na sua conta para continuar.");
      if (!temPerfil(usuario, ["administrador"])) return erro(403, "Somente administradores podem acessar atendimentos.");
      const collection = url.pathname === "/api/atendimentos";
      const catalogo = url.pathname === "/api/atendimentos/procedimentos";
      const ajuste = url.pathname.match(/^\/api\/atendimentos\/([^/]+)\/retorno$/);
      if (!collection && !catalogo && !ajuste) return erro(404, "Não encontrado");
      const methods = collection ? ["GET", "POST"] : catalogo ? ["GET"] : ["PATCH"];
      if (!methods.includes(request.method)) return erro(405, "Método não permitido", { Allow: methods.join(", ") });
      if (request.method !== "GET" && !origemPermitida(request, origem, producao)) return erro(403, "Origem não permitida.");
      if (request.method === "GET") {
        const texto = url.searchParams.get("pagina") ?? "1";
        const pagina = Number(texto);
        if (!/^[1-9]\d*$/.test(texto) || !Number.isSafeInteger(pagina) || pagina > 1000000) return erro(400, "Página inválida.");
        if (catalogo) {
          const nome = (url.searchParams.get("nome") ?? "").trim();
          if (nome.length > 150) return erro(400, "Pesquisa inválida.");
          const procedimentos = await listarProcedimentos(getDb(), nome, pagina, false);
          return Response.json({ procedimentos: procedimentos.slice(0, 50), pagina, temMais: procedimentos.length > 50 }, { headers });
        }
        const atendimentos = await historicoPaciente(getDb(), url.searchParams.get("paciente_id") ?? "", pagina);
        return Response.json({ atendimentos: atendimentos.slice(0, 50), pagina, temMais: atendimentos.length > 50 }, { headers });
      }
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return erro(415, "Envie os dados em JSON.");
      const reader = request.body?.getReader();
      if (!reader) return erro(400, "Dados do atendimento inválidos.");
      const chunks: Uint8Array[] = [];
      let tamanho = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        tamanho += value.length;
        if (tamanho > 4096) { await reader.cancel(); return erro(413, "Dados do atendimento muito grandes."); }
        chunks.push(value);
      }
      let dados: unknown;
      try { dados = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
      catch { return erro(400, "JSON inválido."); }
      const atendimento = ajuste ? await ajustarRetorno(getDb(), ajuste[1]!, dados) : await cadastrarAtendimento(getDb(), dados);
      return Response.json({ atendimento }, { status: ajuste ? 200 : 201, headers });
    } catch (error) {
      if (error instanceof ErroAtendimento) return erro(error.status, error.message);
      return erro(500, "Não foi possível concluir a operação. Tente novamente.");
    }
  };
}
