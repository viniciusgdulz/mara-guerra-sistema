import { provedorSimulado, type ProvedorWhatsApp, type WhatsAppPayload } from "./whatsapp";
import { criarProvedorMetaDoAmbiente, type MensagemTemplateMeta, type ProvedorMeta } from "./whatsapp-meta";
export class ErroSelecaoWhatsApp extends Error {}
export type ResultadoCanal =
  | { estado: "simulado" }
  | { estado: "aceita"; messageId: string }
  | { estado: "bloqueado"; motivo: "envio_desabilitado" | "etapa2"; mensagem: string };
export interface CanalNotificacoes {
  readonly provedor: "simulado" | "meta";
  readonly envioRealHabilitado: boolean;
  readonly persistenciaHabilitada?: boolean;
  processar(payload: WhatsAppPayload): Promise<ResultadoCanal>;
}
export function canalSimulado(provedor: ProvedorWhatsApp = provedorSimulado): CanalNotificacoes {
  return Object.freeze({ provedor: "simulado" as const, envioRealHabilitado: false,
    async processar(payload: WhatsAppPayload): Promise<ResultadoCanal> {
      if (provedor.modo !== "simulado") throw new ErroSelecaoWhatsApp("O canal de simulação exige provedor simulado.");
      const result = await provedor.preparar(payload);
      if (result.simulado !== true) throw new ErroSelecaoWhatsApp("Resultado incompatível com simulação.");
      return { estado: "simulado" };
    },
  });
}
class EnvioBloqueado extends Error {
  constructor(public readonly motivo: "envio_desabilitado" | "etapa2", message: string) { super(message); }
}
// Bloqueio de produto desta etapa: não existe variável, argumento HTTP ou flag que o remova.
function exigirLiberacaoReal(habilitado: boolean): void {
  if (!habilitado) throw new EnvioBloqueado("envio_desabilitado", "Envio real desabilitado. Nenhuma chamada à Meta foi realizada.");
  throw new EnvioBloqueado("etapa2", "Envio real bloqueado na Etapa 3, mesmo com habilitação configurada. Nenhuma chamada à Meta foi realizada.");
}
function converterTemplate(payload: WhatsAppPayload): MensagemTemplateMeta {
  return { destinatario: payload.to, nome: payload.template.name, idioma: payload.template.language.code,
    parametros: payload.template.components.flatMap(c => c.parameters.map(p => p.text)), correlacao: payload.biz_opaque_callback_data };
}
export function selecionarProvedorWhatsApp(
  env: Record<string, string | undefined> = Bun.env,
  criarMeta: () => ProvedorMeta = () => criarProvedorMetaDoAmbiente(env),
): CanalNotificacoes {
  const nome = env.WHATSAPP_PROVIDER ?? "simulado";
  const flag = env.WHATSAPP_REAL_SEND_ENABLED ?? "false";
  const persistencia = env.WHATSAPP_PERSISTENCE_ENABLED ?? "false";
  if (!["simulado", "meta"].includes(nome)) throw new ErroSelecaoWhatsApp("WHATSAPP_PROVIDER deve ser simulado ou meta.");
  if (!["true", "false"].includes(flag)) throw new ErroSelecaoWhatsApp("WHATSAPP_REAL_SEND_ENABLED deve ser true ou false.");
  if (!["true", "false"].includes(persistencia)) throw new ErroSelecaoWhatsApp("WHATSAPP_PERSISTENCE_ENABLED deve ser true ou false.");
  if (nome === "simulado") return Object.freeze({ ...canalSimulado(), persistenciaHabilitada: persistencia === "true" });
  const habilitado = flag === "true";
  return Object.freeze({ provedor: "meta" as const, envioRealHabilitado: habilitado, persistenciaHabilitada: persistencia === "true",
    async processar(payload: WhatsAppPayload): Promise<ResultadoCanal> {
      try {
        exigirLiberacaoReal(habilitado);
        // Conexão com o cliente da Etapa 1. Inalcançável enquanto vigorar o bloqueio acima.
        // A liberação futura exige antes reserva persistida/commit e reconciliação de incerteza.
        const resposta = await criarMeta().enviarTemplate(converterTemplate(payload));
        return { estado: "aceita", messageId: resposta.messageId };
      } catch (error) {
        if (error instanceof EnvioBloqueado) return { estado: "bloqueado", motivo: error.motivo, mensagem: error.message };
        throw error;
      }
    },
  });
}
export function descreverCanal(canal: CanalNotificacoes) {
  return { provedor: canal.provedor, envio_real_habilitado: canal.envioRealHabilitado, persistencia_habilitada: canal.persistenciaHabilitada === true, chamadas_externas_bloqueadas: true, etapa: 3 };
}
