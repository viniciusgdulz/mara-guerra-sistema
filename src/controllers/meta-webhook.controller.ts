import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SQL } from "bun";
import { receberEventosMeta, type EstadoEntrega, type EventoMeta } from "../services/meta-webhook.repository";
class ErroWebhook extends Error { constructor(message: string, public status: number) { super(message); } }
const objeto = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
export function assinaturaMetaValida(body: Uint8Array, assinatura: string | null, secret: string): boolean {
  if (!/^sha256=[a-f0-9]{64}$/i.test(assinatura ?? "")) return false;
  const esperado = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(esperado, Buffer.from(assinatura!.slice(7), "hex"));
}
export function extrairEventosMeta(dados: unknown, phoneNumberId: string, wabaId?: string) {
  const raiz = objeto(dados); const eventos: EventoMeta[] = []; let ignorados = 0, vistos = 0;
  if (raiz?.object !== "whatsapp_business_account" || !Array.isArray(raiz.entry)) return { eventos, ignorados: 1 };
  for (const rawEntry of raiz.entry) {
    const entry = objeto(rawEntry);
    if ((wabaId && entry?.id !== wabaId) || !Array.isArray(entry?.changes)) { ignorados++; continue; }
    for (const rawChange of entry.changes) {
      const change = objeto(rawChange), value = objeto(change?.value), metadata = objeto(value?.metadata);
      if (change?.field !== "messages" || value?.messaging_product !== "whatsapp" || metadata?.phone_number_id !== phoneNumberId || !Array.isArray(value.statuses)) { ignorados++; continue; }
      for (const raw of value.statuses) {
        if (++vistos > 100) throw new ErroWebhook("Quantidade de eventos excede o limite.", 413);
        const s = objeto(raw);
        if (!s || typeof s.id !== "string" || !/^wamid\.[^\s]{1,2048}$/.test(s.id) || !["sent", "delivered", "read", "failed"].includes(String(s.status))
          || typeof s.timestamp !== "string" || !/^[0-9]{1,12}$/.test(s.timestamp) || Number(s.timestamp) < 1 || Number(s.timestamp) > 253402300799) { ignorados++; continue; }
        const primeiroErro = Array.isArray(s.errors) ? objeto(s.errors[0]) : null;
        const code = primeiroErro?.code;
        const erroCodigo = typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 2147483647 ? code : null;
        const correlacao = typeof s.biz_opaque_callback_data === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.biz_opaque_callback_data) ? s.biz_opaque_callback_data : null;
        eventos.push({ wamid: s.id, estado: s.status as EstadoEntrega, ocorridoEm: new Date(Number(s.timestamp) * 1000), phoneNumberId, erroCodigo, correlacao });
      }
    }
  }
  return { eventos, ignorados };
}
export function criarMetaWebhookController(getDb: () => SQL, getEnv: () => Record<string, string | undefined> = () => Bun.env) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "no-store" };
    const erro = (status: number, message: string) => Response.json({ error: message }, { status, headers });
    try {
      if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, POST" } });
      const env = getEnv();
      if (request.method === "GET") {
        const token = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
        if (!token || token.length > 256) return erro(503, "Verificação de webhook não configurada.");
        const params = new URL(request.url).searchParams;
        for (const key of ["hub.mode", "hub.verify_token", "hub.challenge"]) if (params.getAll(key).length !== 1) return erro(400, "Parâmetros de verificação inválidos.");
        const recebido = params.get("hub.verify_token")!;
        const comparar = (v: string) => createHash("sha256").update(v).digest();
        if (params.get("hub.mode") !== "subscribe" || !timingSafeEqual(comparar(token), comparar(recebido))) return erro(403, "Verificação não autorizada.");
        const challenge = params.get("hub.challenge")!;
        if (!challenge || challenge.length > 1024 || /[\x00-\x1f\x7f]/.test(challenge)) return erro(400, "Challenge inválido.");
        return new Response(challenge, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
      }
      const secret = env.WHATSAPP_APP_SECRET, phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
      if (!secret || secret.length > 4096 || !phoneId || !/^\d{1,30}$/.test(phoneId)
        || (env.WHATSAPP_WABA_ID && !/^\d{1,30}$/.test(env.WHATSAPP_WABA_ID))) return erro(503, "Webhook não configurado.");
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
        || ![null, "identity"].includes(request.headers.get("content-encoding"))) return erro(415, "Envie JSON sem compressão.");
      const reader = request.body?.getReader(); if (!reader) return erro(400, "Corpo do webhook ausente.");
      const chunks: Uint8Array[] = []; let tamanho = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        tamanho += value.length;
        if (tamanho > 262144) { await reader.cancel(); return erro(413, "Webhook excede o limite de tamanho."); }
        chunks.push(value);
      }
      const raw = Buffer.concat(chunks);
      if (!assinaturaMetaValida(raw, request.headers.get("x-hub-signature-256"), secret)) return erro(401, "Assinatura inválida.");
      if (env.WHATSAPP_PERSISTENCE_ENABLED !== "true") return erro(503, "Persistência de webhooks desabilitada.");
      let dados: unknown;
      try { dados = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { return erro(400, "JSON inválido."); }
      const { eventos, ignorados } = extrairEventosMeta(dados, phoneId, env.WHATSAPP_WABA_ID);
      if (!eventos.length) return Response.json({ recebidos: 0, ignorados }, { headers });
      // Confirma o recebimento somente após commit do inbox/projeção.
      const result = await receberEventosMeta(getDb(), eventos);
      return Response.json({ recebidos: eventos.length, ignorados, ...result }, { headers });
    } catch (error) {
      if (error instanceof ErroWebhook) return erro(error.status, error.message);
      return erro(503, "Não foi possível persistir o webhook. Requer reconciliação ou nova entrega.");
    }
  };
}
