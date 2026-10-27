import type { SQL } from "bun";
import { lerToken, origemPermitida, temPerfil } from "../auth";
import { obterUsuario } from "../services/auth.service";
import { cadastrarProcedimento, editarProcedimento, inativarProcedimento, listarProcedimentos, DadosProcedimentoInvalidos } from "../services/procedimentos.service";
import { errorResponse } from "../http-error";

export function criarProcedimentosController(getDb: () => SQL, producao: boolean, origem?: string) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    const erro = (status: number, mensagem: string, extras?: Record<string, string>) => errorResponse(request, status, mensagem, { ...headers, ...extras });
    try {
      const url = new URL(request.url);
      const collection = url.pathname === "/api/procedimentos";
      const item = url.pathname.match(/^\/api\/procedimentos\/([^/]+)(\/inativar)?$/);
      const methods = collection ? ["GET", "POST"] : item?.[2] ? ["POST"] : item ? ["PUT"] : [];
      if (methods.length && !methods.includes(request.method)) return erro(405, "Método não permitido", { Allow: methods.join(", ") });
      if (request.method !== "GET" && !origemPermitida(request, origem, producao)) return erro(403, "Origem não permitida.");
      const token = lerToken(request, producao);
      const usuario = token ? await obterUsuario(getDb(), token) : null;
      if (!usuario) return erro(401, "Entre na sua conta para continuar.");
      if (!temPerfil(usuario, ["administrador", "funcionario"])) return erro(403, "Você não tem permissão para esta operação.");
      if (!collection && !item) return erro(404, "Não encontrado");
      const administrador = temPerfil(usuario, ["administrador"]);
      if (request.method !== "GET" && !administrador) return erro(403, "Somente administradores podem gerenciar procedimentos.");
      if (collection && request.method === "GET") {
        const nome = (url.searchParams.get("nome") ?? "").trim();
        const texto = url.searchParams.get("pagina") ?? "1";
        const pagina = Number(texto);
        if (nome.length > 150 || !/^[1-9]\d*$/.test(texto) || !Number.isSafeInteger(pagina) || pagina > 1000000) return erro(400, "Pesquisa ou página inválida.");
        const procedimentos = await listarProcedimentos(getDb(), nome, pagina, administrador);
        return Response.json({ procedimentos: procedimentos.slice(0, 50), pagina, temMais: procedimentos.length > 50 }, { headers });
      }
      const id = item?.[1];
      if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return erro(400, "Identificador de procedimento inválido.");
      if (id && item?.[2]) {
        const procedimento = await inativarProcedimento(getDb(), id);
        return procedimento ? Response.json({ procedimento }, { headers }) : erro(404, "Procedimento não encontrado.");
      }
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return erro(415, "Envie os dados em JSON.");
      const reader = request.body?.getReader();
      if (!reader) return erro(400, "Dados do procedimento inválidos.");
      const chunks: Uint8Array[] = [];
      let tamanho = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        tamanho += value.length;
        if (tamanho > 32768) { await reader.cancel(); return erro(413, "Dados do procedimento muito grandes."); }
        chunks.push(value);
      }
      let dados: unknown;
      try { dados = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
      catch { return erro(400, "JSON inválido."); }
      const procedimento = id ? await editarProcedimento(getDb(), id, dados) : await cadastrarProcedimento(getDb(), dados);
      if (!procedimento) return erro(404, "Procedimento não encontrado.");
      return Response.json({ procedimento }, { status: id ? 200 : 201, headers });
    } catch (error) {
      if (error instanceof DadosProcedimentoInvalidos) return erro(400, error.message);
      return erro(500, "Não foi possível concluir a operação. Tente novamente.");
    }
  };
}
