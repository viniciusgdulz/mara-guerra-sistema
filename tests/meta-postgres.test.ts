import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID, createHmac } from "node:crypto";
import { resolve, join, sep } from "node:path";
import { reservarTentativaMeta } from "../src/services/notificacoes-meta.repository";
import { processarNotificacao, reconciliarNotificacoesMeta, gerarNotificacoes } from "../src/services/notificacoes.service";
import { receberEventosMeta, type EventoMeta, type EstadoEntrega } from "../src/services/meta-webhook.repository";
import { criarMetaWebhookController } from "../src/controllers/meta-webhook.controller";
import { selecionarProvedorWhatsApp, type CanalNotificacoes } from "../src/integrations/whatsapp-provider";

const habilitado = Bun.env.MARA_META_REAL_TESTS === "1";
const suite = habilitado ? describe : describe.skip;
const workspace = resolve(import.meta.dir, "..");
const root = join(workspace, ".local", "meta-pg-stage4");
let db: SQL, admin: SQL;
let config: { host: string; port: number; username: string; password: string; database: string; dataDirectory: string; binDirectory: string };
let database = "";
let bloquearFetch: ReturnType<typeof spyOn>;
const migracoes: string[] = [];
const agora = new Date();
const canalMock = (processar: CanalNotificacoes["processar"]): CanalNotificacoes => ({ provedor: "meta", envioRealHabilitado: true, persistenciaHabilitada: true, processar });
function conexao(nome = database, max = 8) {
  // Destino derivado SOMENTE do arquivo do cluster local. Nunca lê DATABASE_URL.
  return new SQL({ hostname: "127.0.0.1", port: config.port, username: config.username, password: config.password, database: nome, max, connectionTimeout: 5 });
}
async function fixture() {
  return db.begin(async tx => {
    const [p] = await tx`INSERT INTO pacientes (nome, telefone, consentimento_whatsapp, consentimento_whatsapp_em)
      VALUES ('Pessoa Ficticia - Teste Isolado Etapa 4', '11999990000', true, CURRENT_TIMESTAMP) RETURNING id`;
    const [pr] = await tx`INSERT INTO procedimentos (nome, intervalo_retorno_dias) VALUES ('Procedimento Ficticio Etapa 4', 30) RETURNING id`;
    const [g] = await tx`INSERT INTO agendamentos (paciente_id, procedimento_id, data_hora) VALUES (${p.id}, ${pr.id}, ${new Date(agora.getTime() + 24 * 3600000)}) RETURNING id`;
    const [n] = await tx`INSERT INTO notificacoes (paciente_id, agendamento_id, tipo, previsao_envio)
      VALUES (${p.id}, ${g.id}, 'lembrete_agendamento', ${new Date(agora.getTime() - 1000)}) RETURNING id`;
    return { id: n.id as string, paciente: p.id as string, agendamento: g.id as string };
  });
}
async function row(id: string) { return (await db`SELECT * FROM notificacoes WHERE id = ${id}`)[0]!; }
const evento = (wamid: string, estado: EstadoEntrega, segundos = 0, correlacao: string | null = null): EventoMeta => ({ wamid, estado, ocorridoEm: new Date(agora.getTime() + segundos * 1000), phoneNumberId: "123456789012345", erroCodigo: estado === "failed" ? 130497 : null, correlacao });
async function aceitar(id: string, wamid: string) { return processarNotificacao(db, id, canalMock(async () => ({ estado: "aceita", messageId: wamid })), agora); }
async function encerrarBackend(control: SQL, alvo: number) {
  const [r] = await control`SELECT pg_terminate_backend(pid) AS terminou FROM pg_stat_activity
    WHERE pid = ${alvo} AND datname = ${database} AND usename = ${config.username} AND pid <> pg_backend_pid()`;
  expect(r?.terminou).toBe(true);
}

suite("Etapa 4: PostgreSQL real exclusivo e isolado", () => {
  beforeAll(async () => {
    config = await Bun.file(join(root, "connection.json")).json();
    if (config.host !== "127.0.0.1" || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
      || config.username !== "mara_meta_stage4" || !/^mara_meta_stage4_[a-f0-9]+$/.test(config.database)
      || !resolve(config.dataDirectory).toLowerCase().startsWith((root + sep).toLowerCase())) throw new Error("Configuração não pertence ao cluster de teste local.");
    admin = conexao(config.database, 2);
    const [server] = await admin`SELECT host(inet_server_addr()) AS endereco, current_setting('data_directory') AS diretorio, version() AS versao`;
    if (server.endereco !== "127.0.0.1" || resolve(server.diretorio).toLowerCase() !== resolve(config.dataDirectory).toLowerCase()) throw new Error("Servidor diferente do cluster exclusivo. Execução recusada.");
    database = `mara_meta_stage4_${randomUUID().replaceAll("-", "")}`;
    if (!/^mara_meta_stage4_[a-f0-9]+$/.test(database)) throw new Error("Nome de banco inválido.");
    // Identificador gerado internamente, verificado, nunca obtido do ambiente de produção.
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    for (const arquivo of ["001_create_tables.sql", "002_create_auth_tables.sql", "003_prepare_meta_notifications.sql", "004_create_meta_webhook_events.sql"]) {
      const child = Bun.spawn([join(config.binDirectory, "psql.exe"), "-X", "-h", "127.0.0.1", "-p", String(config.port), "-U", config.username, "-d", database, "-v", "ON_ERROR_STOP=1", "-f", join(workspace, "sql", arquivo)], {
        env: { SystemRoot: Bun.env.SystemRoot ?? "C:\\Windows", PGPASSWORD: config.password, PGCONNECT_TIMEOUT: "5" }, stdout: "pipe", stderr: "pipe",
      });
      const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (status !== 0) throw new Error(`Migração ${arquivo} falhou no banco local: ${stderr.replaceAll(config.password, "[redigido]")}`);
      migracoes.push(arquivo);
    }
    bloquearFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw new Error("HTTP externo proibido nos testes PostgreSQL."); }, { preconnect: () => {} }));
    await Bun.write(join(root, "last-report.json"), JSON.stringify({ server: server.versao, host: "127.0.0.1", port: config.port, database, migrations: migracoes, realMetaCalls: 0, status: "iniciado" }, null, 2));
  }, 30000);
  beforeEach(() => { db = conexao(); });
  afterEach(async () => { if (db) await db.close({ timeout: 1 }); });
  afterAll(async () => {
    if (bloquearFetch) { expect(bloquearFetch).not.toHaveBeenCalled(); bloquearFetch.mockRestore(); }
    if (db) await db.close({ timeout: 1 }); if (admin) await admin.close({ timeout: 1 });
    if (database && migracoes.length === 4) await Bun.write(join(root, "last-report.json"), JSON.stringify({ postgres: "18.3", host: "127.0.0.1", port: config.port, database, migrations: migracoes, testCases: 14, realMetaCalls: 0, status: "migracoes_aplicadas_consultar_resultado_bun_test" }, null, 2));
  }, 15000);
  test("aplica 001–004 e encontra constraints e índices reais", async () => {
    expect(migracoes).toHaveLength(4);
    const indexes = await db`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    for (const nome of ["notificacoes_meta_wamid_unico", "notificacoes_meta_tentativa_unica", "meta_webhook_pendentes_idx", "meta_webhook_evento_unico"]) expect(indexes.some((i: { indexname: string }) => i.indexname === nome)).toBe(true);
    const constraints = await db`SELECT conname FROM pg_constraint WHERE conrelid = 'notificacoes'::regclass`;
    expect(constraints.some((c: { conname: string }) => c.conname === "notificacoes_meta_reserva_coerente")).toBe(true);
  });
  test("constraints recusam reserva incompleta, aceite sem wamid e entrega sem aceite", async () => {
    const f = await fixture();
    await expect((async () => { await db`UPDATE notificacoes SET meta_estado = 'reservado' WHERE id = ${f.id}`; })()).rejects.toMatchObject({ errno: "23514" });
    await expect((async () => { await db`UPDATE notificacoes SET meta_estado = 'aceita' WHERE id = ${f.id}`; })()).rejects.toMatchObject({ errno: "23514" });
    await expect((async () => { await db`UPDATE notificacoes SET meta_entrega_estado = 'delivered', meta_entrega_em = CURRENT_TIMESTAMP WHERE id = ${f.id}`; })()).rejects.toMatchObject({ errno: "23514" });
    expect((await row(f.id)).meta_estado).toBe("nao_iniciado");
  });
  test("rollback desfaz reserva e transação posterior pode reservar", async () => {
    const f = await fixture();
    await expect(db.begin(async tx => { expect(await reservarTentativaMeta(tx as unknown as SQL, f.id, agora)).toBe(true); throw new Error("rollback deliberado"); })).rejects.toThrow("rollback deliberado");
    expect((await row(f.id)).meta_estado).toBe("nao_iniciado");
    expect(await db.begin(tx => reservarTentativaMeta(tx as unknown as SQL, f.id, agora))).toBe(true);
  });
  test("dez reservas em conexões independentes produzem exatamente uma vencedora", async () => {
    const f = await fixture();
    const clientes = Array.from({ length: 10 }, () => conexao(database, 1));
    try {
      const resultados = await Promise.all(clientes.map(async cliente => await cliente.begin(async tx => await reservarTentativaMeta(tx as unknown as SQL, f.id, agora))));
      expect(resultados.filter(Boolean)).toHaveLength(1); expect((await row(f.id)).meta_estado).toBe("reservado");
    } finally { await Promise.all(clientes.map(cliente => cliente.close({ timeout: 1 }))); }

  }, 15000);
  test("dois processadores em conexões independentes chamam o canal mock uma vez, após commit", async () => {
    const f = await fixture(); const outro = conexao(database, 2);
    const processar = mock(async () => { expect((await row(f.id)).meta_estado).toBe("reservado"); return { estado: "aceita" as const, messageId: `wamid.${randomUUID()}` }; });
    try {
      const resultados = await Promise.allSettled([processarNotificacao(db, f.id, canalMock(processar), agora), processarNotificacao(outro, f.id, canalMock(processar), agora)]);
      expect(resultados.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(processar).toHaveBeenCalledTimes(1);
      expect((await row(f.id)).meta_entrega_estado).toBe("nao_confirmada"); expect((await row(f.id)).data_envio).toBeNull();
    } finally { await outro.close(); }
  });
  test("índices únicos recusam mesmo wamid e mesma tentativa em notificações distintas", async () => {
    const a = await fixture(), b = await fixture(); const msg = `wamid.${randomUUID()}`;
    await aceitar(a.id, msg); await db.begin(tx => reservarTentativaMeta(tx as unknown as SQL, b.id, agora));
    await expect((async () => { await db`UPDATE notificacoes SET meta_estado = 'aceita', meta_wamid = ${msg}, meta_aceita_em = ${agora} WHERE id = ${b.id}`; })()).rejects.toMatchObject({ errno: "23505" });
    const token = (await row(a.id)).meta_tentativa_id;
    const independente = conexao(database, 1);
    try { await expect((async () => { await independente`UPDATE notificacoes SET meta_tentativa_id = ${token}::uuid WHERE id = ${b.id}`; })()).rejects.toMatchObject({ errno: "23505" }); }
    finally { await independente.close({ timeout: 1 }); }

  });
  test("expiração gera incerto e webhook com correlação reconcilia sem reenvio", async () => {
    const f = await fixture(); await db.begin(tx => reservarTentativaMeta(tx as unknown as SQL, f.id, agora));
    const result = await reconciliarNotificacoesMeta(db, new Date(agora.getTime() + 6 * 60000));
    expect(result.expiradas).toBeGreaterThan(0); expect(result.reenviadas).toBe(0); expect((await row(f.id)).meta_estado).toBe("incerto");
    const msg = `wamid.${randomUUID()}`; await receberEventosMeta(db, [evento(msg, "delivered", 10, f.id)], agora);
    expect((await row(f.id)).meta_estado).toBe("aceita"); expect((await row(f.id)).meta_entrega_estado).toBe("delivered");
    const reenviar = mock(async () => { throw new Error("Não reenviar"); });
    const tentativa = processarNotificacao(db, f.id, canalMock(reenviar), agora);
    // Bun 1.3.14: rejects.toThrow com esta promessa pendente bloqueia o progresso
    // do SQL. Aguarda a mesma promessa sem trocar sua rejeição por um sucesso.
    await tentativa.catch(() => {});
    await expect(tentativa).rejects.toThrow("Notificação encerrada");
    await expect(tentativa).rejects.toMatchObject({ status: 409 });
    expect(reenviar).not.toHaveBeenCalled();
    const persistida = await row(f.id);
    expect(persistida.meta_estado).toBe("aceita");
    expect(persistida.meta_entrega_estado).toBe("delivered");
    expect(persistida.meta_wamid).toBe(msg);
  });
  test("inbox anterior à resposta HTTP persiste e reconcilia na aceitação", async () => {
    const f = await fixture(), msg = `wamid.${randomUUID()}`;
    await receberEventosMeta(db, [evento(msg, "read", 10)], agora);
    const [antes] = await db`SELECT aplicado_em FROM meta_webhook_eventos WHERE meta_wamid = ${msg}`; expect(antes.aplicado_em).toBeNull();
    await aceitar(f.id, msg); expect((await row(f.id)).meta_entrega_estado).toBe("read");
  });
  test("dez callbacks simultâneos geram um evento durável e uma aplicação", async () => {
    const f = await fixture(), msg = `wamid.${randomUUID()}`; await aceitar(f.id, msg);
    const results = await Promise.all(Array.from({ length: 10 }, () => receberEventosMeta(db, [evento(msg, "sent", 10)], agora)));
    expect(results.reduce((n, r) => n + r.novos, 0)).toBe(1); expect(results.reduce((n, r) => n + r.aplicados, 0)).toBe(1);
    const [count] = await db`SELECT count(*)::integer AS total FROM meta_webhook_eventos WHERE meta_wamid = ${msg}`; expect(count.total).toBe(1);
  }, 15000);
  test("eventos fora de ordem e failed não regridem read", async () => {
    const f = await fixture(), msg = `wamid.${randomUUID()}`; await aceitar(f.id, msg);
    for (const [estado, segundos] of [["read", 30], ["sent", 10], ["failed", 40], ["delivered", 20]] as const) await receberEventosMeta(db, [evento(msg, estado, segundos)], agora);
    expect((await row(f.id)).meta_entrega_estado).toBe("read"); expect((await row(f.id)).status).toBe("enviada");
  });
  test("falha de conexão antes do commit desfaz reserva e permite recuperação", async () => {
    const f = await fixture(); const vitima = conexao(database, 1);
    try {
      await expect(vitima.begin(async tx => {
        await reservarTentativaMeta(tx as unknown as SQL, f.id, agora);
        const [p] = await tx`SELECT pg_backend_pid() AS pid`; await encerrarBackend(admin, p.pid);
        await tx`SELECT 1`;
      })).rejects.toThrow();
      expect((await row(f.id)).meta_estado).toBe("nao_iniciado");
      expect(await db.begin(tx => reservarTentativaMeta(tx as unknown as SQL, f.id, agora))).toBe(true);
    } finally { await vitima.close({ timeout: 1 }); }
  });
  test("queda real de conexão na finalização mantém reserva já confirmada", async () => {
    const f = await fixture(); const vitima = conexao(database, 1); let transacoes = 0;
    const canal = mock(async () => ({ estado: "aceita" as const, messageId: `wamid.${randomUUID()}` }));
    const falhando = { begin: async (fn: (tx: SQL) => unknown) => vitima.begin(async tx => {
      if (++transacoes === 2) { const [p] = await tx`SELECT pg_backend_pid() AS pid`; await encerrarBackend(admin, p.pid); }
      return fn(tx as unknown as SQL);
    }) } as unknown as SQL;
    try {
      await expect(processarNotificacao(falhando, f.id, canalMock(canal), agora)).rejects.toThrow();
      expect((await row(f.id)).meta_estado).toBe("reservado"); expect(canal).toHaveBeenCalledTimes(1);
      await reconciliarNotificacoesMeta(db, new Date(agora.getTime() + 6 * 60000)); expect((await row(f.id)).meta_estado).toBe("incerto");
    } finally { await vitima.close({ timeout: 1 }); }
  });
  test("POST assinado usa PostgreSQL e rejeita assinatura inválida sem gravação", async () => {
    const f = await fixture(), msg = `wamid.${randomUUID()}`; await aceitar(f.id, msg);
    const secret = 'app-secret-ficticio-teste-local';
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '98765', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '123456789012345' }, statuses: [{ id: msg, status: 'delivered', timestamp: String(Math.floor(agora.getTime() / 1000)) }] } }] }] });
    const controller = criarMetaWebhookController(() => db, () => ({ WHATSAPP_APP_SECRET: secret, WHATSAPP_PHONE_NUMBER_ID: '123456789012345', WHATSAPP_PERSISTENCE_ENABLED: 'true' }));
    const req = (assinatura: string) => new Request('http://localhost/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': assinatura }, body });
    expect((await controller(req('sha256=' + '0'.repeat(64)))).status).toBe(401);
    expect((await row(f.id)).meta_entrega_estado).toBe('nao_confirmada');
    expect((await controller(req('sha256=' + createHmac('sha256', secret).update(body).digest('hex')))).status).toBe(200);
    expect((await row(f.id)).meta_entrega_estado).toBe('delivered');
  });
  test("provedor Meta real segue bloqueado e geração usa SQL real sem duplicar", async () => {
    const f = await fixture(); const criarMeta = mock(() => { throw new Error("Não construir transporte"); });
    const canal = selecionarProvedorWhatsApp({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_REAL_SEND_ENABLED: 'true', WHATSAPP_PERSISTENCE_ENABLED: 'true' }, criarMeta);
    const result = await processarNotificacao(db, f.id, canal, agora);
    expect(result.bloqueado).toBe(true); expect((await row(f.id)).meta_estado).toBe('bloqueado'); expect(criarMeta).not.toHaveBeenCalled();
    await gerarNotificacoes(db, agora); const segunda = await gerarNotificacoes(db, agora); expect(segunda.geradas).toBe(0);
  });
});
