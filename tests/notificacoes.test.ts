import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { alterarConsentimento, obterConsentimento } from "../src/services/consentimento.service";
import { criarConsentimentoController } from "../src/controllers/consentimento.controller";
import { criarNotificacoesController } from "../src/controllers/notificacoes.controller";
import { bloqueioNotificacao, cancelarNotificacao, gerarNotificacoes, listarNotificacoes, simularNotificacao } from "../src/services/notificacoes.service";
import { normalizarWhatsApp, prepararMensagem, provedorSimulado, type ProvedorWhatsApp } from "../src/integrations/whatsapp";
import { handleRequest } from "../src/app";
const id = "00000000-0000-4000-8000-000000000001";
const origem = "00000000-0000-4000-8000-000000000002";
const agora = new Date("2026-10-27T12:00:00Z");
const usuario = { id: "admin-teste", nome: "Equipe Teste", email: "equipe@example.com", perfil: "administrador" };
const contexto = { id, paciente_id: id, agendamento_id: origem, atendimento_id: null, tipo: "lembrete_agendamento" as const,
  previsao_envio: agora, data_envio: null, status: "pendente", nome: "Pessoa Teste", telefone: "(11) 99999-0000",
  consentimento_whatsapp: true, consentimento_whatsapp_em: agora, data_hora: new Date("2026-10-28T15:00:00Z"), agendamento_status: "pendente",
  data_retorno_sugerida: null, procedimento_ativo: null, retorno_agendado: false };
const consentimento = { id, consentimento_whatsapp: true, consentimento_whatsapp_em: agora };
function cliente(respostas: readonly (readonly unknown[])[] = []) {
  const fila = respostas.map(rows => [...rows]);
  const query = mock(async (_sql: TemplateStringsArray, ..._values: unknown[]) => fila.shift() ?? []);
  const begin = mock(async (fn: (tx: SQL) => unknown) => fn(query as unknown as SQL));
  return { db: Object.assign(query, { begin }) as unknown as SQL, query, begin };
}
function request(method = "GET", path = "/api/notificacoes", body?: unknown, extra: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, { method, headers: { Origin: "http://localhost:3000", Cookie: `sessao=${"a".repeat(64)}`, "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const endpointConsentimento = `/api/pacientes/${id}/consentimento-whatsapp`;
describe("Consentimento explícito sem banco real", () => {
  test.each([null, [], {}, { consentimento_whatsapp: true }, { consentimento_whatsapp: false },
    { consentimento_whatsapp: "true", confirmacao_explicita: true }, { consentimento_whatsapp: true, confirmacao_explicita: false },
    { consentimento_whatsapp: true, confirmacao_explicita: true, data: "2024-01-01" },
  ])("recusa autorização presumida ou entrada inválida %j", async dados => {
    const { db, query, begin } = cliente(); await expect(alterarConsentimento(db, id, dados)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
  });
  test("consulta somente consentimento e valida UUID", async () => {
    const { db, query } = cliente([[{ ...consentimento, historico: "segredo" }]]);
    expect(await obterConsentimento(db, id)).toEqual(consentimento);
    await expect(obterConsentimento(db, "invalido")).rejects.toThrow(); expect(query).toHaveBeenCalledTimes(1);
  });
  test("autorização usa data do servidor e mantém data em repetição idempotente", async () => {
    const { db, query } = cliente([[], [consentimento]]);
    expect(await alterarConsentimento(db, id, { consentimento_whatsapp: true, confirmacao_explicita: true })).toEqual(consentimento);
    expect(query.mock.calls[0]![0].join("?")).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[1]![0].join("?")).toContain("COALESCE(consentimento_whatsapp_em, CURRENT_TIMESTAMP)");
    expect(query.mock.calls[1]!.slice(1)).toEqual([true, true, id]); expect(query).toHaveBeenCalledTimes(2);
  });
  test("revogação cancela pendentes/falhas na mesma transação e respeita constraint", async () => {
    const revoked = { ...consentimento, consentimento_whatsapp: false, consentimento_whatsapp_em: null };
    const { db, query, begin } = cliente([[], [revoked], []]);
    expect(await alterarConsentimento(db, id, { consentimento_whatsapp: false, confirmacao_explicita: true })).toEqual(revoked);
    expect(begin).toHaveBeenCalledTimes(1); expect(query.mock.calls[1]![0].join("?")).toContain("ELSE NULL");
    expect(query.mock.calls[2]![0].join("?")).toContain("status IN ('pendente', 'falhou')");
    expect(query.mock.calls[2]![0].join("?")).toContain("data_envio = NULL");
  });
  test("paciente ausente não grava notificações", async () => {
    const { db, query } = cliente(); await expect(obterConsentimento(db, id)).rejects.toThrow("não encontrado");
    await expect(alterarConsentimento(db, id, { consentimento_whatsapp: false, confirmacao_explicita: true })).rejects.toThrow("não encontrado");
    expect(query).toHaveBeenCalledTimes(3);
  });
  test.each(["administrador", "funcionario"])("%s pode consultar e registrar manifestação explícita", async perfil => {
    const user = { ...usuario, perfil }; const { db } = cliente([[user], [consentimento], [user], [], [consentimento]]);
    const controller = criarConsentimentoController(() => db, false);
    expect((await controller(request("GET", endpointConsentimento))).status).toBe(200);
    expect((await controller(request("PATCH", endpointConsentimento, { consentimento_whatsapp: true, confirmacao_explicita: true }))).status).toBe(200);
  });
});
describe("Preparação WhatsApp sem transporte de rede", () => {
  test.each(["(11) 99999-0000", "+55 11 99999-0000", "5511999990000"])("normaliza %s", telefone => expect(normalizarWhatsApp(telefone)).toBe("5511999990000"));
  test.each(["12345678", "", "telefone", "+000000000000", "0".repeat(20)])("recusa telefone %s", telefone => expect(() => normalizarWhatsApp(telefone)).toThrow());
  test("mensagem discreta usa primeiro nome e template, sem procedimento nem histórico", async () => {
    const result = prepararMensagem("lembrete_agendamento", "Pessoa DadosClínicos", contexto.telefone, contexto.data_hora);
    expect(result.mensagem).toContain("Olá, Pessoa."); expect(result.mensagem).toContain("28/10/2026 às 12:00");
    expect(JSON.stringify(result)).not.toContain("DadosClínicos"); expect(result.payload.type).toBe("template");
    expect(result.payload.messaging_product).toBe("whatsapp"); expect(result.payload.template.language.code).toBe("pt_BR");
    expect(await provedorSimulado.preparar(result.payload)).toEqual({ simulado: true });
    expect(provedorSimulado).not.toHaveProperty("enviar");
  });
  test("mensagem de retorno não divulga data de atendimento nem nome de procedimento", () => {
    const result = prepararMensagem("lembrete_retorno", "Pessoa Teste", contexto.telefone);
    expect(result.mensagem).toContain("combinar seu próximo horário");
    expect(result.mensagem).not.toContain("atendimento"); expect(result.payload.template.components[0]!.parameters).toHaveLength(1);
  });
});
describe("Geração e controle de notificações simulados", () => {
  test.each([
    { ...contexto, consentimento_whatsapp: false }, { ...contexto, consentimento_whatsapp_em: null },
    { ...contexto, agendamento_status: "cancelado" }, { ...contexto, agendamento_status: "realizado" },
    { ...contexto, data_hora: agora },
    { ...contexto, tipo: "lembrete_retorno" as const, data_retorno_sugerida: null },
    { ...contexto, tipo: "lembrete_retorno" as const, data_retorno_sugerida: "2026-10-26", procedimento_ativo: true },
    { ...contexto, tipo: "lembrete_retorno" as const, data_retorno_sugerida: "2026-10-28", procedimento_ativo: false },
    { ...contexto, tipo: "lembrete_retorno" as const, data_retorno_sugerida: "2026-10-28", procedimento_ativo: true, retorno_agendado: true },
  ])("revalida elegibilidade antes de preparar: %j", async c => {
    expect(bloqueioNotificacao(c, agora)).not.toBeNull();
    const { db, query } = cliente([[], [c], []]); const preparar = mock(async () => ({ simulado: true as const }));
    const result = await simularNotificacao(db, id, { modo: "simulado", preparar }, agora);
    expect(result.status).toBe("cancelada"); expect(preparar).not.toHaveBeenCalled();
    expect(query.mock.calls[2]![0].join("?")).toContain("status = 'cancelada'");
  });
  test("sucesso simulado continua pendente e não preenche data_envio", async () => {
    const { db, query } = cliente([[], [contexto], []]); const preparar = mock(async () => ({ simulado: true as const }));
    const result = await simularNotificacao(db, id, { modo: "simulado", preparar }, agora);
    expect(result.preparado).toBe(true); expect(result.status).toBe("pendente"); expect(preparar).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[2]![0].join("?")).toContain("status = 'pendente', data_envio = NULL");
    expect(query.mock.calls.some(call => call[0].join("?").includes("'enviada'"))).toBe(false);
  });
  test.each(["telefone", "provedor"])("falha de %s persiste falhou sem detalhes secretos", async caso => {
    const c = caso === "telefone" ? { ...contexto, telefone: "12345678" } : contexto;
    const { db, query } = cliente([[], [c], []]); const preparar = mock(async () => { throw new Error("segredo do provedor"); });
    const result = await simularNotificacao(db, id, { modo: "simulado", preparar }, agora);
    expect(result.status).toBe("falhou"); expect(JSON.stringify(result)).not.toContain("segredo");
    expect(query.mock.calls[2]![0].join("?")).toContain("status = 'falhou', data_envio = NULL");
    if (caso === "telefone") expect(preparar).not.toHaveBeenCalled();
  });
  test("não aceita provedor real, notificações enviadas ou canceladas", async () => {
    const { db, query } = cliente();
    await expect(simularNotificacao(db, id, { modo: "real" } as unknown as ProvedorWhatsApp, agora)).rejects.toThrow("desativados"); expect(query).not.toHaveBeenCalled();
    for (const status of ["enviada", "cancelada"]) {
      const c = cliente([[], [{ ...contexto, status }]]);
      await expect(simularNotificacao(c.db, id, provedorSimulado, agora)).rejects.toThrow("encerrada"); expect(c.query).toHaveBeenCalledTimes(2);
    }
  });
  test("notificação ausente retorna 404", async () => {
    const { db } = cliente([[], []]); await expect(simularNotificacao(db, id, provedorSimulado, agora)).rejects.toThrow("não encontrada");
  });
  test("prévia limita campos e explica falha sem consentimento", async () => {
    const { db } = cliente([[{ ...contexto, interno: "segredo" }, { ...contexto, consentimento_whatsapp: false }, { ...contexto, status: "falhou", telefone: "12345678" }]]);
    const rows = await listarNotificacoes(db, null, 1, agora);
    expect(rows[0]!.mensagem).toContain("Olá, Pessoa"); expect(rows[0]).not.toHaveProperty("telefone"); expect(rows[0]).not.toHaveProperty("atendimento_id");
    expect(rows[1]!.mensagem).toBeNull(); expect(rows[1]!.pode_simular).toBe(false); expect(rows[2]!.diagnostico).toContain("Telefone");
  });
  test("gera somente fontes elegíveis com consentimento, horários e deduplicação", async () => {
    const candidato = { origem_id: origem, paciente_id: id, tipo: "lembrete_agendamento", data_hora: contexto.data_hora };
    const { db, query } = cliente([[], [], [], [candidato], [], []]);
    expect(await gerarNotificacoes(db, agora)).toEqual({ geradas: 1, atualizadas: 0, canceladas: 0, modo: "simulado" });
    expect(query.mock.calls[0]![0].join("?")).toContain("pg_advisory_xact_lock");
    const sql = query.mock.calls[3]![0].join("?");
    expect(sql).toContain("p.consentimento_whatsapp = true AND p.consentimento_whatsapp_em IS NOT NULL");
    expect(sql).toContain("AND NOT EXISTS"); expect(sql).toContain("+ 7"); expect(sql).toContain("+ 30");
    expect(query.mock.calls[3]!.slice(1)).toEqual([agora, new Date("2026-10-29T12:00:00Z"), "2026-10-27", "2026-10-27"]);
    expect(query.mock.calls[5]!.slice(1)).toEqual([id, origem, null, "lembrete_agendamento", new Date("2026-10-27T15:00:00Z")]);
  });
  test("retorno sem vínculo de agendamento usa atendimento e agenda 09h São Paulo", async () => {
    const { db, query } = cliente([[], [], [], [{ origem_id: origem, paciente_id: id, tipo: "lembrete_retorno", data_retorno_sugerida: "2026-10-28" }], [], []]);
    expect((await gerarNotificacoes(db, agora)).geradas).toBe(1);
    expect(query.mock.calls[5]!.slice(1)).toEqual([id, null, origem, "lembrete_retorno", new Date("2026-10-28T12:00:00Z")]);
  });
  test("não duplica nem reativa notificações existentes de qualquer status", async () => {
    const { db, query } = cliente([[], [], [], [{ origem_id: origem, paciente_id: id, tipo: "lembrete_agendamento", data_hora: contexto.data_hora }], [{ id }]]);
    expect((await gerarNotificacoes(db, agora)).geradas).toBe(0);
    expect(query.mock.calls[4]![0].join("?")).not.toContain("status ="); expect(query).toHaveBeenCalledTimes(5);
  });
  test("reconcilia consentimento revogado e atualiza previsão após reagendamento", async () => {
    const { db, query } = cliente([[], [{ ...contexto, consentimento_whatsapp: false }, contexto], [], [], [], []]);
    const result = await gerarNotificacoes(db, agora);
    expect(result.canceladas).toBe(1); expect(result.atualizadas).toBe(1);
    expect(query.mock.calls[3]![0].join("?")).toContain("status = 'cancelada'");
    expect(query.mock.calls[4]!.slice(1)).toEqual([new Date("2026-10-27T15:00:00Z"), id]);
  });
  test("duas gerações concorrentes usam lock do banco e criam um único registro", async () => {
    let lock = Promise.resolve(); let total = 0;
    const candidato = { origem_id: origem, paciente_id: id, tipo: "lembrete_agendamento", data_hora: contexto.data_hora };
    const db = { begin: async (fn: (tx: SQL) => Promise<unknown>) => {
      let release: (() => void) | undefined;
      const query = async (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        if (sql.includes("pg_advisory_xact_lock")) { const anterior = lock; lock = new Promise<void>(resolve => { release = resolve; }); await anterior; return []; }
        if (sql.includes("FROM notificacoes n")) return [];
        if (sql.includes("UNION ALL")) return [candidato];
        if (sql.includes("SELECT id FROM notificacoes")) return total ? [{ id }] : [];
        if (sql.includes("INSERT INTO notificacoes")) { total++; return []; }
        throw new Error("SQL inesperado");
      };
      try { return await fn(query as unknown as SQL); } finally { release?.(); }
    } } as unknown as SQL;
    const resultados = await Promise.all([gerarNotificacoes(db, agora), gerarNotificacoes(db, agora)]);
    expect(total).toBe(1); expect(resultados.map(r => r.geradas).sort()).toEqual([0, 1]);
  });
  test("cancelamento não pode sobrescrever envio existente", async () => {
    const { db, query } = cliente([[], [{ id, status: "cancelada" }]]);
    expect(await cancelarNotificacao(db, id)).toEqual({ id, status: "cancelada" });
    expect(query.mock.calls[1]![0].join("?")).toContain("status IN ('pendente', 'falhou', 'cancelada')");
    const absent = cliente([[], []]); await expect(cancelarNotificacao(absent.db, id)).rejects.toThrow("já enviada");
  });
});
describe("Notificações: autorização, origem e entradas HTTP", () => {
  const rotas = [
    { method: "GET", path: "/api/notificacoes" }, { method: "POST", path: "/api/notificacoes/gerar" },
    { method: "POST", path: `/api/notificacoes/${id}/simular` }, { method: "POST", path: `/api/notificacoes/${id}/cancelar` },
    { method: "GET", path: "/api/notificacoes/inexistente" },
  ];
  test.each(rotas)("funcionário não acessa $method $path", async op => {
    const { db, query, begin } = cliente([[{ ...usuario, perfil: "funcionario" }]]);
    expect((await criarNotificacoesController(() => db, false)(request(op.method, op.path, op.method === "POST" ? {} : undefined))).status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1); expect(begin).not.toHaveBeenCalled();
  });
  test.each(rotas)("sem cookie não abre banco em $method $path", async op => {
    const getDb = mock(() => { throw new Error("Não conectar"); });
    expect((await criarNotificacoesController(getDb, false)(request(op.method, op.path, op.method === "POST" ? {} : undefined, { Cookie: "" }))).status).toBe(401); expect(getDb).not.toHaveBeenCalled();
  });
  test.each(rotas.filter(op => op.method === "POST"))("origem externa/ausente bloqueia $path", async op => {
    for (const Origin of ["", "https://externo.example"]) {
      const { db, query } = cliente([[usuario]]);
      expect((await criarNotificacoesController(() => db, false)(request(op.method, op.path, {}, { Origin }))).status).toBe(403); expect(query).toHaveBeenCalledTimes(1);
    }
  });
  test("origem protege consentimento dos dois perfis", async () => {
    const { db, query } = cliente([[usuario]]);
    expect((await criarConsentimentoController(() => db, false)(request("PATCH", endpointConsentimento, { consentimento_whatsapp: true, confirmacao_explicita: true }, { Origin: "https://externo.example" }))).status).toBe(403); expect(query).toHaveBeenCalledTimes(1);
  });
  test("admin gera fila vazia sem envio real e consulta sem cache", async () => {
    const { db } = cliente([[usuario], [], [], [], [], [usuario], []]); const controller = criarNotificacoesController(() => db, false);
    const post = await controller(request("POST", "/api/notificacoes/gerar", {})); expect(post.status).toBe(200); expect((await post.json()).modo).toBe("simulado");
    const get = await controller(request()); expect(get.status).toBe(200); expect(get.headers.get("cache-control")).toBe("no-store");
  });
  test.each(["?status=processando", "?pagina=0", "?pagina=1000001"])("valida filtros %s", async suffix => {
    const { db, query } = cliente([[usuario]]); expect((await criarNotificacoesController(() => db, false)(request("GET", `/api/notificacoes${suffix}`))).status).toBe(400); expect(query).toHaveBeenCalledTimes(1);
  });
  test("não aceita status/data_envio ou comandos de envio no corpo", async () => {
    for (const dados of [{ status: "enviada" }, { enviar: true }, [], null]) {
      const { db, query } = cliente([[usuario]]);
      expect((await criarNotificacoesController(() => db, false)(request("POST", "/api/notificacoes/gerar", dados))).status).toBe(400); expect(query).toHaveBeenCalledTimes(1);
    }
  });
  test("valida JSON, tipo de conteúdo e corpo sem abrir transação", async () => {
    for (const [body, type, status] of [["{", "application/json", 400], ["{}", "text/plain", 415], ["x".repeat(4097), "application/json", 413]] as const) {
      const { db, begin } = cliente([[usuario]]);
      const req = new Request("http://localhost:3000/api/notificacoes/gerar", { method: "POST", headers: { Cookie: `sessao=${"a".repeat(64)}`, Origin: "http://localhost:3000", "Content-Type": type }, body });
      expect((await criarNotificacoesController(() => db, false)(req)).status).toBe(status); expect(begin).not.toHaveBeenCalled();
    }
  });
  test("produção preserva cookie __Host e origem HTTPS", async () => {
    const { db } = cliente([[usuario], []]); const controller = criarNotificacoesController(() => db, true, "https://clinica.example");
    expect((await controller(request())).status).toBe(401);
    expect((await controller(request("GET", "/api/notificacoes", undefined, { Cookie: `__Host-sessao=${"a".repeat(64)}` }))).status).toBe(200);
  });
  test.each([0, 51])("pagina %s notificações", async count => {
    const { db } = cliente([[usuario], Array.from({ length: count }, () => contexto)]);
    const response = await criarNotificacoesController(() => db, false)(request()); const data = await response.json();
    expect(data.notificacoes).toHaveLength(Math.min(count, 50)); expect(data.temMais).toBe(count > 50);
  });
  test("erros SQL não vazam detalhes", async () => {
    const query = mock(async () => { throw new Error("credencial secreta"); });
    const response = await criarNotificacoesController(() => query as unknown as SQL, false)(request());
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("secreta");
  });
  test("rotas integradas exigem sessão sem Neon", async () => {
    expect((await handleRequest(request("GET", "/api/notificacoes", undefined, { Cookie: "" }))).status).toBe(401);
    expect((await handleRequest(request("GET", endpointConsentimento, undefined, { Cookie: "" }))).status).toBe(401);
  });
  test.each(["DELETE", "PATCH", "HEAD"])("não permite %s em notificações", async method => {
    const { db } = cliente([[usuario]]); const response = await criarNotificacoesController(() => db, false)(request(method));
    expect(response.status).toBe(405); if (method === "HEAD") expect(await response.text()).toBe("");
  });
});
