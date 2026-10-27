import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { cadastrarProcedimento, editarProcedimento, inativarProcedimento, listarProcedimentos } from "../src/services/procedimentos.service";
import { criarProcedimentosController } from "../src/controllers/procedimentos.controller";
import { handleRequest } from "../src/app";

const id = "00000000-0000-4000-8000-000000000001";
const procedimento = { id, nome: "Procedimento de teste", descricao: null, intervalo_retorno_dias: null, ativo: true };
const usuario = { id: "u1", nome: "Equipe Teste", email: "equipe@example.com", perfil: "administrador" };
function cliente(respostas: unknown[][] = []) {
  const query = mock(async (_sql: TemplateStringsArray, ..._values: unknown[]) => respostas.shift() ?? []);
  return { query, db: query as unknown as SQL };
}
function request(method = "GET", path = "/api/procedimentos", body?: unknown, extra: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, { method, headers: { Origin: "http://localhost:3000", Cookie: `sessao=${"a".repeat(64)}`, "Content-Type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("Procedimentos: serviço sem banco real", () => {
  test.each([null, [], {}, { nome: " " }, { nome: 123 }, { nome: "a".repeat(151) },
    { nome: "Teste", descricao: 123 }, { nome: "Teste", descricao: "a".repeat(4001) },
    ...[0, -1, 1.5, "30", "", true, 2147483648, NaN, Infinity].map(intervalo_retorno_dias => ({ nome: "Teste", intervalo_retorno_dias })),
    { nome: "Teste", ativo: true }, { nome: "Teste", id },
  ])("recusa cadastro e edição inválidos antes de SQL: %j", async dados => {
    const { db, query } = cliente();
    await expect(cadastrarProcedimento(db, dados)).rejects.toThrow();
    await expect(editarProcedimento(db, id, dados)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  test("cadastro normaliza e respeita limites, sem expor campos adicionais", async () => {
    const { db, query } = cliente([[{ ...procedimento, segredo: "interno" }], [procedimento], [procedimento]]);
    expect(await cadastrarProcedimento(db, { nome: " Teste ", descricao: " " })).toEqual(procedimento);
    expect(query.mock.calls[0]!.slice(1)).toEqual(["Teste", null, null]);
    await cadastrarProcedimento(db, { nome: "a".repeat(150), descricao: "a".repeat(4000), intervalo_retorno_dias: 2147483647 });
    expect(query.mock.calls[1]![3]).toBe(2147483647);
    await cadastrarProcedimento(db, { nome: "Teste", descricao: " Descrição ", intervalo_retorno_dias: 1 });
    expect(query.mock.calls[2]!.slice(1)).toEqual(["Teste", "Descrição", 1]);
  });
  test("edição parametrizada limpa opcionais sem reativar", async () => {
    const { db, query } = cliente([[{ ...procedimento, ativo: false }]]);
    const nome = "' ; DROP TABLE procedimentos; --";
    expect((await editarProcedimento(db, id, { nome }))?.ativo).toBe(false);
    const [sql, ...values] = query.mock.calls[0]!;
    expect(sql.join("?")).not.toContain(nome);
    expect(sql.join("?")).not.toContain("ativo =");
    expect(values).toEqual([nome, null, null, id]);
  });
  test("inativação atualiza somente ativo e não exclui", async () => {
    const { db, query } = cliente([[{ ...procedimento, ativo: false }], []]);
    expect((await inativarProcedimento(db, id))?.ativo).toBe(false);
    const [sql, ...values] = query.mock.calls[0]!;
    expect(sql.join("?")).toContain("UPDATE procedimentos SET ativo = false WHERE id = ?");
    expect(sql.join("?")).not.toContain("DELETE");
    expect(values).toEqual([id]);
    expect(await inativarProcedimento(db, id)).toBeNull();
  });
  test("edição de registro ausente não cria registro", async () => {
    const { db } = cliente();
    expect(await editarProcedimento(db, id, { nome: "Teste" })).toBeNull();
  });
  test.each([true, false])("busca parametrizada com filtro de ativos: administrador=%s", async admin => {
    const { db, query } = cliente([[{ ...procedimento, segredo: "interno" }]]);
    expect(await listarProcedimentos(db, "%_\\'", 2, admin)).toEqual([procedimento]);
    const [sql, ...values] = query.mock.calls[0]!;
    expect(sql.join("?")).toContain("WHERE (? OR ativo = true) AND nome ILIKE ?");
    expect(values).toEqual([admin, "%\\%\\_\\\\'%", 50]);
    expect(sql.join("?")).toContain("ORDER BY nome, id LIMIT 51");
  });
});

describe("Procedimentos: permissões e HTTP simulados", () => {
  test.each(["administrador", "funcionario"])("consulta %s deriva filtro do perfil da sessão", async perfil => {
    const { db, query } = cliente([[{ ...usuario, perfil }], [procedimento]]);
    const response = await criarProcedimentosController(() => db, false)(request("GET", "/api/procedimentos?ativo=false&administrador=true"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).procedimentos).toEqual([procedimento]);
    expect(query.mock.calls[1]![1]).toBe(perfil === "administrador");
  });
  const operacoes = [
    { method: "POST", path: "/api/procedimentos", body: { nome: "Teste" }, status: 201 },
    { method: "PUT", path: `/api/procedimentos/${id}`, body: { nome: "Editado" }, status: 200 },
    { method: "POST", path: `/api/procedimentos/${id}/inativar`, body: undefined, status: 200 },
  ];
  test.each(operacoes)("administrador executa $method $path", async op => {
    const { db } = cliente([[usuario], [procedimento]]);
    const response = await criarProcedimentosController(() => db, false)(request(op.method, op.path, op.body));
    expect(response.status).toBe(op.status);
    expect((await response.json()).procedimento).toEqual(procedimento);
  });
  test.each(operacoes)("funcionário não executa $method $path", async op => {
    const { db, query } = cliente([[{ ...usuario, perfil: "funcionario" }]]);
    expect((await criarProcedimentosController(() => db, false)(request(op.method, op.path, op.body))).status).toBe(403);
    expect(query).toHaveBeenCalledTimes(1);
  });
  test.each(operacoes)("sem sessão não executa $method $path", async op => {
    const getDb = mock(() => { throw new Error("Não conectar"); });
    expect((await criarProcedimentosController(getDb, false)(request(op.method, op.path, op.body, { Cookie: "" }))).status).toBe(401);
    expect(getDb).not.toHaveBeenCalled();
  });
  test.each(operacoes)("origem externa/ausente bloqueia $method $path", async op => {
    const getDb = mock(() => { throw new Error("Não conectar"); });
    for (const Origin of ["", "https://externo.example"]) {
      expect((await criarProcedimentosController(getDb, false)(request(op.method, op.path, op.body, { Origin }))).status).toBe(403);
    }
    expect(getDb).not.toHaveBeenCalled();
  });
  test("sessão inválida e perfil desconhecido não acessam catálogo", async () => {
    for (const rows of [[], [{ ...usuario, perfil: "visitante" }]]) {
      const { db, query } = cliente([rows]);
      expect((await criarProcedimentosController(() => db, false)(request())).status).toBe(rows.length ? 403 : 401);
      expect(query).toHaveBeenCalledTimes(1);
    }
    expect((await handleRequest(request("GET", "/api/procedimentos", undefined, { Cookie: "" }))).status).toBe(401);
  });
  test("preserva origem HTTPS e cookie de produção", async () => {
    const { db } = cliente([[usuario], [procedimento]]);
    const controller = criarProcedimentosController(() => db, true, "https://clinica.example");
    expect((await controller(request("POST", "/api/procedimentos", { nome: "Teste" }, { Origin: "https://clinica.example" }))).status).toBe(401);
    expect((await controller(request("POST", "/api/procedimentos", { nome: "Teste" }, { Origin: "https://clinica.example", Cookie: `__Host-sessao=${"a".repeat(64)}` }))).status).toBe(201);
  });
  test.each(["DELETE", "PATCH", "HEAD"])("recusa %s e exclusão permanente", async method => {
    const { db, query } = cliente();
    const response = await criarProcedimentosController(() => db, false)(request(method, `/api/procedimentos/${id}`));
    expect(response.status).toBe(405);
    expect(query).not.toHaveBeenCalled();
    if (method === "HEAD") expect(await response.text()).toBe("");
  });
  test.each([`/api/procedimentos/${id}`, `/api/procedimentos/${id}/inativar`])("404 para registro ausente em %s", async path => {
    const { db } = cliente([[usuario], []]);
    expect((await criarProcedimentosController(() => db, false)(request(path.endsWith("inativar") ? "POST" : "PUT", path, { nome: "Teste" }))).status).toBe(404);
  });
  test.each(["?pagina=0", "?pagina=1.5", "?pagina=NaN", "?pagina=1000001", `?nome=${"a".repeat(151)}`])("recusa consulta inválida %s", async suffix => {
    const { db, query } = cliente([[usuario]]);
    expect((await criarProcedimentosController(() => db, false)(request("GET", `/api/procedimentos${suffix}`))).status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
  test.each(["PUT", "POST"])("rejeita id inválido em %s", async method => {
    const { db, query } = cliente([[usuario]]);
    expect((await criarProcedimentosController(() => db, false)(request(method, `/api/procedimentos/invalido${method === "POST" ? "/inativar" : ""}`, { nome: "Teste" }))).status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
  test("valida tipo, JSON, corpo e dados sem gravar", async () => {
    for (const [body, type, status] of [["{", "application/json", 400], ["{}", "text/plain", 415], ["x".repeat(32769), "application/json", 413], ["{}", "application/json", 400]] as const) {
      const { db, query } = cliente([[usuario]]);
      const req = new Request("http://localhost:3000/api/procedimentos", { method: "POST", headers: { Cookie: `sessao=${"a".repeat(64)}`, Origin: "http://localhost:3000", "Content-Type": type }, body });
      expect((await criarProcedimentosController(() => db, false)(req)).status).toBe(status);
      expect(query).toHaveBeenCalledTimes(1);
    }
  });
  test.each([0, 51])("lista %s resultados com paginação", async count => {
    const { db } = cliente([[usuario], Array.from({ length: count }, () => procedimento)]);
    const response = await criarProcedimentosController(() => db, false)(request());
    const data = await response.json();
    expect(data.procedimentos).toHaveLength(Math.min(count, 50));
    expect(data.temMais).toBe(count > 50);
  });
  test("falha de banco após autenticação não expõe detalhes", async () => {
    let chamadas = 0;
    const query = mock(async () => { if (++chamadas === 1) return [usuario]; throw new Error("credencial confidencial"); });
    const response = await criarProcedimentosController(() => query as unknown as SQL, false)(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("confidencial");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
