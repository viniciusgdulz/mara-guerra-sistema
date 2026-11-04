/** Cliente de transporte isolado. Não é usado pelas rotas da Fase 9. */
export type ConfiguracaoMeta = {
  token: string;
  phoneNumberId: string;
  graphApiVersion: string;
  timeoutMs?: number;
};
export type MensagemTemplateMeta = {
  destinatario: string;
  nome: string;
  idioma: string;
  /** Parâmetros posicionais de texto do corpo, na ordem do template aprovado. */
  parametros?: readonly string[];
  correlacao?: string;
};
export type CategoriaErroMeta = "configuracao" | "validacao" | "autenticacao" | "restricao_meta" | "limite" | "http" | "api" | "timeout" | "rede" | "resposta_invalida";
export class ErroWhatsAppMeta extends Error {
  constructor(
    public readonly categoria: CategoriaErroMeta,
    mensagem: string,
    public readonly statusHttp?: number,
    public readonly codigoMeta?: number,
    public readonly subcodigoMeta?: number,
    /** Não repetir automaticamente: pode haver aceitação sem resposta confirmada. */
    public readonly resultadoIncerto = false,
  ) { super(mensagem); this.name = "ErroWhatsAppMeta"; }
}
export interface ProvedorMeta {
  readonly modo: "real";
  enviarTemplate(mensagem: MensagemTemplateMeta): Promise<{ messageId: string; status: "aceita" }>;
}
type Objeto = Record<string, unknown>;
const objeto = (valor: unknown): Objeto | null => valor !== null && typeof valor === "object" && !Array.isArray(valor) ? valor as Objeto : null;
const codigo = (valor: unknown): number | undefined => typeof valor === "number" && Number.isSafeInteger(valor) && valor >= 0 ? valor : undefined;
function validarConfiguracao(config: ConfiguracaoMeta) {
  if (!config || typeof config.token !== "string" || !config.token || config.token.length > 8192 || /\s/.test(config.token)
    || typeof config.phoneNumberId !== "string" || !/^\d{1,30}$/.test(config.phoneNumberId)
    || typeof config.graphApiVersion !== "string" || !/^v[1-9]\d*\.\d+$/.test(config.graphApiVersion)) {
    throw new ErroWhatsAppMeta("configuracao", "Configure token, Phone Number ID numérico e versão Graph API válida (vN.N).");
  }
  const timeout = config.timeoutMs ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new ErroWhatsAppMeta("configuracao", "Timeout WhatsApp deve ser inteiro entre 1 e 120000 ms.");
  return timeout;
}
function montarPayload(mensagem: MensagemTemplateMeta) {
  if (!mensagem || typeof mensagem.destinatario !== "string" || !/^[1-9]\d{7,14}$/.test(mensagem.destinatario)
    || typeof mensagem.nome !== "string" || !/^[a-z0-9_]{1,512}$/.test(mensagem.nome)
    || typeof mensagem.idioma !== "string" || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(mensagem.idioma)
    || (mensagem.parametros !== undefined && (!Array.isArray(mensagem.parametros) || Array.from(mensagem.parametros).some(p => typeof p !== "string" || !p.trim() || p.length > 32768)))
    || (mensagem.correlacao !== undefined && (typeof mensagem.correlacao !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mensagem.correlacao)))) {
    throw new ErroWhatsAppMeta("validacao", "Informe destinatário internacional sem pontuação, nome/idioma do template e parâmetros de texto válidos.");
  }
  return {
    messaging_product: "whatsapp", recipient_type: "individual", to: mensagem.destinatario, type: "template",
    ...(mensagem.correlacao ? { biz_opaque_callback_data: mensagem.correlacao } : {}),
    template: { name: mensagem.nome, language: { code: mensagem.idioma },
      ...(mensagem.parametros?.length ? { components: [{ type: "body", parameters: mensagem.parametros.map(text => ({ type: "text", text })) }] } : {}),
    },
  };
}
function erroResposta(status: number, detalhe: Objeto | null): ErroWhatsAppMeta {
  const code = codigo(detalhe?.code), subcode = codigo(detalhe?.error_subcode);
  if (code === 130497) return new ErroWhatsAppMeta("restricao_meta", "A Meta recusou a mensagem com o código 130497. Confira as restrições da conta e do país de destino no suporte da Meta.", status, code, subcode);
  if (status === 401 || code === 190 || code === 102) return new ErroWhatsAppMeta("autenticacao", "A Meta recusou a autenticação. Confira o token e suas permissões.", status, code, subcode);
  if (status === 403) return new ErroWhatsAppMeta("autenticacao", "A Meta não autorizou esta operação. Confira as permissões da conta e do número.", status, code, subcode);
  if (status === 429) return new ErroWhatsAppMeta("limite", "A Meta limitou as requisições. Nenhuma nova tentativa foi realizada.", status, code, subcode);
  return new ErroWhatsAppMeta(detalhe ? "api" : "http", "A Meta não confirmou a aceitação da mensagem. Confira o status HTTP e o código de erro.", status, code, subcode, status >= 500);
}
/** Criar o cliente não faz requisições. Somente enviarTemplate inicia comunicação. */
export function criarProvedorMeta(config: ConfiguracaoMeta, http: typeof fetch = globalThis.fetch): ProvedorMeta {
  const timeoutMs = validarConfiguracao(config);
  // Captura valores validados; alterações posteriores no objeto não mudam o destino/token.
  const token = config.token;
  const endpoint = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
  return Object.freeze({ modo: "real" as const,
    async enviarTemplate(mensagem: MensagemTemplateMeta) {
      const body = JSON.stringify(montarPayload(mensagem));
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // O prazo cobre tanto fetch quanto leitura do corpo, inclusive em transportes injetados.
        const expiracao = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ErroWhatsAppMeta("timeout", "Tempo limite ao comunicar com a Meta. A aceitação é incerta; não repita o envio automaticamente.", undefined, undefined, undefined, true));
            controller.abort();
          }, timeoutMs);
        });
        const operacao = async () => {
          const response = await http(endpoint, {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
            signal: controller.signal, redirect: "error", credentials: "omit",
          });
          let dados: unknown;
          try { dados = await response.json(); }
          catch (error) { if (!(error instanceof SyntaxError)) throw error; }
          const resultado = objeto(dados), detalhe = objeto(resultado?.error);
          if (!response.ok || detalhe) throw erroResposta(response.status, detalhe);
          const messages = resultado?.messages;
          const messageId = Array.isArray(messages) && messages.length === 1 ? objeto(messages[0])?.id : undefined;
          if (resultado?.messaging_product !== "whatsapp" || typeof messageId !== "string" || !/^wamid\.[^\s]{1,2048}$/.test(messageId)) {
            throw new ErroWhatsAppMeta("resposta_invalida", "Resposta da Meta sem identificador de mensagem válido. A aceitação é incerta; não repita automaticamente.", response.status, undefined, undefined, true);
          }
          return { messageId, status: "aceita" as const };
        };
        return await Promise.race([operacao(), expiracao]);
      } catch (error) {
        if (error instanceof ErroWhatsAppMeta) throw error;
        // Não propaga erro bruto, causa, payload, URL de transporte ou corpo da resposta.
        throw new ErroWhatsAppMeta("rede", "Falha de comunicação com a Meta. A aceitação é incerta; não repita o envio automaticamente.", undefined, undefined, undefined, true);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
  });
}
/** Leitura explícita do ambiente; não existe seleção automática de provedor no aplicativo. */
export function criarProvedorMetaDoAmbiente(env: Record<string, string | undefined> = Bun.env, http: typeof fetch = globalThis.fetch): ProvedorMeta {
  const textoTimeout = env.WHATSAPP_TIMEOUT_MS;
  if (textoTimeout !== undefined && !/^[1-9]\d*$/.test(textoTimeout)) throw new ErroWhatsAppMeta("configuracao", "WHATSAPP_TIMEOUT_MS deve ser um inteiro positivo.");
  return criarProvedorMeta({ token: env.WHATSAPP_ACCESS_TOKEN ?? "", phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION ?? "", ...(textoTimeout !== undefined ? { timeoutMs: Number(textoTimeout) } : {}) }, http);
}
