import type { SQL } from "bun";
import { lerToken, origemPermitida, temPerfil } from "../auth";
import { obterUsuario } from "../services/auth.service";
import { ErroAtendimento } from "../services/atendimentos.service";
import { listarProcedimentos } from "../services/procedimentos.service";
import { agendarRetorno, criarAgendamento, ErroAgenda, listarAgenda, listarRetornos, mudarStatus, objetoAgenda, reagendar } from "../services/agenda.service";
import { errorResponse } from "../http-error";

export function criarAgendaController(getDb: () => SQL, producao: boolean, origem?: string) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    const erro = (status: number, mensagem: string, extras?: Record<string, string>) => errorResponse(request, status, mensagem, { ...headers, ...extras });
    try {
      const url = new URL(request.url);
      const token = lerToken(request, producao);
      const usuario = token ? await obterUsuario(getDb(), token) : null;
      if (!usuario) return erro(401, "Entre na sua conta para continuar.");
      if (!temPerfil(usuario, ["administrador", "funcionario"])) return erro(403, "Você não tem permissão para esta operação.");
      const admin = temPerfil(usuario, ["administrador"]);
      const retornos = url.pathname === "/api/agenda/retornos";
      const retorno = url.pathname.match(/^\/api\/agenda\/retornos\/([^/]+)\/agendar$/);
      if ((retornos || retorno || url.pathname.startsWith("/api/agenda/retornos/")) && !admin) return erro(403, "Somente administradores podem consultar ou agendar sugestões de retorno.");
      const collection = url.pathname === "/api/agenda";
      const catalogo = url.pathname === "/api/agenda/procedimentos";
      const item = url.pathname.match(/^\/api\/agenda\/([^/]+)(\/status)?$/);
      const methods = collection ? ["GET", "POST"] : catalogo || retornos ? ["GET"] : retorno ? ["POST"] : item ? [item[2] ? "PATCH" : "PUT"] : [];
      if (!methods.length) return erro(404, "Não encontrado");
      if (!methods.includes(request.method)) return erro(405, "Método não permitido", { Allow: methods.join(", ") });
      if (request.method !== "GET" && !origemPermitida(request, origem, producao)) return erro(403, "Origem não permitida.");
      if (request.method === "GET") {
        const texto = url.searchParams.get("pagina") ?? "1";
        const pagina = Number(texto);
        const nome = (url.searchParams.get("nome") ?? "").trim();
        if (!/^[1-9]\d*$/.test(texto) || !Number.isSafeInteger(pagina) || pagina > 1000000 || nome.length > 150) return erro(400, "Pesquisa ou página inválida.");
        const chave = catalogo ? "procedimentos" : retornos ? "retornos" : "agendamentos";
        const rows = catalogo ? await listarProcedimentos(getDb(), nome, pagina, false)
          : retornos ? await listarRetornos(getDb(), url.searchParams.get("inicio") ?? "", url.searchParams.get("fim") ?? "", pagina)
          : await listarAgenda(getDb(), url.searchParams.get("data") ?? "", nome, pagina);
        return Response.json({ [chave]: rows.slice(0, 50), pagina, temMais: rows.length > 50 }, { headers });
      }
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return erro(415, "Envie os dados em JSON.");
      const reader = request.body?.getReader();
      if (!reader) return erro(400, "Dados do agendamento inválidos.");
      const chunks: Uint8Array[] = [];
      let tamanho = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        tamanho += value.length;
        if (tamanho > 4096) { await reader.cancel(); return erro(413, "Dados do agendamento muito grandes."); }
        chunks.push(value);
      }
      let dados: unknown;
      try { dados = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
      catch { return erro(400, "JSON inválido."); }
      if (item?.[2] && !collection && !catalogo && !retornos) {
        const d = objetoAgenda(dados, ["status"]);
        if (d.status === "realizado" && !admin) return erro(403, "Somente administradores podem concluir agendamentos.");
        return Response.json({ agendamento: await mudarStatus(getDb(), item[1]!, d.status) }, { headers });
      }
      const agendamento = retorno ? await agendarRetorno(getDb(), retorno[1]!, dados)
        : collection ? await criarAgendamento(getDb(), dados) : await reagendar(getDb(), item![1]!, dados);
      return Response.json({ agendamento }, { status: collection || retorno ? 201 : 200, headers });
    } catch (error) {
      if (error instanceof ErroAgenda || error instanceof ErroAtendimento) return erro(error.status, error.message);
      return erro(500, "Não foi possível concluir a operação. Tente novamente.");
    }
  };
}
