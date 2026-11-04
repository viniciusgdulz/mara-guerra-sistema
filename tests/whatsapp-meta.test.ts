import { describe, expect, mock, test } from "bun:test";
import { criarProvedorMeta, criarProvedorMetaDoAmbiente, ErroWhatsAppMeta, type ConfiguracaoMeta, type MensagemTemplateMeta } from "../src/integrations/whatsapp-meta";
import { provedorSimulado, type ProvedorWhatsApp } from "../src/integrations/whatsapp";
import { simularNotificacao } from "../src/services/notificacoes.service";
import type { SQL } from "bun";
const config = { token: "token-ficticio-exclusivo-de-teste", phoneNumberId: "123456789012345", graphApiVersion: "v23.0", timeoutMs: 1000 };
const mensagem = { destinatario: "5511999990000", nome: "lembrete_horario", idioma: "pt_BR", parametros: ["Pessoa Teste", "03/11/2026", "14:30"] };
const sucesso = () => Response.json({ messaging_product: "whatsapp", contacts: [{ wa_id: mensagem.destinatario }], messages: [{ id: "wamid.teste123" }] });
function transporte(fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const http = mock(fn);
  return { http, fetch: http as unknown as typeof fetch };
}
async function erroDa(promessa: Promise<unknown>): Promise<ErroWhatsAppMeta> {
  try { await promessa; } catch (error) { expect(error).toBeInstanceOf(ErroWhatsAppMeta); return error as ErroWhatsAppMeta; }
  throw new Error("Esperava erro");
}
describe("Cliente Meta isolado com transporte simulado", () => {
  test("envia POST ao endpoint oficial com Bearer e template e retorna wamid", async () => {
    const t = transporte(async () => sucesso()); const p = criarProvedorMeta(config, t.fetch);
    expect(t.http).not.toHaveBeenCalled(); expect(p.modo).toBe("real");
    expect(await p.enviarTemplate(mensagem)).toEqual({ messageId: "wamid.teste123", status: "aceita" });
    expect(t.http).toHaveBeenCalledTimes(1);
    const [url, init] = t.http.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v23.0/123456789012345/messages");
    expect(init?.method).toBe("POST"); expect(init?.headers).toEqual({ Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" });
    expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: mensagem.destinatario, type: "template", template: {
      name: mensagem.nome, language: { code: "pt_BR" }, components: [{ type: "body", parameters: mensagem.parametros.map(text => ({ type: "text", text })) }],
    } });
    expect(String(url)).not.toContain(config.token); expect(String(init?.body)).not.toContain(config.token);
    expect(JSON.stringify(p)).not.toContain(config.token);
  });
  test("template sem parâmetros aceita outro idioma e omite components", async () => {
    const t = transporte(async () => sucesso());
    await criarProvedorMeta(config, t.fetch).enviarTemplate({ destinatario: mensagem.destinatario, nome: "hello_world", idioma: "en_US" });
    expect(JSON.parse(String(t.http.mock.calls[0]![1]?.body)).template).toEqual({ name: "hello_world", language: { code: "en_US" } });
  });
  test("configuração capturada não muda se o objeto original for alterado", async () => {
    const t = transporte(async () => sucesso()); const original = { ...config }; const p = criarProvedorMeta(original, t.fetch);
    original.token = "outro-token"; original.phoneNumberId = "000";
    await p.enviarTemplate(mensagem);
    expect(t.http.mock.calls[0]![0]).toContain(config.phoneNumberId);
    expect(t.http.mock.calls[0]![1]?.headers).toHaveProperty("Authorization", `Bearer ${config.token}`);
  });
  test("lê variáveis explicitamente, sem requisição ao criar o provedor", async () => {
    const t = transporte(async () => sucesso());
    const p = criarProvedorMetaDoAmbiente({ WHATSAPP_ACCESS_TOKEN: config.token, WHATSAPP_PHONE_NUMBER_ID: "987654321", WHATSAPP_GRAPH_API_VERSION: "v24.0", WHATSAPP_TIMEOUT_MS: "1000" }, t.fetch);
    expect(t.http).not.toHaveBeenCalled(); await p.enviarTemplate(mensagem);
    expect(t.http.mock.calls[0]![0]).toBe("https://graph.facebook.com/v24.0/987654321/messages");
  });
  test.each([
    { ...config, token: "" }, { ...config, token: "token\r\nsecreto" }, { ...config, phoneNumberId: "../messages" },
    { ...config, graphApiVersion: "https://externo.example" }, { ...config, graphApiVersion: "v23.0?token=x" },
    { ...config, timeoutMs: 0 }, { ...config, timeoutMs: 1.5 }, { ...config, timeoutMs: 120001 },
  ])("configuração inválida não inicia HTTP: %j", dados => {
    const t = transporte(async () => sucesso());
    expect(() => criarProvedorMeta(dados, t.fetch)).toThrow(ErroWhatsAppMeta); expect(t.http).not.toHaveBeenCalled();
  });
  test.each([{}, { WHATSAPP_TIMEOUT_MS: "1e3" }, { WHATSAPP_TIMEOUT_MS: "-1" }, { WHATSAPP_TIMEOUT_MS: "" }])("variáveis ausentes ou timeout inválido: %j", env => {
    const t = transporte(async () => sucesso()); expect(() => criarProvedorMetaDoAmbiente(env, t.fetch)).toThrow(); expect(t.http).not.toHaveBeenCalled();
  });
  test.each([
    { ...mensagem, destinatario: "+5511999990000" }, { ...mensagem, destinatario: "" }, { ...mensagem, nome: "Nome inválido" },
    { ...mensagem, idioma: "" }, { ...mensagem, parametros: [" "] }, { ...mensagem, parametros: [123] }, { ...mensagem, parametros: "texto" },
    { ...mensagem, parametros: Array<string>(1) },
  ])("rejeita entrada inválida antes de HTTP: %j", async dados => {
    const t = transporte(async () => sucesso());
    const error = await erroDa(criarProvedorMeta(config, t.fetch).enviarTemplate(dados as MensagemTemplateMeta));
    expect(error.categoria).toBe("validacao"); expect(t.http).not.toHaveBeenCalled();
  });
  test.each([
    { status: 401, code: undefined, categoria: "autenticacao" }, { status: 403, code: 10, categoria: "autenticacao" },
    { status: 400, code: 190, categoria: "autenticacao" }, { status: 400, code: 102, categoria: "autenticacao" },
    { status: 400, code: 130497, categoria: "restricao_meta" }, { status: 403, code: 130497, categoria: "restricao_meta" },
    { status: 429, code: 130429, categoria: "limite" }, { status: 400, code: 132001, categoria: "api" },
    { status: 500, code: 131000, categoria: "api" }, { status: 200, code: 130497, categoria: "restricao_meta" },
  ])("classifica HTTP $status / Meta $code como $categoria sem vazar corpo", async caso => {
    const t = transporte(async () => Response.json({ error: { code: caso.code, error_subcode: 42, message: `${config.token} ${mensagem.destinatario}`, error_data: { details: "segredo" }, fbtrace_id: "dado-interno" } }, { status: caso.status }));
    const error = await erroDa(criarProvedorMeta(config, t.fetch).enviarTemplate(mensagem));
    expect(error.categoria).toBe(caso.categoria); expect(error.statusHttp).toBe(caso.status); expect(error.codigoMeta).toBe(caso.code); expect(error.subcodigoMeta).toBe(42);
    expect(error.resultadoIncerto).toBe(caso.status >= 500);
    for (const segredo of [config.token, mensagem.destinatario, "segredo", "dado-interno"]) expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain(segredo);
    expect(error).not.toHaveProperty("cause"); expect(t.http).toHaveBeenCalledTimes(1);
  });
  test.each([400, 502, 302])("HTTP %s com corpo não JSON usa erro seguro e não repete", async status => {
    const t = transporte(async () => new Response(`<html>${config.token}</html>`, { status }));
    const error = await erroDa(criarProvedorMeta(config, t.fetch).enviarTemplate(mensagem));
    expect(error.categoria).toBe("http"); expect(error.statusHttp).toBe(status); expect(String(error)).not.toContain(config.token); expect(t.http).toHaveBeenCalledTimes(1);
  });
  test.each([{}, { messaging_product: "whatsapp", messages: [] }, { messaging_product: "whatsapp", messages: [{ id: "" }] },
    { messaging_product: "whatsapp", messages: [{ id: "outro-id" }] }, { messaging_product: "outro", messages: [{ id: "wamid.teste" }] },
  ])("sucesso HTTP com resposta inválida é incerto: %j", async dados => {
    const t = transporte(async () => Response.json(dados));
    const error = await erroDa(criarProvedorMeta(config, t.fetch).enviarTemplate(mensagem));
    expect(error.categoria).toBe("resposta_invalida"); expect(error.resultadoIncerto).toBe(true); expect(t.http).toHaveBeenCalledTimes(1);
  });
  test("sucesso HTTP com JSON quebrado é resposta inválida e não confirmação", async () => {
    const t = transporte(async () => new Response("{"));
    expect((await erroDa(criarProvedorMeta(config, t.fetch).enviarTemplate(mensagem))).categoria).toBe("resposta_invalida");
  });
  test("erro de rede não propaga mensagem bruta ou credenciais e não repete", async () => {
    const t = transporte(async () => { throw new Error(`falhou ${config.token} ${mensagem.destinatario}`); });
    const error = await erroDa(criarProvedorMeta(config, t.fetch).enviarTemplate(mensagem));
    expect(error.categoria).toBe("rede"); expect(error.resultadoIncerto).toBe(true); expect(error.stack).not.toContain(config.token); expect(t.http).toHaveBeenCalledTimes(1);
  });
  test("timeout aborta requisição mesmo se mock ignorar AbortSignal", async () => {
    const t = transporte(async () => new Promise<Response>(() => {}));
    const error = await erroDa(criarProvedorMeta({ ...config, timeoutMs: 5 }, t.fetch).enviarTemplate(mensagem));
    expect(error.categoria).toBe("timeout"); expect(error.resultadoIncerto).toBe(true);
    expect(t.http.mock.calls[0]![1]?.signal?.aborted).toBe(true); expect(t.http).toHaveBeenCalledTimes(1);
  });
  test("timeout também cobre resposta com corpo que não termina", async () => {
    const t = transporte(async () => ({ ok: true, status: 200, json: async () => new Promise(() => {}) }) as Response);
    const error = await erroDa(criarProvedorMeta({ ...config, timeoutMs: 5 }, t.fetch).enviarTemplate(mensagem));
    expect(error.categoria).toBe("timeout"); expect(t.http.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });
  test("cliente real não é aceito pelo fluxo simulado existente", async () => {
    const t = transporte(async () => sucesso()); const db = mock(() => { throw new Error("Não abrir banco"); });
    const provider = criarProvedorMeta(config, t.fetch);
    await expect(simularNotificacao(db as unknown as SQL, "00000000-0000-4000-8000-000000000001", provider as unknown as ProvedorWhatsApp)).rejects.toThrow("Envios reais estão desativados");
    expect(db).not.toHaveBeenCalled(); expect(t.http).not.toHaveBeenCalled();
    expect(provedorSimulado.modo).toBe("simulado"); expect(provedorSimulado).not.toHaveProperty("enviarTemplate");
  });
});

test("correlação opaca inclui somente UUID de notificação no payload e recusa texto livre", async () => {
  const t = transporte(async () => sucesso()); const provider = criarProvedorMeta(config, t.fetch);
  const correlacao = "00000000-0000-4000-8000-000000000001";
  await provider.enviarTemplate({ ...mensagem, correlacao });
  expect(JSON.parse(String(t.http.mock.calls[0]![1]?.body)).biz_opaque_callback_data).toBe(correlacao);
  await expect(provider.enviarTemplate({ ...mensagem, correlacao: "conteúdo sensível" })).rejects.toThrow();
  expect(t.http).toHaveBeenCalledTimes(1);
});
