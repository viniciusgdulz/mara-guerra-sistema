import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { canalSimulado, descreverCanal, selecionarProvedorWhatsApp } from "../src/integrations/whatsapp-provider";
import { prepararMensagem } from "../src/integrations/whatsapp";
import { processarNotificacao, gerarNotificacoes, listarNotificacoes, simularNotificacao, cancelarNotificacao } from "../src/services/notificacoes.service";
import { criarNotificacoesController } from "../src/controllers/notificacoes.controller";
import { reservarTentativaMeta, registrarAceitacaoMeta, registrarFalhaMeta } from "../src/services/notificacoes-meta.repository";
const id = "00000000-0000-4000-8000-000000000001";
const agora = new Date("2026-11-03T12:00:00Z");
const usuario = { id: "admin", nome: "Equipe Teste", email: "equipe@example.com", perfil: "administrador" };
const contexto = { id, paciente_id: id, tipo: "lembrete_agendamento", status: "pendente", previsao_envio: agora, data_envio: null,
  nome: "Pessoa Teste", telefone: "11999990000", consentimento_whatsapp: true, consentimento_whatsapp_em: agora,
  data_hora: new Date("2026-11-04T15:00:00Z"), agendamento_status: "pendente", data_retorno_sugerida: null,
  procedimento_ativo: null, retorno_agendado: false, meta_estado: "nao_iniciado", meta_wamid: null };
const payload = prepararMensagem("lembrete_agendamento", contexto.nome, contexto.telefone, contexto.data_hora).payload;
const metaEnv = { WHATSAPP_PROVIDER: "meta", WHATSAPP_ACCESS_TOKEN: "token-ficticio-teste", WHATSAPP_PHONE_NUMBER_ID: "123456789", WHATSAPP_GRAPH_API_VERSION: "v23.0" };
function cliente(respostas: readonly (readonly unknown[])[] = []) {
  const fila = respostas.map(rows => [...rows]);
  const query = mock(async (_sql: TemplateStringsArray, ..._values: unknown[]) => fila.shift() ?? []);
  const begin = mock(async (fn: (tx: SQL) => unknown) => fn(query as unknown as SQL));
  return { db: Object.assign(query, { begin }) as unknown as SQL, query, begin };
}
function request(method = "POST", path = `/api/notificacoes/${id}/processar`, body: unknown = {}, extra: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, { method, headers: { Origin: "http://localhost:3000", Cookie: `sessao=${"a".repeat(64)}`, "Content-Type": "application/json", ...extra }, body: method === "GET" ? undefined : JSON.stringify(body) });
}
describe("Seleção explícita e bloqueio externo da Etapa 2", () => {
  test("padrão simulado, inclusive com credenciais e flag de habilitação", async () => {
    const criarMeta = mock(() => { throw new Error("Não construir cliente real"); });
    for (const env of [{}, { ...metaEnv, WHATSAPP_PROVIDER: undefined }, { ...metaEnv, WHATSAPP_PROVIDER: "simulado", WHATSAPP_REAL_SEND_ENABLED: "true" }]) {
      const canal = selecionarProvedorWhatsApp(env, criarMeta);
      expect(canal.provedor).toBe("simulado"); expect(await canal.processar(payload)).toEqual({ estado: "simulado" });
    }
    expect(criarMeta).not.toHaveBeenCalled();
  });
  test.each([undefined, "false", "true"])("meta com habilitação %s nunca constrói nem chama transporte", async flag => {
    const enviarTemplate = mock(async () => ({ messageId: "wamid.teste", status: "aceita" as const }));
    const criarMeta = mock(() => ({ modo: "real" as const, enviarTemplate }));
    const canal = selecionarProvedorWhatsApp({ ...metaEnv, WHATSAPP_REAL_SEND_ENABLED: flag }, criarMeta);
    const result = await canal.processar(payload);
    expect(result.estado).toBe("bloqueado");
    if (result.estado === "bloqueado") expect(result.motivo).toBe(flag === "true" ? "etapa2" : "envio_desabilitado");
    expect(criarMeta).not.toHaveBeenCalled(); expect(enviarTemplate).not.toHaveBeenCalled();
    const publico = descreverCanal(canal); expect(publico.chamadas_externas_bloqueadas).toBe(true);
    expect(JSON.stringify(publico)).not.toContain(metaEnv.WHATSAPP_ACCESS_TOKEN);
  });
  test("meta bloqueado não exige credenciais ou conexão com a Meta", async () => {
    expect((await selecionarProvedorWhatsApp({ WHATSAPP_PROVIDER: "meta", WHATSAPP_REAL_SEND_ENABLED: "true" }).processar(payload)).estado).toBe("bloqueado");
  });
  test.each([{ WHATSAPP_PROVIDER: "automatico" }, { WHATSAPP_PROVIDER: "" }, { WHATSAPP_REAL_SEND_ENABLED: "TRUE" }, { WHATSAPP_REAL_SEND_ENABLED: "1" }])("seleção inválida falha fechada: %j", env => expect(() => selecionarProvedorWhatsApp(env)).toThrow());
});
describe("Processador único da fila", () => {
  test("simulado usa as regras existentes e não grava envio/entrega", async () => {
    const { db, query } = cliente([[], [contexto], []]);
    const result = await processarNotificacao(db, id, selecionarProvedorWhatsApp({}), agora);
    expect(result.preparado).toBe(true); expect(result.status).toBe("pendente");
    expect(query.mock.calls[2]![0].join("?")).toContain("data_envio = NULL");
    expect(query.mock.calls[1]![0].join("?")).toContain("to_jsonb(n)->>'meta_estado'");
  });
  test.each(["false", "true"])("fila com meta e habilitação %s retorna bloqueio sem mudar status", async flag => {
    const { db, query } = cliente([[], [{ ...contexto, status: "falhou" }]]);
    const canal = selecionarProvedorWhatsApp({ ...metaEnv, WHATSAPP_REAL_SEND_ENABLED: flag }, () => { throw new Error("Não construir cliente"); });
    const result = await processarNotificacao(db, id, canal, agora);
    expect(result.bloqueado).toBe(true); expect(result.status).toBe("falhou"); expect(result.preparado).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });
  test.each([
    { ...contexto, consentimento_whatsapp: false }, { ...contexto, consentimento_whatsapp_em: null },
    { ...contexto, agendamento_status: "cancelado" }, { ...contexto, data_hora: agora },
    { ...contexto, tipo: "lembrete_retorno", data_retorno_sugerida: "2026-11-04", procedimento_ativo: true, retorno_agendado: true },
  ])("revalida consentimento e elegibilidade antes do canal %j", async c => {
    const { db } = cliente([[], [c], []]); const processar = mock(async () => ({ estado: "simulado" as const }));
    expect((await processarNotificacao(db, id, { provedor: "simulado", envioRealHabilitado: false, processar }, agora)).status).toBe("cancelada"); expect(processar).not.toHaveBeenCalled();
  });
  test("telefone inválido falha antes do canal, inclusive com meta selecionado", async () => {
    const { db, query } = cliente([[], [{ ...contexto, telefone: "12345678" }], []]); const processar = mock(async () => ({ estado: "simulado" as const }));
    expect((await processarNotificacao(db, id, { provedor: "meta", envioRealHabilitado: true, processar }, agora)).status).toBe("falhou");
    expect(processar).not.toHaveBeenCalled(); expect(query.mock.calls[2]![0].join("?")).toContain("status = 'falhou'");
  });
  test("falha simulada não expõe detalhes e não vira entrega", async () => {
    const { db, query } = cliente([[], [contexto], []]);
    const result = await processarNotificacao(db, id, canalSimulado({ modo: "simulado", preparar: async () => { throw new Error("token-secreto"); } }), agora);
    expect(result.status).toBe("falhou"); expect(JSON.stringify(result)).not.toContain("token-secreto");
    expect(query.mock.calls[2]![0].join("?")).toContain("data_envio = NULL");
  });
  test.each(["reservado", "aceita", "incerto", "falhou", "desconhecido"])("não processa ou simula novamente tentativa Meta %s", async meta_estado => {
    const processar = mock(async () => ({ estado: "simulado" as const }));
    const { db, query } = cliente([[], [{ ...contexto, meta_estado }], [], [{ ...contexto, meta_estado }]]);
    await expect(processarNotificacao(db, id, { provedor: "meta", envioRealHabilitado: true, processar }, agora)).rejects.toThrow("Reenvio bloqueado");
    await expect(simularNotificacao(db, id, undefined, agora)).rejects.toThrow("Reenvio bloqueado");
    expect(query).toHaveBeenCalledTimes(4); expect(processar).not.toHaveBeenCalled();
  });
  test("wamid por si só impede reenvio, mesmo sem estado reconhecido", async () => {
    const { db } = cliente([[], [{ ...contexto, meta_wamid: "wamid.teste" }]]);
    await expect(processarNotificacao(db, id, selecionarProvedorWhatsApp({}), agora)).rejects.toThrow("Reenvio bloqueado");
  });
  test("geração não reabre tentativas existentes e consulta indica aceitação sem entrega", async () => {
    const c = { ...contexto, meta_estado: "aceita", meta_wamid: "wamid.teste" };
    const { db, query } = cliente([[], [c], [], [], [c]]);
    expect((await gerarNotificacoes(db, agora)).atualizadas).toBe(0);
    expect(query).toHaveBeenCalledTimes(4);
    const rows = await listarNotificacoes(db, null, 1, agora);
    expect(rows[0]!.pode_processar).toBe(false); expect(rows[0]!.pode_simular).toBe(false); expect(rows[0]!.diagnostico).toContain("não comprova entrega");
  });
  test("cancelamento não sobrescreve tentativa Meta existente", async () => {
    const { db, query } = cliente([[], []]); await expect(cancelarNotificacao(db, id)).rejects.toThrow();
    expect(query.mock.calls[1]![0].join("?")).toContain("to_jsonb(notificacoes)->>'meta_wamid' IS NULL");
  });
});
describe("Persistência preparada e migração não executada", () => {
  test("DDL contém metadados e constraints sem inventar status de entrega", async () => {
    const sql = await Bun.file(new URL("../sql/003_prepare_meta_notifications.sql", import.meta.url)).text();
    expect(sql).toContain("BEGIN;"); expect(sql).toContain("COMMIT;");
    for (const campo of ["meta_estado", "meta_wamid", "meta_tentativa_em", "meta_aceita_em"]) expect(sql).toContain(`ADD COLUMN ${campo}`);
    expect(sql).toContain("CREATE UNIQUE INDEX notificacoes_meta_wamid_unico");
    expect(sql).toContain("notificacoes_meta_aceitacao_coerente CHECK"); expect(sql).toContain("meta_wamid IS NOT NULL");
    expect(sql).toContain("meta_wamid IS NULL AND meta_aceita_em IS NULL");
    expect(sql).not.toContain("UPDATE notificacoes"); expect(sql).not.toContain("entregue");
  });
  test("reserva atomica impede segunda reserva concorrente", async () => {
    let reservado = false;
    const query = mock(async (_sql: TemplateStringsArray) => { if (reservado) return []; reservado = true; return [{ id }]; });
    const resultados = await Promise.all([reservarTentativaMeta(query as unknown as SQL, id, agora), reservarTentativaMeta(query as unknown as SQL, id, agora)]);
    expect(resultados.sort()).toEqual([false, true]);
    expect(query.mock.calls[0]![0].join("?")).toContain("meta_estado = 'nao_iniciado' AND meta_wamid IS NULL");
  });
  test("wamid aceito é persistido de forma idempotente, sem status/data_envio", async () => {
    const { db, query } = cliente([[{ id, meta_wamid: "wamid.teste" }]]);
    expect(await registrarAceitacaoMeta(db, id, "wamid.teste", agora)).toEqual({ id, estado: "aceita", messageId: "wamid.teste" });
    const [sql, ...values] = query.mock.calls[0]!;
    expect(values).toEqual(["wamid.teste", agora, id, null, null, "wamid.teste"]);
    expect(sql.join("?")).toContain("COALESCE(meta_aceita_em"); expect(sql.join("?")).not.toContain("status ="); expect(sql.join("?")).not.toContain("data_envio");
  });
  test("estado incompatível ou id inválido não é aceitação", async () => {
    const { db, query } = cliente();
    await expect(registrarAceitacaoMeta(db, id, "wamid.teste")).rejects.toThrow("incompatível");
    await expect(registrarAceitacaoMeta(db, id, "invalido")).rejects.toThrow("inválido");
    await expect(reservarTentativaMeta(db, "invalido")).rejects.toThrow(); expect(query).toHaveBeenCalledTimes(1);
  });
  test.each([true, false])("falha de transporte incerta=%s mantém estado separado sem reenvio", async resultadoIncerto => {
    const { db, query } = cliente([[{ id }]]);
    expect((await registrarFalhaMeta(db, id, { resultadoIncerto })).estado).toBe(resultadoIncerto ? "incerto" : "falhou");
    expect(query.mock.calls[0]![0].join("?")).toContain("meta_estado = 'reservado'");
    expect(query.mock.calls[0]![0].join("?")).not.toContain("status =");
  });
});
describe("Ação HTTP processar mantém autorização e proteção de origem", () => {
  test.each(["meta", "simulado"])("admin processa %s sem comunicação externa", async provedor => {
    const { db } = cliente([[usuario], [], [contexto], []]);
    const canal = selecionarProvedorWhatsApp({ WHATSAPP_PROVIDER: provedor, WHATSAPP_REAL_SEND_ENABLED: "true" });
    const response = await criarNotificacoesController(() => db, false, undefined, () => canal)(request());
    expect(response.status).toBe(200); const data = await response.json();
    expect(provedor === "meta" ? data.bloqueado : data.simulado).toBe(true); expect(data.status).toBe("pendente");
  });
  test("funcionário não seleciona canal nem acessa processamento", async () => {
    const { db, query } = cliente([[{ ...usuario, perfil: "funcionario" }]]); const getCanal = mock(() => selecionarProvedorWhatsApp({}));
    expect((await criarNotificacoesController(() => db, false, undefined, getCanal)(request())).status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1); expect(getCanal).not.toHaveBeenCalled();
  });
  test("sem cookie não abre banco", async () => {
    const getDb = mock(() => { throw new Error("Não conectar"); });
    expect((await criarNotificacoesController(getDb, false)(request("POST", undefined, {}, { Cookie: "" }))).status).toBe(401); expect(getDb).not.toHaveBeenCalled();
  });
  test.each(["", "https://externo.example"])("origem %s não autoriza processamento", async Origin => {
    const { db, query } = cliente([[usuario]]);
    expect((await criarNotificacoesController(() => db, false)(request("POST", undefined, {}, { Origin }))).status).toBe(403); expect(query).toHaveBeenCalledTimes(1);
  });
  test("payload não pode selecionar provedor ou habilitar envio", async () => {
    const { db, query } = cliente([[usuario]]);
    expect((await criarNotificacoesController(() => db, false)(request("POST", undefined, { provedor: "meta", envio_real_habilitado: true }))).status).toBe(400); expect(query).toHaveBeenCalledTimes(1);
  });
  test("consulta informa provedor sem expor credenciais", async () => {
    const { db } = cliente([[usuario], []]); const canal = selecionarProvedorWhatsApp({ ...metaEnv, WHATSAPP_REAL_SEND_ENABLED: "true" });
    const response = await criarNotificacoesController(() => db, false, undefined, () => canal)(request("GET", "/api/notificacoes"));
    const data = await response.json(); expect(data.processamento.provedor).toBe("meta"); expect(data.processamento.chamadas_externas_bloqueadas).toBe(true);
    expect(JSON.stringify(data)).not.toContain(metaEnv.WHATSAPP_ACCESS_TOKEN);
  });
});
