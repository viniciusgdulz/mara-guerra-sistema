import type { SQL } from "bun";
import { lerToken, origemPermitida, temPerfil } from "../auth";
import { obterUsuario } from "../services/auth.service";
import { ErroAtendimento } from "../services/atendimentos.service";
import { cancelarNotificacao, ErroNotificacao, gerarNotificacoes, listarNotificacoes, simularNotificacao, processarNotificacao, reconciliarNotificacoesMeta } from "../services/notificacoes.service";
import { descreverCanal, ErroSelecaoWhatsApp, selecionarProvedorWhatsApp, type CanalNotificacoes } from "../integrations/whatsapp-provider";
import { errorResponse } from "../http-error";
import { lerJsonLimitado } from "../json-body";
export function criarNotificacoesController(getDb: () => SQL, producao: boolean, origem?: string, getCanal: () => CanalNotificacoes = () => selecionarProvedorWhatsApp()) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    const erro = (status: number, mensagem: string, extras?: Record<string, string>) => errorResponse(request, status, mensagem, { ...headers, ...extras });
    try {
      const token = lerToken(request, producao);
      const usuario = token ? await obterUsuario(getDb(), token) : null;
      if (!usuario) return erro(401, "Entre na sua conta para continuar.");
      if (!temPerfil(usuario, ["administrador"])) return erro(403, "Somente administradores podem acessar notificações.");
      const url = new URL(request.url);
      const consulta = url.pathname === "/api/notificacoes";
      const gerar = url.pathname === "/api/notificacoes/gerar";
      const reconciliar = url.pathname === "/api/notificacoes/reconciliar";
      const acao = url.pathname.match(/^\/api\/notificacoes\/([^/]+)\/(simular|processar|cancelar)$/);
      if (!consulta && !gerar && !reconciliar && !acao) return erro(404, "Não encontrado");
      const metodo = consulta ? "GET" : "POST";
      if (request.method !== metodo) return erro(405, "Método não permitido", { Allow: metodo });
      if (consulta) {
        const texto = url.searchParams.get("pagina") ?? "1";
        const pagina = Number(texto);
        const status = url.searchParams.get("status") || null;
        if (!/^[1-9]\d*$/.test(texto) || !Number.isSafeInteger(pagina) || pagina > 1000000 || (status && !["pendente", "enviada", "cancelada", "falhou"].includes(status))) return erro(400, "Status ou página inválida.");
        const rows = await listarNotificacoes(getDb(), status, pagina);
        return Response.json({ notificacoes: rows.slice(0, 50), pagina, temMais: rows.length > 50, modo: "simulado", processamento: descreverCanal(getCanal()) }, { headers });
      }
      if (!origemPermitida(request, origem, producao)) return erro(403, "Origem não permitida.");
      const dados = await lerJsonLimitado(request);
      if (!dados || typeof dados !== "object" || Array.isArray(dados) || Object.keys(dados).length) return erro(400, "Envie um objeto JSON vazio; o servidor controla status e datas.");
      if (reconciliar && !getCanal().persistenciaHabilitada) return erro(409, "Habilite a persistência somente após validar as migrações em banco isolado.");
      const resultado = reconciliar ? await reconciliarNotificacoesMeta(getDb()) : gerar ? await gerarNotificacoes(getDb()) : acao![2] === "simular" ? await simularNotificacao(getDb(), acao![1]!)
        : acao![2] === "processar" ? await processarNotificacao(getDb(), acao![1]!, getCanal()) : await cancelarNotificacao(getDb(), acao![1]!);
      return Response.json(resultado, { headers });
    } catch (error) {
      if (error instanceof ErroNotificacao || error instanceof ErroAtendimento) return erro(error.status, error.message);
      if (error instanceof ErroSelecaoWhatsApp) return erro(400, error.message);
      return erro(500, "Não foi possível concluir a operação. Tente novamente.");
    }
  };
}
