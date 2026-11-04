import type { SQL } from "bun";
import { lerToken, origemPermitida, temPerfil } from "../auth";
import { obterUsuario } from "../services/auth.service";
import { alterarConsentimento, ErroConsentimento, obterConsentimento } from "../services/consentimento.service";
import { ErroAtendimento } from "../services/atendimentos.service";
import { errorResponse } from "../http-error";
import { lerJsonLimitado } from "../json-body";
export function criarConsentimentoController(getDb: () => SQL, producao: boolean, origem?: string) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    const erro = (status: number, mensagem: string, extras?: Record<string, string>) => errorResponse(request, status, mensagem, { ...headers, ...extras });
    try {
      const token = lerToken(request, producao);
      const usuario = token ? await obterUsuario(getDb(), token) : null;
      if (!usuario) return erro(401, "Entre na sua conta para continuar.");
      if (!temPerfil(usuario, ["administrador", "funcionario"])) return erro(403, "Acesso não permitido.");
      const match = new URL(request.url).pathname.match(/^\/api\/pacientes\/([^/]+)\/consentimento-whatsapp$/);
      if (!match) return erro(404, "Não encontrado");
      if (!["GET", "PATCH"].includes(request.method)) return erro(405, "Método não permitido", { Allow: "GET, PATCH" });
      if (request.method === "PATCH" && !origemPermitida(request, origem, producao)) return erro(403, "Origem não permitida.");
      const consentimento = request.method === "GET" ? await obterConsentimento(getDb(), match[1]!) : await alterarConsentimento(getDb(), match[1]!, await lerJsonLimitado(request));
      return Response.json({ consentimento }, { headers });
    } catch (error) {
      if (error instanceof ErroConsentimento || error instanceof ErroAtendimento) return erro(error.status, error.message);
      return erro(500, "Não foi possível concluir a operação. Tente novamente.");
    }
  };
}
