import type { SQL } from "bun";
import { lerToken, origemPermitida, temPerfil } from "../auth";
import { obterUsuario } from "../services/auth.service";
import { cadastrarPaciente, DadosPacienteInvalidos, listarPacientes } from "../services/pacientes.service";
import { errorResponse } from "../http-error";

export function criarPacientesController(getDb: () => SQL, producao: boolean, origem?: string) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    const erro = (status: number, mensagem: string, extras?: HeadersInit) => errorResponse(request, status, mensagem, { ...headers, ...extras });
    try {
      if (!["GET", "POST"].includes(request.method)) return erro(405, "Método não permitido", { Allow: "GET, POST" });
      if (request.method === "POST" && !origemPermitida(request, origem, producao)) return erro(403, "Origem não permitida.");
      const token = lerToken(request, producao);
      const usuario = token ? await obterUsuario(getDb(), token) : null;
      if (!usuario) return erro(401, "Entre na sua conta para continuar.");
      if (!temPerfil(usuario, ["administrador", "funcionario"])) return erro(403, "Você não tem permissão para esta operação.");
      if (new URL(request.url).pathname !== "/api/pacientes") return erro(404, "Não encontrado");
      if (request.method === "GET") {
        const params = new URL(request.url).searchParams;
        const busca = (params.get("nome") ?? "").trim();
        const paginaTexto = params.get("pagina") ?? "1";
        const pagina = Number(paginaTexto);
        if (busca.length > 150 || !/^[1-9]\d*$/.test(paginaTexto) || !Number.isSafeInteger(pagina) || pagina > 1000000) return erro(400, "Pesquisa ou página inválida.");
        const pacientes = await listarPacientes(getDb(), busca, pagina);
        return Response.json({ pacientes: pacientes.slice(0, 50), pagina, temMais: pacientes.length > 50 }, { headers });
      }
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return erro(415, "Envie os dados em JSON.");
      const reader = request.body?.getReader();
      if (!reader) return erro(400, "Dados do paciente inválidos.");
      const chunks: Uint8Array[] = [];
      let tamanho = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        tamanho += value.length;
        if (tamanho > 4096) { await reader.cancel(); return erro(413, "Dados do paciente muito grandes."); }
        chunks.push(value);
      }
      let dados: unknown;
      try { dados = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
      catch { return erro(400, "JSON inválido."); }
      return Response.json({ paciente: await cadastrarPaciente(getDb(), dados) }, { status: 201, headers });
    } catch (error) {
      if (error instanceof DadosPacienteInvalidos) return erro(400, error.message);
      return erro(500, "Não foi possível concluir a operação. Tente novamente.");
    }
  };
}
