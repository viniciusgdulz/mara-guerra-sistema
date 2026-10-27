import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { ajustarRetorno, cadastrarAtendimento, calcularRetorno, historicoPaciente } from "../src/services/atendimentos.service";
import { criarAtendimentosController } from "../src/controllers/atendimentos.controller";
import { handleRequest } from "../src/app";

const paciente = "00000000-0000-4000-8000-000000000001";
const procedimento = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000003";
const dados = { paciente_id: paciente, procedimento_id: procedimento, data_atendimento: "2024-02-28" };
const atendimento = { id, ...dados, data_retorno_sugerida: "2024-03-01" };
const usuario = { id: "admin-teste", nome: "Administrador Teste", email: "admin@example.com", perfil: "administrador" };
function cliente(respostas: unknown[][] = []) {
  const query = mock(async (_sql: TemplateStringsArray, ..._values: unknown[]) => respostas.shift() ?? []);
  const begin = mock(async (fn: (tx: SQL) => unknown) => fn(query as unknown as SQL));
  const db = Object.assign(query, { begin }) as unknown as SQL;
  return { db, query, begin };
}
function request(method = "GET", path = `/api/atendimentos?paciente_id=${paciente}`, body?: unknown, extra: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, { method, headers: { Origin: "http://localhost:3000", Cookie: `sessao=${"a".repeat(64)}`, "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("Atendimentos: validação e transações simuladas", () => {
  test.each([
    ["2024-02-28", 2, "2024-03-01"], ["2025-12-31", 1, "2026-01-01"],
    ["2024-03-09", 2, "2024-03-11"], ["2024-02-29", null, null],
  ] as const)("calcula %s + %s dias", (data, dias, esperado) => expect(calcularRetorno(data, dias)).toBe(esperado));
  test("intervalo excessivo recebe erro claro", () => expect(() => calcularRetorno("2024-01-01", 2147483647)).toThrow("Ajuste o retorno manualmente"));
  test.each([null, [], {}, { ...dados, paciente_id: "invalido" }, { ...dados, procedimento_id: 123 },
    { ...dados, data_atendimento: "2025-02-29" }, { ...dados, data_atendimento: "2024-02-30" },
    { ...dados, data_atendimento: "0000-01-01" }, { ...dados, data_atendimento: "9999-01-01" },
    { ...dados, data_atendimento: "01/01/2024" }, { ...dados, data_atendimento: null },
    { ...dados, data_retorno_sugerida: "2024-02-27" }, { ...dados, data_retorno_sugerida: "" },
    { ...dados, data_retorno_sugerida: "2024-02-30" }, { ...dados, data_retorno_sugerida: 123 },
    { ...dados, procedimento_ativo: true },
  ])("rejeita entrada inválida antes de abrir transação: %j", async entrada => {
    const { db, query, begin } = cliente();
    await expect(cadastrarAtendimento(db, entrada)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
  });
  test.each([2, null])("cadastro calcula retorno com intervalo %s e bloqueia procedimento", async intervalo => {
    const retorno = intervalo === null ? null : "2024-03-01";
    const { db, query, begin } = cliente([[{ id: paciente }], [{ intervalo_retorno_dias: intervalo }], [{ ...atendimento, data_retorno_sugerida: retorno, segredo: "interno" }]]);
    expect(await cadastrarAtendimento(db, dados)).toEqual({ ...atendimento, data_retorno_sugerida: retorno });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0].join("?")).toContain("FOR KEY SHARE");
    expect(query.mock.calls[1]![0].join("?")).toContain("AND ativo = true FOR SHARE");
    expect(query.mock.calls[2]!.slice(1)).toEqual([paciente, procedimento, "2024-02-28", retorno]);
    expect(query.mock.calls[2]![0].join("?")).not.toContain(paciente);
  });
  test.each([null, "2024-02-28", "2024-03-15"])("permite retorno manual %s e ignora cálculo excessivo", async retorno => {
    const { db, query } = cliente([[{ id: paciente }], [{ intervalo_retorno_dias: 2147483647 }], [{ ...atendimento, data_retorno_sugerida: retorno }]]);
    await cadastrarAtendimento(db, { ...dados, data_retorno_sugerida: retorno });
    expect(query.mock.calls[2]![4]).toBe(retorno);
  });
  test("paciente ausente não permite inserir", async () => {
    const { db, query } = cliente();
    await expect(cadastrarAtendimento(db, dados)).rejects.toThrow("Paciente não encontrado");
    expect(query).toHaveBeenCalledTimes(1);
  });
  test("procedimento ausente ou inativo não permite inserir", async () => {
    const { db, query } = cliente([[{ id: paciente }], []]);
    await expect(cadastrarAtendimento(db, dados)).rejects.toThrow("procedimento ativo existente");
    expect(query).toHaveBeenCalledTimes(2);
  });
  test("falha de cálculo interrompe transação sem INSERT", async () => {
    const { db, query, begin } = cliente([[{ id: paciente }], [{ intervalo_retorno_dias: 2147483647 }]]);
    await expect(cadastrarAtendimento(db, dados)).rejects.toThrow();
    expect(begin).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(2);
  });
  test.each([null, "2024-03-10"])("ajuste %s muda somente retorno", async retorno => {
    const { db, query } = cliente([[{ data_atendimento: dados.data_atendimento }], [{ ...atendimento, data_retorno_sugerida: retorno }]]);
    expect((await ajustarRetorno(db, id, { data_retorno_sugerida: retorno })).data_retorno_sugerida).toBe(retorno);
    expect(query.mock.calls[0]![0].join("?")).toContain("FOR UPDATE");
    expect(query.mock.calls[1]![0].join("?")).toContain("UPDATE atendimentos SET data_retorno_sugerida = ? WHERE id = ?");
    expect(query.mock.calls[1]!.slice(1)).toEqual([retorno, id]);
  });
  test("ajuste anterior ao atendimento não grava", async () => {
    const { db, query } = cliente([[{ data_atendimento: dados.data_atendimento }]]);
    await expect(ajustarRetorno(db, id, { data_retorno_sugerida: "2024-02-27" })).rejects.toThrow("anterior");
    expect(query).toHaveBeenCalledTimes(1);
  });
  test("ajuste ausente e campos extras são recusados", async () => {
    const { db, query } = cliente();
    await expect(ajustarRetorno(db, id, {})).rejects.toThrow();
    await expect(ajustarRetorno(db, id, { data_retorno_sugerida: null, paciente_id: paciente })).rejects.toThrow();
    await expect(ajustarRetorno(db, "id-invalido", { data_retorno_sugerida: null })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  test("ajuste inexistente retorna não encontrado", async () => {
    const { db } = cliente();
    await expect(ajustarRetorno(db, id, { data_retorno_sugerida: null })).rejects.toThrow("Atendimento não encontrado");
  });
  test("histórico preserva procedimento inativo, projeta campos e ordena datas", async () => {
    const row = { ...atendimento, procedimento_nome: "Procedimento Teste", procedimento_ativo: false };
    const { db, query } = cliente([[{ id: paciente }], [{ ...row, segredo: "interno" }]]);
    expect(await historicoPaciente(db, paciente, 2)).toEqual([row]);
    const [sql, ...values] = query.mock.calls[1]!;
    expect(sql.join("?")).toContain("ORDER BY a.data_atendimento ASC, a.id ASC");
    expect(sql.join("?")).not.toContain("ativo = true");
    expect(values).toEqual([paciente, 50]);
  });
  test("histórico de paciente inexistente retorna não encontrado", async () => {
    const { db } = cliente();
    await expect(historicoPaciente(db, paciente, 1)).rejects.toThrow("Paciente não encontrado");
  });
});

describe("Atendimentos: HTTP e autorização", () => {
  const rotas = [
    { method: "GET", path: `/api/atendimentos?paciente_id=${paciente}`, body: undefined },
    { method: "GET", path: "/api/atendimentos/procedimentos", body: undefined },
    { method: "POST", path: "/api/atendimentos", body: dados },
    { method: "PATCH", path: `/api/atendimentos/${id}/retorno`, body: { data_retorno_sugerida: null } },
    { method: "DELETE", path: `/api/atendimentos/${id}`, body: undefined },
  ];
  test.each(rotas)("bloqueia funcionário em $method $path antes de acessar dados clínicos", async op => {
    const { db, query, begin } = cliente([[{ ...usuario, perfil: "funcionario" }]]);
    const response = await criarAtendimentosController(() => db, false)(request(op.method, op.path, op.body));
    expect(response.status).toBe(403); expect(query).toHaveBeenCalledTimes(1); expect(begin).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test.each(rotas)("bloqueia sem cookie em $method $path sem conexão", async op => {
    const getDb = mock(() => { throw new Error("Não conectar"); });
    expect((await criarAtendimentosController(getDb, false)(request(op.method, op.path, op.body, { Cookie: "" }))).status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
  });
  test("sessão expirada e perfil desconhecido não acessam histórico", async () => {
    for (const rows of [[], [{ ...usuario, perfil: "visitante" }]]) {
      const { db, query } = cliente([rows]);
      expect((await criarAtendimentosController(() => db, false)(request())).status).toBe(rows.length ? 403 : 401);
      expect(query).toHaveBeenCalledTimes(1);
    }
  });
  test("administrador cadastra com cálculo e ajusta retorno", async () => {
    const { db } = cliente([[usuario], [{ id: paciente }], [{ intervalo_retorno_dias: 2 }], [atendimento], [usuario], [{ data_atendimento: dados.data_atendimento }], [{ ...atendimento, data_retorno_sugerida: null }]]);
    const controller = criarAtendimentosController(() => db, false);
    const post = await controller(request("POST", "/api/atendimentos", dados));
    expect(post.status).toBe(201); expect((await post.json()).atendimento).toEqual(atendimento);
    const patch = await controller(request("PATCH", `/api/atendimentos/${id}/retorno`, { data_retorno_sugerida: null }));
    expect(patch.status).toBe(200); expect((await patch.json()).atendimento.data_retorno_sugerida).toBeNull();
  });
  test("catálogo de seleção força ativos mesmo para administrador", async () => {
    const { db, query } = cliente([[usuario], []]);
    const response = await criarAtendimentosController(() => db, false)(request("GET", "/api/atendimentos/procedimentos?ativo=false"));
    expect(response.status).toBe(200); expect(query.mock.calls[1]![1]).toBe(false);
  });
  test.each([0, 51])("histórico paginado com %s resultados", async count => {
    const { db } = cliente([[usuario], [{ id: paciente }], Array.from({ length: count }, () => ({ ...atendimento, procedimento_nome: "Teste", procedimento_ativo: false }))]);
    const response = await criarAtendimentosController(() => db, false)(request());
    const data = await response.json();
    expect(response.status).toBe(200); expect(data.atendimentos).toHaveLength(Math.min(count, 50)); expect(data.temMais).toBe(count > 50);
  });
  test.each(["POST", "PATCH"])("origem inválida bloqueia %s", async method => {
    for (const Origin of ["", "https://externo.example"]) {
      const { db, query, begin } = cliente([[usuario]]);
      const path = method === "POST" ? "/api/atendimentos" : `/api/atendimentos/${id}/retorno`;
      expect((await criarAtendimentosController(() => db, false)(request(method, path, dados, { Origin }))).status).toBe(403);
      expect(query).toHaveBeenCalledTimes(1); expect(begin).not.toHaveBeenCalled();
    }
  });
  test("produção exige cookie __Host e origem HTTPS configurada", async () => {
    const { db } = cliente([[usuario], [{ id: paciente }], [{ intervalo_retorno_dias: 2 }], [atendimento]]);
    const controller = criarAtendimentosController(() => db, true, "https://clinica.example");
    expect((await controller(request("POST", "/api/atendimentos", dados, { Origin: "https://clinica.example" }))).status).toBe(401);
    expect((await controller(request("POST", "/api/atendimentos", dados, { Origin: "https://clinica.example", Cookie: `__Host-sessao=${"a".repeat(64)}` }))).status).toBe(201);
  });
  test.each(["?pagina=0", "?pagina=NaN", "?pagina=1000001", "?paciente_id=invalido"])("valida consulta %s", async suffix => {
    const { db, query } = cliente([[usuario]]);
    expect((await criarAtendimentosController(() => db, false)(request("GET", `/api/atendimentos${suffix}`))).status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
  test("tipo de conteúdo, JSON e tamanho inválidos não gravam", async () => {
    for (const [body, type, status] of [["{", "application/json", 400], ["{}", "text/plain", 415], ["x".repeat(4097), "application/json", 413], ["{}", "application/json", 400]] as const) {
      const { db, query, begin } = cliente([[usuario]]);
      const req = new Request("http://localhost:3000/api/atendimentos", { method: "POST", headers: { Cookie: `sessao=${"a".repeat(64)}`, Origin: "http://localhost:3000", "Content-Type": type }, body });
      expect((await criarAtendimentosController(() => db, false)(req)).status).toBe(status);
      expect(query).toHaveBeenCalledTimes(1); expect(begin).not.toHaveBeenCalled();
    }
  });
  test("erros de banco são ocultados", async () => {
    let calls = 0;
    const query = mock(async () => { if (++calls === 1) return [usuario]; throw new Error("segredo SQL"); });
    const response = await criarAtendimentosController(() => query as unknown as SQL, false)(request());
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("segredo");
  });
  test("integração exige sessão sem acessar Neon", async () => {
    expect((await handleRequest(request("GET", "/api/atendimentos", undefined, { Cookie: "" }))).status).toBe(401);
  });
  test.each(["DELETE", "PUT", "HEAD"])("recusa %s para administrador", async method => {
    const { db } = cliente([[usuario]]);
    const response = await criarAtendimentosController(() => db, false)(request(method, "/api/atendimentos"));
    expect(response.status).toBe(405);
    if (method === "HEAD") expect(await response.text()).toBe("");
  });
});
