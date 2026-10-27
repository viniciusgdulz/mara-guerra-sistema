import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { agendarRetorno, criarAgendamento, horarioAgenda, listarAgenda, listarRetornos, mudarStatus, reagendar } from "../src/services/agenda.service";
import { criarAgendaController } from "../src/controllers/agenda.controller";
import { handleRequest } from "../src/app";
const paciente = "00000000-0000-4000-8000-000000000001";
const procedimento = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000003";
const dados = { paciente_id: paciente, procedimento_id: procedimento, data: "2026-10-27", hora: "10:30" };
const booking = { id, paciente_id: paciente, procedimento_id: procedimento, data_hora: new Date("2026-10-27T13:30:00Z"), status: "pendente" };
const usuario = { id: "admin-teste", nome: "Equipe Teste", email: "equipe@example.com", perfil: "administrador" };
function cliente(respostas: readonly (readonly unknown[])[] = []) {
  const fila = respostas.map(rows => [...rows]);
  const query = mock(async (_sql: TemplateStringsArray, ..._values: unknown[]) => fila.shift() ?? []);
  const begin = mock(async (fn: (tx: SQL) => unknown) => fn(query as unknown as SQL));
  return { db: Object.assign(query, { begin }) as unknown as SQL, query, begin };
}
function request(method = "GET", path = "/api/agenda?data=2026-10-27", body?: unknown, extra: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, { method, headers: { Origin: "http://localhost:3000", Cookie: `sessao=${"a".repeat(64)}`, "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("Agenda: validação e transações simuladas", () => {
  test("converte horário de São Paulo sem depender do fuso do servidor", () => {
    expect(horarioAgenda("2026-10-27", "10:30").toISOString()).toBe("2026-10-27T13:30:00.000Z");
    expect(horarioAgenda("2026-10-27", "23:59").toISOString()).toBe("2026-10-28T02:59:00.000Z");
    expect(horarioAgenda("2024-02-29", "00:00").toISOString()).toBe("2024-02-29T03:00:00.000Z");
    expect(() => horarioAgenda("2018-11-04", "00:30")).toThrow("Horário inexistente");
  });
  test.each([null, [], {}, { ...dados, paciente_id: "inválido" }, { ...dados, procedimento_id: null },
    { ...dados, data: "2025-02-29" }, { ...dados, data: "0000-01-01" }, { ...dados, hora: "24:00" },
    { ...dados, hora: "10:60" }, { ...dados, hora: "10:00:00" }, { ...dados, hora: 123 }, { ...dados, status: "realizado" },
  ])("valida antes de SQL: %j", async entrada => {
    const { db, query, begin } = cliente();
    await expect(criarAgendamento(db, entrada)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
  });
  test("cadastro bloqueia paciente, valida ativo e duplicidade, usa parâmetros e projeção", async () => {
    const { db, query, begin } = cliente([[{ id: paciente }], [{ id: procedimento }], [], [{ ...booking, interno: "segredo" }]]);
    expect(await criarAgendamento(db, dados)).toEqual(booking); expect(begin).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0].join("?")).toContain("FOR UPDATE");
    expect(query.mock.calls[1]![0].join("?")).toContain("AND ativo = true FOR SHARE");
    expect(query.mock.calls[2]![0].join("?")).toContain("status <> 'cancelado'");
    expect(query.mock.calls[3]!.slice(1)).toEqual([paciente, procedimento, booking.data_hora]);
    expect(query.mock.calls[3]![0].join("?")).toContain("'pendente'");
  });
  test.each([
    { respostas: [[], [], []], mensagem: "Paciente não encontrado", chamadas: 1 },
    { respostas: [[{ id: paciente }], [], []], mensagem: "procedimento ativo", chamadas: 2 },
    { respostas: [[{ id: paciente }], [{ id: procedimento }], [{ id }]], mensagem: "Já existe", chamadas: 3 },
  ])("recusa ausência, inatividade ou duplicidade: $mensagem", async caso => {
    const { db, query } = cliente(caso.respostas);
    await expect(criarAgendamento(db, dados)).rejects.toThrow(caso.mensagem);
    expect(query).toHaveBeenCalledTimes(caso.chamadas);
  });
  test("duas criações concorrentes do mesmo paciente e horário geram um único registro", async () => {
    let lock: Promise<void> = Promise.resolve(); let total = 0;
    const db = { begin: async (fn: (tx: SQL) => Promise<unknown>) => {
      let release: (() => void) | undefined;
      const query = async (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        if (sql.includes("FROM pacientes")) {
          const anterior = lock; lock = new Promise<void>(resolve => { release = resolve; }); await anterior; return [{ id: paciente }];
        }
        if (sql.includes("FROM procedimentos")) return [{ id: procedimento }];
        if (sql.includes("SELECT id FROM agendamentos")) return total ? [{ id }] : [];
        if (sql.includes("INSERT INTO agendamentos")) { total++; return [booking]; }
        throw new Error("SQL inesperado");
      };
      try { return await fn(query as unknown as SQL); } finally { release?.(); }
    } } as unknown as SQL;
    const resultados = await Promise.allSettled([criarAgendamento(db, dados), criarAgendamento(db, dados)]);
    expect(total).toBe(1); expect(resultados.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(resultados.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  test("reagendamento mantém paciente e status e exclui o próprio id da duplicidade", async () => {
    const { db, query } = cliente([[booking], [{ id: paciente }], [{ id: procedimento }], [], [booking]]);
    expect(await reagendar(db, id, { procedimento_id: procedimento, data: dados.data, hora: dados.hora })).toEqual(booking);
    expect(query.mock.calls[3]!.slice(3)).toEqual([id, id]);
    const sql = query.mock.calls[4]![0].join("?");
    expect(sql).not.toContain("paciente_id ="); expect(sql).not.toContain("status =");
  });
  test.each(["realizado", "cancelado", "nao_compareceu"])("não reagenda status encerrado %s", async status => {
    const { db, query } = cliente([[{ ...booking, status }]]);
    await expect(reagendar(db, id, { procedimento_id: procedimento, data: dados.data, hora: dados.hora })).rejects.toThrow("em aberto"); expect(query).toHaveBeenCalledTimes(1);
  });
  test.each(["cancelado", "realizado"])("muda para %s e permite repetir sem nova gravação", async status => {
    const { db, query } = cliente([[booking], [{ ...booking, status }], [{ ...booking, status }]]);
    expect((await mudarStatus(db, id, status)).status).toBe(status);
    expect((await mudarStatus(db, id, status)).status).toBe(status);
    expect(query).toHaveBeenCalledTimes(3);
  });
  test("status inválido ou encerrado não pode ser alterado", async () => {
    const { db, query } = cliente([[{ ...booking, status: "cancelado" }]]);
    await expect(mudarStatus(db, id, "agendado")).rejects.toThrow("Status inválido");
    await expect(mudarStatus(db, id, "realizado")).rejects.toThrow("encerrado"); expect(query).toHaveBeenCalledTimes(1);
  });
  test("registro inexistente retorna erro sem atualização", async () => {
    const { db } = cliente();
    await expect(mudarStatus(db, id, "cancelado")).rejects.toThrow("não encontrado");
    await expect(reagendar(db, id, { procedimento_id: procedimento, data: dados.data, hora: dados.hora })).rejects.toThrow("não encontrado");
  });
  test("consulta diária busca literal, considera São Paulo e não consulta atendimentos", async () => {
    const row = { ...booking, paciente_nome: "Teste", paciente_telefone: "00000000", procedimento_nome: null };
    const { db, query } = cliente([[{ ...row, historico: "segredo" }]]);
    expect(await listarAgenda(db, dados.data, "%_\\'", 2)).toEqual([row]);
    const [sql, ...values] = query.mock.calls[0]!;
    expect(sql.join("?")).toContain("AT TIME ZONE 'America/Sao_Paulo'");
    expect(sql.join("?")).toContain("LEFT JOIN procedimentos"); expect(sql.join("?")).not.toContain("atendimentos");
    expect(values).toEqual([dados.data, "%\\%\\_\\\\'%", 50]);
  });
  test("retornos filtra datas e limita campos internos", async () => {
    const row = { sugestao_id: id, paciente_id: paciente, procedimento_id: procedimento, data_retorno_sugerida: "2026-10-27", paciente_nome: "Teste", procedimento_nome: "Teste", procedimento_ativo: false };
    const { db, query } = cliente([[{ ...row, data_atendimento: "segredo" }]]);
    expect(await listarRetornos(db, "2026-10-01", "2026-10-31", 2)).toEqual([row]);
    expect(query.mock.calls[0]!.slice(1)).toEqual(["2026-10-01", "2026-10-31", 50]);
    await expect(listarRetornos(db, "2026-10-31", "2026-10-01", 1)).rejects.toThrow();
    await expect(listarRetornos(db, "2020-01-01", "2026-01-01", 1)).rejects.toThrow();
  });
  test("retorno exige sugestão existente e usa seus vínculos sem aceitar substituição", async () => {
    const { db, query } = cliente([[{ paciente_id: paciente, procedimento_id: procedimento }], [{ id: paciente }], [{ id: procedimento }], [], [booking]]);
    expect(await agendarRetorno(db, id, { data: dados.data, hora: dados.hora })).toEqual(booking);
    expect(query.mock.calls[0]![0].join("?")).toContain("data_retorno_sugerida IS NOT NULL FOR SHARE");
    expect(query.mock.calls[4]!.slice(1)).toEqual([paciente, procedimento, booking.data_hora]);
    await expect(agendarRetorno(db, id, { data: dados.data, hora: dados.hora, paciente_id: paciente })).rejects.toThrow();
  });
  test("retorno ausente ou procedimento inativo não agenda", async () => {
    const { db } = cliente(); await expect(agendarRetorno(db, id, { data: dados.data, hora: dados.hora })).rejects.toThrow("Sugestão");
    const outro = cliente([[{ paciente_id: paciente, procedimento_id: procedimento }], [{ id: paciente }], []]);
    await expect(agendarRetorno(outro.db, id, { data: dados.data, hora: dados.hora })).rejects.toThrow("ativo");
  });
});

describe("Agenda: autorização e HTTP", () => {
  const operacoes = [
    { method: "GET", path: "/api/agenda?data=2026-10-27", body: undefined },
    { method: "GET", path: "/api/agenda/procedimentos", body: undefined },
    { method: "POST", path: "/api/agenda", body: dados },
    { method: "PUT", path: `/api/agenda/${id}`, body: { procedimento_id: procedimento, data: dados.data, hora: dados.hora } },
    { method: "PATCH", path: `/api/agenda/${id}/status`, body: { status: "cancelado" } },
    { method: "GET", path: "/api/agenda/retornos?inicio=2026-10-01&fim=2026-10-31", body: undefined },
    { method: "POST", path: `/api/agenda/retornos/${id}/agendar`, body: { data: dados.data, hora: dados.hora } },
  ];
  test.each(operacoes)("sem sessão bloqueia $method $path sem banco", async op => {
    const getDb = mock(() => { throw new Error("Não conectar"); });
    expect((await criarAgendaController(getDb, false)(request(op.method, op.path, op.body, { Cookie: "" }))).status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
  });
  test.each(["administrador", "funcionario"])("%s cria, consulta, reagenda e cancela", async perfil => {
    const user = { ...usuario, perfil };
    const { db } = cliente([[user], [{ id: paciente }], [{ id: procedimento }], [], [booking], [user], [], [user], [booking], [{ id: paciente }], [{ id: procedimento }], [], [booking], [user], [booking], [{ ...booking, status: "cancelado" }]]);
    const controller = criarAgendaController(() => db, false);
    expect((await controller(request("POST", "/api/agenda", dados))).status).toBe(201);
    expect((await controller(request())).status).toBe(200);
    expect((await controller(request("PUT", `/api/agenda/${id}`, { procedimento_id: procedimento, data: dados.data, hora: dados.hora }))).status).toBe(200);
    expect((await controller(request("PATCH", `/api/agenda/${id}/status`, { status: "cancelado" }))).status).toBe(200);
  });
  test.each(["/api/agenda/retornos", `/api/agenda/retornos/${id}/agendar`, "/api/agenda/retornos/inexistente"])("funcionário não acessa retornos %s", async path => {
    const { db, query, begin } = cliente([[{ ...usuario, perfil: "funcionario" }]]);
    const response = await criarAgendaController(() => db, false)(request(path.endsWith("agendar") ? "POST" : "GET", path, path.endsWith("agendar") ? dados : undefined));
    expect(response.status).toBe(403); expect(query).toHaveBeenCalledTimes(1); expect(begin).not.toHaveBeenCalled();
  });
  test("somente administrador conclui; funcionário não injeta campos clínicos", async () => {
    const { db, query } = cliente([[{ ...usuario, perfil: "funcionario" }], [{ ...usuario, perfil: "funcionario" }], [usuario], [booking], [{ ...booking, status: "realizado" }]]);
    const controller = criarAgendaController(() => db, false);
    expect((await controller(request("PATCH", `/api/agenda/${id}/status`, { status: "realizado" }))).status).toBe(403);
    expect((await controller(request("POST", "/api/agenda", { ...dados, atendimento_id: id }))).status).toBe(400);
    expect((await controller(request("PATCH", `/api/agenda/${id}/status`, { status: "realizado" }))).status).toBe(200);
    expect(query).toHaveBeenCalledTimes(5);
  });
  test("administrador consulta retornos e agenda por sugestão", async () => {
    const { db } = cliente([[usuario], [], [usuario], [{ paciente_id: paciente, procedimento_id: procedimento }], [{ id: paciente }], [{ id: procedimento }], [], [booking]]);
    const controller = criarAgendaController(() => db, false);
    expect((await controller(request("GET", "/api/agenda/retornos?inicio=2026-10-01&fim=2026-10-31"))).status).toBe(200);
    expect((await controller(request("POST", `/api/agenda/retornos/${id}/agendar`, { data: dados.data, hora: dados.hora }))).status).toBe(201);
  });
  test.each(operacoes.filter(op => op.method !== "GET"))("origem protege $method $path", async op => {
    for (const Origin of ["", "https://externo.example"]) {
      const { db, query, begin } = cliente([[usuario]]);
      expect((await criarAgendaController(() => db, false)(request(op.method, op.path, op.body, { Origin }))).status).toBe(403);
      expect(query).toHaveBeenCalledTimes(1); expect(begin).not.toHaveBeenCalled();
    }
  });
  test("cookie e origem de produção são preservados", async () => {
    const { db } = cliente([[usuario], [{ id: paciente }], [{ id: procedimento }], [], [booking]]);
    const controller = criarAgendaController(() => db, true, "https://clinica.example");
    expect((await controller(request("POST", "/api/agenda", dados, { Origin: "https://clinica.example" }))).status).toBe(401);
    expect((await controller(request("POST", "/api/agenda", dados, { Origin: "https://clinica.example", Cookie: `__Host-sessao=${"a".repeat(64)}` }))).status).toBe(201);
  });
  test.each(["?data=2025-02-29", "?data=2026-10-27&pagina=0", "?data=2026-10-27&pagina=1000001", `?data=2026-10-27&nome=${"a".repeat(151)}`])("consulta inválida %s não acessa agenda", async suffix => {
    const { db, query } = cliente([[usuario]]);
    expect((await criarAgendaController(() => db, false)(request("GET", `/api/agenda${suffix}`))).status).toBe(400); expect(query).toHaveBeenCalledTimes(1);
  });
  test("tipo, JSON e corpo inválidos não abrem transação", async () => {
    for (const [body, type, status] of [["{", "application/json", 400], ["{}", "text/plain", 415], ["x".repeat(4097), "application/json", 413], ["{}", "application/json", 400]] as const) {
      const { db, begin } = cliente([[usuario]]);
      const req = new Request("http://localhost:3000/api/agenda", { method: "POST", headers: { Cookie: `sessao=${"a".repeat(64)}`, Origin: "http://localhost:3000", "Content-Type": type }, body });
      expect((await criarAgendaController(() => db, false)(req)).status).toBe(status); expect(begin).not.toHaveBeenCalled();
    }
  });
  test("duplicidade retorna 409; falha inesperada oculta detalhes", async () => {
    const { db } = cliente([[usuario], [{ id: paciente }], [{ id: procedimento }], [{ id }]]);
    expect((await criarAgendaController(() => db, false)(request("POST", "/api/agenda", dados))).status).toBe(409);
    const query = mock(async () => { throw new Error("credencial secreta"); });
    const response = await criarAgendaController(() => query as unknown as SQL, false)(request());
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("secreta"); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test.each([0, 51])("consulta paginada com %s resultados e sem cache", async count => {
    const { db } = cliente([[usuario], Array.from({ length: count }, () => ({ ...booking, paciente_nome: "Teste", paciente_telefone: "00000000", procedimento_nome: "Teste" }))]);
    const response = await criarAgendaController(() => db, false)(request()); const data = await response.json();
    expect(data.agendamentos).toHaveLength(Math.min(count, 50)); expect(data.temMais).toBe(count > 50); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test("catálogo da Agenda sempre filtra ativos", async () => {
    const { db, query } = cliente([[usuario], []]);
    expect((await criarAgendaController(() => db, false)(request("GET", "/api/agenda/procedimentos?ativo=false"))).status).toBe(200);
    expect(query.mock.calls[1]![1]).toBe(false);
  });
  test("perfil desconhecido e sessão inválida não acessam dados", async () => {
    for (const rows of [[], [{ ...usuario, perfil: "visitante" }]]) {
      const { db, query } = cliente([rows]);
      expect((await criarAgendaController(() => db, false)(request())).status).toBe(rows.length ? 403 : 401); expect(query).toHaveBeenCalledTimes(1);
    }
  });
  test.each(["DELETE", "HEAD"])("recusa %s sem expor dados", async method => {
    const { db } = cliente([[usuario]]);
    const response = await criarAgendaController(() => db, false)(request(method, "/api/agenda"));
    expect(response.status).toBe(405); if (method === "HEAD") expect(await response.text()).toBe("");
  });
  test("rota integrada exige sessão sem abrir Neon", async () => {
    expect((await handleRequest(request("GET", "/api/agenda", undefined, { Cookie: "" }))).status).toBe(401);
  });
});
