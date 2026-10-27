import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { cadastrarPaciente, listarPacientes } from "../src/services/pacientes.service";
import { criarPacientesController } from "../src/controllers/pacientes.controller";
import { handleRequest } from "../src/app";

const paciente = { id: "p1", nome: "Pessoa Teste", telefone: "(11) 99999-0000", email: null, data_nascimento: null, data_cadastro: new Date("2026-01-01") };
const dados = { nome: " Pessoa Teste ", telefone: " (11) 99999-0000 " };
function cliente(respostas: unknown[][] = []) {
  const query = mock(async (_sql: TemplateStringsArray, ..._values: unknown[]) => respostas.shift() ?? []);
  return { query, db: query as unknown as SQL };
}
function request(method = "GET", body?: unknown, extra: Record<string, string> = {}, path = "/api/pacientes") {
  return new Request(`http://localhost:3000${path}`, { method, headers: {
    Origin: "http://localhost:3000", "Content-Type": "application/json", Cookie: `sessao=${"a".repeat(64)}`, ...extra,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const usuario = { id: "u1", nome: "Equipe", email: "equipe@example.com", perfil: "funcionario" };

describe("Pacientes: serviço com banco simulado", () => {
  test.each([null, [], {}, { ...dados, nome: " " }, { ...dados, nome: "a".repeat(151) },
    { ...dados, telefone: 123 }, { ...dados, telefone: "abc12345678" }, { ...dados, telefone: "123" },
    { ...dados, telefone: "1".repeat(21) }, { ...dados, email: 2 }, { ...dados, email: "invalido" },
    { ...dados, email: "a".repeat(250) + "@ex.com" }, { ...dados, data_nascimento: 123 },
    { ...dados, data_nascimento: "2025-02-29" }, { ...dados, data_nascimento: "2024-02-30" },
    { ...dados, data_nascimento: "9999-01-01" }, { ...dados, data_nascimento: "0000-01-01" },
    { ...dados, data_nascimento: "01/01/2000" },
  ])("rejeita dados inválidos antes de SQL: %j", async entrada => {
    const { db, query } = cliente();
    await expect(cadastrarPaciente(db, entrada)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  test("normaliza opcionais e limita campos expostos e inseridos", async () => {
    const { db, query } = cliente([[{ ...paciente, historico_clinico: "segredo" }], [paciente]]);
    expect(await cadastrarPaciente(db, { ...dados, consentimento_whatsapp: true })).toEqual(paciente);
    const [sql, ...values] = query.mock.calls[0]!;
    expect(sql.join("?")).toContain("INSERT INTO pacientes (nome, telefone, email, data_nascimento)");
    expect(values).toEqual(["Pessoa Teste", "(11) 99999-0000", null, null]);
    await cadastrarPaciente(db, { ...dados, email: " TESTE@EXAMPLE.COM ", data_nascimento: "2000-02-29" });
    expect(query.mock.calls[1]!.slice(1)).toEqual(["Pessoa Teste", "(11) 99999-0000", "teste@example.com", "2000-02-29"]);
  });
  test("aceita campos opcionais vazios e limites do schema", async () => {
    const { db, query } = cliente([[paciente]]);
    await cadastrarPaciente(db, { nome: "a".repeat(150), telefone: "+55 (11) 99999-0000", email: " ", data_nascimento: "" });
    expect(query.mock.calls[0]!.slice(3)).toEqual([null, null]);
  });
  test("busca parametrizada, curingas literais, paginação e projeção segura", async () => {
    const { db, query } = cliente([[{ ...paciente, historico_clinico: "segredo" }]]);
    const busca = "%' OR 1=1 --_\\";
    expect(await listarPacientes(db, busca, 2)).toEqual([paciente]);
    const [sql, filtro, offset] = query.mock.calls[0]!;
    expect(sql.join("?")).not.toContain(busca);
    expect(sql.join("?")).not.toContain("SELECT *");
    expect(filtro).toBe("%\\%' OR 1=1 --\\_\\\\%");
    expect(offset).toBe(50);
  });
});

describe("Pacientes: HTTP e segurança com banco simulado", () => {
  test.each(["administrador", "funcionario"])("permite cadastro e consulta para %s", async perfil => {
    const { db, query } = cliente([[{ ...usuario, perfil }], [paciente], [{ ...usuario, perfil }], [paciente]]);
    const controller = criarPacientesController(() => db, false);
    const post = await controller(request("POST", dados));
    expect(post.status).toBe(201);
    expect(post.headers.get("cache-control")).toBe("no-store");
    expect((await post.json()).paciente.nome).toBe(paciente.nome);
    const get = await controller(request());
    expect(get.status).toBe(200);
    expect((await get.json()).pacientes).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(4);
  });
  test.each(["GET", "POST"])("recusa %s sem cookie sem abrir banco", async method => {
    const getDb = mock(() => { throw new Error("Não deve conectar"); });
    const response = await criarPacientesController(getDb, false)(request(method, undefined, { Cookie: "" }));
    expect(response.status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
  });
  test("sessão ausente/expirada/inativa e perfil desconhecido não acessam pacientes", async () => {
    for (const rows of [[], [{ ...usuario, perfil: "visitante" }]]) {
      const { db, query } = cliente([rows]);
      const response = await criarPacientesController(() => db, false)(request());
      expect(response.status).toBe(rows.length ? 403 : 401);
      expect(query).toHaveBeenCalledTimes(1);
    }
  });
  test("origem externa ou ausente bloqueada antes de SQL", async () => {
    const getDb = mock(() => { throw new Error("Não deve conectar"); });
    for (const Origin of ["https://externo.example", ""]) {
      expect((await criarPacientesController(getDb, false)(request("POST", dados, { Origin }))).status).toBe(403);
    }
    expect(getDb).not.toHaveBeenCalled();
  });
  test("produção preserva origem e cookie __Host-", async () => {
    const { db } = cliente([[usuario], [paciente]]);
    const controller = criarPacientesController(() => db, true, "https://clinica.example");
    expect((await controller(request("POST", dados, { Origin: "https://clinica.example" }))).status).toBe(401);
    expect((await controller(request("POST", dados, { Origin: "https://clinica.example", Cookie: `__Host-sessao=${"a".repeat(64)}` }))).status).toBe(201);
  });
  test.each(["PUT", "DELETE", "PATCH", "HEAD"])("recusa %s", async method => {
    const { db, query } = cliente();
    const response = await criarPacientesController(() => db, false)(request(method));
    expect(response.status).toBe(405);
    expect(query).not.toHaveBeenCalled();
    if (method === "HEAD") expect(await response.text()).toBe("");
  });
  test("recusa JSON inválido, tipo incorreto, excesso de corpo e validação", async () => {
    for (const [body, type, status] of [["{", "application/json", 400], ["{}", "text/plain", 415], ["x".repeat(5000), "application/json", 413], ["{}", "application/json", 400]] as const) {
      const { db, query } = cliente([[usuario]]);
      const response = await criarPacientesController(() => db, false)(new Request("http://localhost:3000/api/pacientes", {
        method: "POST", headers: { Origin: "http://localhost:3000", Cookie: `sessao=${"a".repeat(64)}`, "Content-Type": type }, body,
      }));
      expect(response.status).toBe(status);
      expect(query).toHaveBeenCalledTimes(1);
    }
  });
  test.each(["?pagina=0", "?pagina=NaN", "?pagina=1000001", `?nome=${"a".repeat(151)}`])("recusa pesquisa inválida %s", async sufixo => {
    const { db, query } = cliente([[usuario]]);
    expect((await criarPacientesController(() => db, false)(request("GET", undefined, {}, `/api/pacientes${sufixo}`))).status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
  test("pagina 50 registros com indicação de próxima página", async () => {
    const { db } = cliente([[usuario], Array.from({ length: 51 }, () => paciente)]);
    const response = await criarPacientesController(() => db, false)(request());
    const data = await response.json();
    expect(data.pacientes).toHaveLength(50);
    expect(data.temMais).toBe(true);
  });
  test("oculta falhas de SQL", async () => {
    const query = mock(async () => { throw new Error("segredo do banco"); });
    const response = await criarPacientesController(() => query as unknown as SQL, false)(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("segredo");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test("rota integrada exige sessão sem conexão Neon", async () => {
    expect((await handleRequest(request("GET", undefined, { Cookie: "" }))).status).toBe(401);
  });
});
