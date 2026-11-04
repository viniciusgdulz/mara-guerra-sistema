import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { createHmac } from "node:crypto";
import { criarMetaWebhookController, assinaturaMetaValida, extrairEventosMeta } from "../src/controllers/meta-webhook.controller";
import { processarNotificacao, reconciliarNotificacoesMeta } from "../src/services/notificacoes.service";
import { receberEventosMeta, deveAvancarEntrega, type EventoMeta, type EstadoEntrega } from "../src/services/meta-webhook.repository";
import { registrarAceitacaoMeta } from "../src/services/notificacoes-meta.repository";
import { selecionarProvedorWhatsApp, type CanalNotificacoes } from "../src/integrations/whatsapp-provider";
import { ErroWhatsAppMeta } from "../src/integrations/whatsapp-meta";
import { handleRequest } from "../src/app";
import { criarNotificacoesController } from "../src/controllers/notificacoes.controller";
const id = "00000000-0000-4000-8000-000000000001";
const agora = new Date("2026-11-03T12:00:00Z");
const phoneId = "123456789012345";
const wamid = "wamid.teste-etapa3";
const env = { WHATSAPP_APP_SECRET: "secret-ficticio-para-testes", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-ficticio", WHATSAPP_PHONE_NUMBER_ID: phoneId, WHATSAPP_PERSISTENCE_ENABLED: "true" };
// Modelo transacional usado exclusivamente pelos testes; nunca cria uma conexão SQL.
type Row = Record<string, any>;
function bancoSimulado() {
  let n: Row = { id, paciente_id: id, tipo: "lembrete_agendamento", status: "pendente", previsao_envio: agora, data_envio: null,
    nome: "Pessoa Teste", telefone: "11999990000", consentimento_whatsapp: true, consentimento_whatsapp_em: agora,
    data_hora: new Date("2026-11-04T15:00:00Z"), agendamento_status: "pendente", data_retorno_sugerida: null,
    procedimento_ativo: null, retorno_agendado: false, meta_estado: "nao_iniciado", meta_wamid: null, meta_entrega_estado: "nao_confirmada" };
  let ledger: Row[] = [], lock = Promise.resolve();
  const state = { inTx: false, commits: 0, failFinalize: false, failCommitAt: null as number | null, sql: [] as string[] };
  const query = async (strings: TemplateStringsArray, ...v: any[]): Promise<Row[]> => {
    const sql = strings.join("?").replace(/\s+/g, " "); state.sql.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("FROM notificacoes n JOIN pacientes")) return [{ ...n }];
    if (sql.includes("meta_estado = 'reservado', meta_tentativa_em")) {
      if (n.meta_estado !== "nao_iniciado" || !["pendente", "falhou"].includes(n.status) || n.previsao_envio > v[4]) return [];
      Object.assign(n, { meta_estado: "reservado", meta_tentativa_em: v[0], meta_tentativa_id: v[1], meta_reserva_expira_em: v[2] }); return [{ id }];
    }
    if (sql.includes("SET meta_estado = 'bloqueado'")) {
      if (state.failFinalize) throw new Error("falha simulada de armazenamento");
      if (n.meta_tentativa_id !== v[1] || !["reservado", "incerto"].includes(n.meta_estado)) return [];
      n.meta_estado = "bloqueado"; return [{ id }];
    }
    if (sql.includes("SET meta_estado = 'aceita'")) {
      if (state.failFinalize) throw new Error("falha simulada de armazenamento");
      const correlacao = sql.includes("meta_tentativa_em <=");
      const permitido = correlacao ? v[2] === id && ["reservado", "incerto"].includes(n.meta_estado) && !n.meta_wamid && n.meta_tentativa_em <= new Date(v[3].getTime() + 300000)
        : (v[3] === null || n.meta_tentativa_id === v[3]) && (["reservado", "incerto"].includes(n.meta_estado) || (n.meta_estado === "aceita" && n.meta_wamid === v[0]));
      if (!permitido) return [];
      Object.assign(n, { meta_estado: "aceita", meta_wamid: v[0], meta_aceita_em: n.meta_aceita_em ?? v[1] }); return [{ ...n }];
    }
    if (sql.includes("SET meta_estado = ?, meta_falha_codigo")) {
      if (n.meta_estado !== "reservado" || (v[3] !== null && v[3] !== n.meta_tentativa_id)) return [];
      n.meta_estado = v[0]; n.meta_falha_codigo = v[1]; return [{ id }];
    }
    if (sql.includes("SELECT meta_estado FROM notificacoes")) return ["aceita", "incerto"].includes(n.meta_estado) ? [{ meta_estado: n.meta_estado }] : [];
    if (sql.includes("SET meta_estado = 'incerto'")) {
      if (n.meta_estado === "reservado" && n.meta_reserva_expira_em <= v[0]) { n.meta_estado = "incerto"; return [{ id }]; } return [];
    }
    if (sql.includes("SELECT DISTINCT e.meta_wamid")) return ledger.some(e => e.meta_wamid === n.meta_wamid && !e.aplicado_em) ? [{ meta_wamid: n.meta_wamid }] : [];
    if (sql.includes("INSERT INTO meta_webhook_eventos")) {
      if (ledger.some(e => e.phone_number_id === v[0] && e.meta_wamid === v[1] && e.estado === v[2] && e.ocorrido_em.getTime() === v[3].getTime())) return [];
      const e = { id: `evento-${ledger.length}`, phone_number_id: v[0], meta_wamid: v[1], estado: v[2], ocorrido_em: v[3], erro_codigo: v[4], correlacao: v[5], aplicado_em: null }; ledger.push(e); return [{ id: e.id }];
    }
    if (sql.includes("FROM notificacoes WHERE meta_wamid")) return n.meta_wamid === v[0] && n.meta_estado === "aceita" ? [{ ...n }] : [];
    if (sql.includes("FROM meta_webhook_eventos")) return ledger.filter(e => e.meta_wamid === v[0] && !e.aplicado_em).sort((a, b) => a.ocorrido_em - b.ocorrido_em).map(e => ({ ...e }));
    if (sql.includes("SET meta_entrega_estado")) {
      const [estado, data, code] = v;
      Object.assign(n, { meta_entrega_estado: estado, meta_entrega_em: data, meta_entrega_erro: code });
      if (n.status !== "cancelada") { n.status = estado === "failed" ? "falhou" : "enviada"; n.data_envio = estado === "failed" ? null : n.data_envio ?? data; }
      return [];
    }
    if (sql.includes("UPDATE meta_webhook_eventos")) {
      Object.assign(ledger.find(e => e.id === v[2])!, { notificacao_id: v[0], aplicado_em: v[1] }); return [];
    }
    if (sql.includes("SET status = 'falhou'")) { n.status = "falhou"; return []; }
    if (sql.includes("SET status = 'cancelada'")) { n.status = "cancelada"; return []; }
    throw new Error(`SQL não modelado no teste: ${sql}`);
  };
  const db = Object.assign(query, { begin: async (fn: (tx: SQL) => Promise<unknown>) => {
    const anterior = lock; let release!: () => void; lock = new Promise<void>(resolve => { release = resolve; }); await anterior;
    const snapshot = structuredClone({ n, ledger }); state.inTx = true;
    try { const result = await fn(query as unknown as SQL); if (state.failCommitAt === state.commits) throw new Error("Commit indisponível no teste"); state.commits++; return result; }
    catch (error) { n = snapshot.n; ledger = snapshot.ledger; throw error; }
    finally { state.inTx = false; release(); }
  } }) as unknown as SQL;
  return { db, state, row: () => n, events: () => ledger };
}
function evento(estado: EstadoEntrega, segundos = 0, correlacao: string | null = null): EventoMeta {
  return { wamid, estado, ocorridoEm: new Date(agora.getTime() + segundos * 1000), phoneNumberId: phoneId, erroCodigo: estado === "failed" ? 130497 : null, correlacao };
}
const canalFake = (processar: CanalNotificacoes["processar"]): CanalNotificacoes => ({ provedor: "meta", envioRealHabilitado: true, persistenciaHabilitada: true, processar });
function payload(status = "sent", extra: Record<string, unknown> = {}) {
  return { object: "whatsapp_business_account", entry: [{ id: "98765", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneId }, statuses: [{ id: wamid, status, timestamp: String(agora.getTime() / 1000), recipient_id: "5511999990000", ...extra }] } }] }] };
}
function post(body: string, assinatura?: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/webhooks/whatsapp", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": assinatura ?? `sha256=${createHmac("sha256", env.WHATSAPP_APP_SECRET).update(body).digest("hex")}`, ...headers }, body });
}
async function aceitar(db: ReturnType<typeof bancoSimulado>) {
  return processarNotificacao(db.db, id, canalFake(async () => ({ estado: "aceita", messageId: wamid })), agora);
}

describe("Reserva durável sem transporte real", () => {
  test("confirma a reserva antes do canal e persiste aceitação sem entrega", async () => {
    const banco = bancoSimulado();
    const processar = mock(async (p) => { expect(banco.state.inTx).toBe(false); expect(banco.state.commits).toBe(1); expect(banco.row().meta_estado).toBe("reservado"); expect(p.biz_opaque_callback_data).toBe(id); return { estado: "aceita" as const, messageId: wamid }; });
    await processarNotificacao(banco.db, id, canalFake(processar), agora);
    expect(banco.row().meta_wamid).toBe(wamid); expect(banco.row().meta_estado).toBe("aceita"); expect(banco.row().meta_entrega_estado).toBe("nao_confirmada");
    expect(banco.row().status).toBe("pendente"); expect(banco.row().data_envio).toBeNull(); expect(banco.state.commits).toBe(2);
  });
  test("duas execuções concorrentes só reservam e chamam o canal uma vez", async () => {
    const banco = bancoSimulado(); const processar = mock(async () => ({ estado: "aceita" as const, messageId: wamid }));
    const result = await Promise.allSettled([processarNotificacao(banco.db, id, canalFake(processar), agora), processarNotificacao(banco.db, id, canalFake(processar), agora)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(processar).toHaveBeenCalledTimes(1);
    expect(banco.state.sql.some(sql => sql.includes("meta_estado = 'nao_iniciado' AND meta_wamid IS NULL"))).toBe(true);
  });
  test("bloqueio de código persiste bloqueado sem construir cliente Meta", async () => {
    const banco = bancoSimulado(); const fabrica = mock(() => { throw new Error("Não construir Meta"); });
    const canal = selecionarProvedorWhatsApp({ WHATSAPP_PROVIDER: "meta", WHATSAPP_REAL_SEND_ENABLED: "true", WHATSAPP_PERSISTENCE_ENABLED: "true" }, fabrica);
    const result = await processarNotificacao(banco.db, id, canal, agora);
    expect(result.bloqueado).toBe(true); expect(banco.row().meta_estado).toBe("bloqueado"); expect(fabrica).not.toHaveBeenCalled();
    await expect(processarNotificacao(banco.db, id, canal, agora)).rejects.toThrow("Reenvio bloqueado");
  });
  test.each([true, false])("falha incerta=%s persiste código seguro sem reenvio", async incerta => {
    const banco = bancoSimulado(); const processar = mock(async () => { throw new ErroWhatsAppMeta("api", "texto remoto não deve persistir", 400, 130497, undefined, incerta); });
    await processarNotificacao(banco.db, id, canalFake(processar), agora);
    expect(banco.row().meta_estado).toBe(incerta ? "incerto" : "falhou"); expect(banco.row().meta_falha_codigo).toBe(130497);
    expect(JSON.stringify(banco.row())).not.toContain("texto remoto");
    await expect(processarNotificacao(banco.db, id, canalFake(processar), agora)).rejects.toThrow("Reenvio bloqueado"); expect(processar).toHaveBeenCalledTimes(1);
  });
  test("falha na persistência final mantém reserva e reconcilia para incerto, sem reenviar", async () => {
    const banco = bancoSimulado(); banco.state.failFinalize = true; const processar = mock(async () => ({ estado: "aceita" as const, messageId: wamid }));
    await expect(processarNotificacao(banco.db, id, canalFake(processar), agora)).rejects.toThrow("reserva impede reenvio");
    expect(banco.row().meta_estado).toBe("reservado");
    const result = await reconciliarNotificacoesMeta(banco.db, new Date(agora.getTime() + 6 * 60000));
    expect(result.expiradas).toBe(1); expect(result.reenviadas).toBe(0); expect(banco.row().meta_estado).toBe("incerto"); expect(processar).toHaveBeenCalledTimes(1);
  });
  test("schema indisponível ou transação inicial falhando não chama canal", async () => {
    const processar = mock(async () => ({ estado: "aceita" as const, messageId: wamid }));
    const query = mock(async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("FROM notificacoes n")) return [bancoSimulado().row()];
      if (strings.join("").includes("meta_tentativa_id")) throw new Error("coluna ausente"); return [];
    });
    const db = { begin: async (fn: (tx: SQL) => unknown) => fn(query as unknown as SQL) } as unknown as SQL;
    await expect(processarNotificacao(db, id, canalFake(processar), agora)).rejects.toThrow("Persistência Meta indisponível"); expect(processar).not.toHaveBeenCalled();
  });
  test("falha no commit inicial impede chamar o canal e desfaz a reserva", async () => {
    const banco = bancoSimulado(); banco.state.failCommitAt = 0;
    const processar = mock(async () => ({ estado: "aceita" as const, messageId: wamid }));
    await expect(processarNotificacao(banco.db, id, canalFake(processar), agora)).rejects.toThrow("Commit indisponível");
    expect(processar).not.toHaveBeenCalled(); expect(banco.row().meta_estado).toBe("nao_iniciado");
  });
});
describe("Eventos persistidos, duplicados e fora de ordem", () => {
  test("sent, delivered e read avançam sem regressão por replay", async () => {
    const banco = bancoSimulado(); await aceitar(banco);
    for (const [estado, segundos] of [["read", 30], ["sent", 10], ["delivered", 20], ["failed", 40]] as const) await receberEventosMeta(banco.db, [evento(estado, segundos)]);
    expect(banco.row().meta_entrega_estado).toBe("read"); expect(banco.row().status).toBe("enviada");
    const result = await receberEventosMeta(banco.db, [evento("read", 30)]);
    expect(result.duplicados).toBe(1); expect(result.aplicados).toBe(0); expect(banco.events()).toHaveLength(4);
  });
  test("falha após sent é registrada mas não supera prova de entrega", async () => {
    const banco = bancoSimulado(); await aceitar(banco);
    await receberEventosMeta(banco.db, [evento("sent", 10), evento("failed", 20)]);
    expect(banco.row().meta_entrega_estado).toBe("failed"); expect(banco.row().meta_entrega_erro).toBe(130497); expect(banco.row().status).toBe("falhou");
    await receberEventosMeta(banco.db, [evento("sent", 30)]); expect(banco.row().meta_entrega_estado).toBe("failed");
    await receberEventosMeta(banco.db, [evento("delivered", 15)]); expect(banco.row().meta_entrega_estado).toBe("delivered"); expect(banco.row().meta_entrega_erro).toBeNull();
  });
  test("falha anterior ao sent atual é obsoleta", async () => {
    const banco = bancoSimulado(); await aceitar(banco);
    await receberEventosMeta(banco.db, [evento("sent", 20)]); await receberEventosMeta(banco.db, [evento("failed", 10)]);
    expect(banco.row().meta_entrega_estado).toBe("sent");
  });
  test("webhook antes da resposta HTTP fica durável e é reconciliado ao persistir wamid", async () => {
    const banco = bancoSimulado(); await receberEventosMeta(banco.db, [evento("delivered", 10)]);
    expect(banco.events()[0]!.aplicado_em).toBeNull(); expect(banco.row().meta_wamid).toBeNull();
    await aceitar(banco); expect(banco.row().meta_entrega_estado).toBe("delivered"); expect(banco.events()[0]!.notificacao_id).toBe(id);
  });
  test("timeout é reconciliado por correlação assinada, sem associar por telefone", async () => {
    const banco = bancoSimulado(); await processarNotificacao(banco.db, id, canalFake(async () => { throw new Error("rede"); }), agora);
    expect(banco.row().meta_estado).toBe("incerto");
    await receberEventosMeta(banco.db, [evento("sent", 10, id)]);
    expect(banco.row().meta_estado).toBe("aceita"); expect(banco.row().meta_wamid).toBe(wamid); expect(banco.row().meta_entrega_estado).toBe("sent");
  });
  test("webhook concorrente com timeout prevalece sem apagar aceitação e entrega", async () => {
    const banco = bancoSimulado();
    const result = await processarNotificacao(banco.db, id, canalFake(async () => {
      await receberEventosMeta(banco.db, [evento("delivered", 10, id)]);
      throw new ErroWhatsAppMeta("timeout", "Timeout de teste", undefined, undefined, undefined, true);
    }), agora);
    expect(result).toHaveProperty("meta_estado", "aceita"); expect(banco.row().meta_entrega_estado).toBe("delivered");
    expect(banco.row().meta_wamid).toBe(wamid);
  });
  test("correlação não vincula evento a reserva não iniciada/bloqueada", async () => {
    const banco = bancoSimulado(); await receberEventosMeta(banco.db, [evento("read", 10, id)]);
    expect(banco.row().meta_wamid).toBeNull(); expect(banco.events()[0]!.aplicado_em).toBeNull();
  });
  test("eventos duplicados concorrentes não são aplicados duas vezes", async () => {
    const banco = bancoSimulado(); await aceitar(banco);
    const result = await Promise.all([receberEventosMeta(banco.db, [evento("sent")]), receberEventosMeta(banco.db, [evento("sent")])]);
    expect(banco.events()).toHaveLength(1); expect(result.reduce((total, r) => total + r.aplicados, 0)).toBe(1);
    expect(banco.state.sql.some(sql => sql.includes("ON CONFLICT (phone_number_id, meta_wamid, estado, ocorrido_em) DO NOTHING"))).toBe(true);
  });
  test("cancelamento administrativo não apaga prova posterior de entrega", async () => {
    const banco = bancoSimulado(); await aceitar(banco); banco.row().status = "cancelada";
    await receberEventosMeta(banco.db, [evento("delivered")]);
    expect(banco.row().status).toBe("cancelada"); expect(banco.row().meta_entrega_estado).toBe("delivered"); expect(banco.row().data_envio).toBeNull();
  });
  test("matriz não regride read ou delivered", () => {
    for (const atual of ["delivered", "read"]) for (const proximo of ["sent", "failed"] as const) expect(deveAvancarEntrega(atual, proximo)).toBe(false);
  });
});
describe("Webhook autenticado sem cookies ou chamadas externas", () => {
  test("GET devolve challenge literal com token correto e não abre banco", async () => {
    const getDb = mock(() => { throw new Error("Não abrir banco"); }); const controller = criarMetaWebhookController(getDb, () => env);
    const response = await controller(new Request(`http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${env.WHATSAPP_WEBHOOK_VERIFY_TOKEN}&hub.challenge=123456`));
    expect(response.status).toBe(200); expect(await response.text()).toBe("123456"); expect(response.headers.get("cache-control")).toBe("no-store"); expect(getDb).not.toHaveBeenCalled();
  });
  test.each(["errado", ""])("GET rejeita token %s", async token => {
    const getDb = mock(() => { throw new Error("Não abrir banco"); });
    const response = await criarMetaWebhookController(getDb, () => env)(new Request(`http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=123`));
    expect(response.status).toBe(403); expect(getDb).not.toHaveBeenCalled();
  });
  test("GET recusa parâmetros duplicados e configuração ausente", async () => {
    const getDb = mock(() => { throw new Error("Não abrir banco"); });
    expect((await criarMetaWebhookController(getDb, () => ({}))(new Request("http://localhost/api/webhooks/whatsapp"))).status).toBe(503);
    expect((await criarMetaWebhookController(getDb, () => env)(new Request("http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.mode=subscribe"))).status).toBe(400);
  });
  test("POST válido persiste apenas metadados mínimos e responde após commit", async () => {
    const banco = bancoSimulado(); await aceitar(banco);
    const body = JSON.stringify(payload("delivered", { errors: [{ code: 130497, message: "texto-sensível" }] }));
    const response = await criarMetaWebhookController(() => banco.db, () => env)(post(body));
    expect(response.status).toBe(200); expect((await response.json()).aplicados).toBe(1); expect(banco.row().meta_entrega_estado).toBe("delivered");
    expect(JSON.stringify(banco.events())).not.toContain("texto-sensível"); expect(JSON.stringify(banco.events())).not.toContain("5511999990000");
  });
  test.each(["sha256=00", `sha256=${"0".repeat(64)}`, "sha1=abc"])("assinatura inválida %s não interpreta nem grava", async signature => {
    const getDb = mock(() => { throw new Error("Não abrir banco"); });
    expect((await criarMetaWebhookController(getDb, () => env)(post("{json-quebrado", signature))).status).toBe(401); expect(getDb).not.toHaveBeenCalled();
  });
  test("alterar bytes e espaços invalida assinatura; não usa JSON reserializado", () => {
    const body = '{ "object": "teste" }'; const assinatura = `sha256=${createHmac("sha256", env.WHATSAPP_APP_SECRET).update(body).digest("hex")}`;
    expect(assinaturaMetaValida(Buffer.from(body), assinatura, env.WHATSAPP_APP_SECRET)).toBe(true);
    expect(assinaturaMetaValida(Buffer.from(JSON.stringify(JSON.parse(body))), assinatura, env.WHATSAPP_APP_SECRET)).toBe(false);
  });
  test("sem secret ou sem habilitação de persistência não abre banco", async () => {
    const getDb = mock(() => { throw new Error("Não abrir banco"); });
    expect((await criarMetaWebhookController(getDb, () => ({}))(post("{}"))).status).toBe(503);
    expect((await criarMetaWebhookController(getDb, () => ({ ...env, WHATSAPP_PERSISTENCE_ENABLED: "false" }))(post("{}"))).status).toBe(503);
    expect(getDb).not.toHaveBeenCalled();
  });
  test("JSON malformado assinado, corpo grande e tipo incorreto são recusados", async () => {
    const getDb = mock(() => { throw new Error("Não abrir banco"); }); const controller = criarMetaWebhookController(getDb, () => env);
    expect((await controller(post("{"))).status).toBe(400);
    expect((await controller(post("x".repeat(262145)))).status).toBe(413);
    expect((await controller(post("{}", undefined, { "Content-Type": "text/plain" }))).status).toBe(415); expect(getDb).not.toHaveBeenCalled();
  });
  test("assinatura ausente e lote acima de cem eventos não são persistidos", async () => {
    const getDb = mock(() => { throw new Error("Não abrir banco"); }); const controller = criarMetaWebhookController(getDb, () => env);
    const req = post(JSON.stringify(payload())); req.headers.delete("x-hub-signature-256");
    expect((await controller(req)).status).toBe(401);
    const lote = payload(); const value = lote.entry[0]!.changes[0]!.value;
    value.statuses = Array.from({ length: 101 }, () => value.statuses[0]!);
    expect((await controller(post(JSON.stringify(lote)))).status).toBe(413); expect(getDb).not.toHaveBeenCalled();
  });
  test("conta/número alheio, mensagens recebidas e status desconhecido são ignorados", async () => {
    const getDb = mock(() => { throw new Error("Não abrir banco"); }); const controller = criarMetaWebhookController(getDb, () => env);
    for (const body of [JSON.stringify(payload("unknown")), JSON.stringify(payload()).replace(phoneId, "999999"), JSON.stringify({ object: "outro" })]) {
      expect((await controller(post(body))).status).toBe(200);
    }
    expect(extrairEventosMeta(payload(), phoneId, "outro-waba").eventos).toHaveLength(0); expect(getDb).not.toHaveBeenCalled();
  });
  test("falha de banco não confirma webhook nem expõe erro bruto", async () => {
    const response = await criarMetaWebhookController(() => { throw new Error(`segredo ${env.WHATSAPP_APP_SECRET}`); }, () => env)(post(JSON.stringify(payload())));
    expect(response.status).toBe(503); const texto = await response.text(); expect(texto).not.toContain("segredo"); expect(texto).not.toContain(env.WHATSAPP_APP_SECRET);
  });
  test("migrações incluem lease, deduplicação durável e inbox sem conteúdo clínico", async () => {
    const m3 = await Bun.file(new URL("../sql/003_prepare_meta_notifications.sql", import.meta.url)).text();
    const m4 = await Bun.file(new URL("../sql/004_create_meta_webhook_events.sql", import.meta.url)).text();
    expect(m3).toContain("meta_reserva_expira_em"); expect(m3).toContain("notificacoes_meta_tentativa_unica");
    expect(m4).toContain("UNIQUE (phone_number_id, meta_wamid, estado, ocorrido_em)"); expect(m4).toContain("REFERENCES notificacoes(id)"); expect(m4).not.toContain("payload JSON");
  });
  test("rota pública não depende de sessão, mas exige configuração própria", async () => {
    const response = await handleRequest(new Request("http://localhost/api/webhooks/whatsapp", { method: "DELETE" }));
    expect(response.status).toBe(405);
  });
  test("reconciliação mantém autenticação administrativa e proteção de origem", async () => {
    const usuario = { id: "admin-teste", nome: "Equipe Teste", perfil: "administrador", email: "equipe@example.com" };
    for (const caso of [{ perfil: "funcionario", origin: "http://localhost", esperado: 403 }, { perfil: "administrador", origin: "https://externo.example", esperado: 403 }]) {
      const query = mock(async () => [{ ...usuario, perfil: caso.perfil }]);
      const req = new Request("http://localhost/api/notificacoes/reconciliar", { method: "POST", headers: { Cookie: `sessao=${"a".repeat(64)}`, Origin: caso.origin, "Content-Type": "application/json" }, body: "{}" });
      expect((await criarNotificacoesController(() => query as unknown as SQL, false)(req)).status).toBe(caso.esperado);
      expect(query).toHaveBeenCalledTimes(1);
    }
    const query = mock(async () => [usuario]);
    const req = new Request("http://localhost/api/notificacoes/reconciliar", { method: "POST", headers: { Cookie: `sessao=${"a".repeat(64)}`, Origin: "http://localhost", "Content-Type": "application/json" }, body: "{}" });
    expect((await criarNotificacoesController(() => query as unknown as SQL, false, undefined, () => selecionarProvedorWhatsApp({}))(req)).status).toBe(409);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
