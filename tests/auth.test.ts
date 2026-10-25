import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { criarAuthController } from "../src/controllers/auth.controller";
import { criarLimitador, cookieSessao, lerToken, origemPermitida, temPerfil } from "../src/auth";
import { hashToken, login, logout, obterUsuario, DURACAO_SESSAO, INATIVIDADE } from "../src/services/auth.service";
import { criarPrimeiroAdmin } from "../scripts/create-admin";
import { handleRequest } from "../src/app";

const senha = "senha fictícia para testes";
const senhaHash = await Bun.password.hash(senha, { algorithm: "argon2id" });
const usuario = { id: "id-teste", nome: "Pessoa Teste", email: "teste@example.com", perfil: "administrador" as const };
const token = "a".repeat(64);
const conta = { ...usuario, senha_hash: senhaHash, ativo: true };

function cliente(respostas: unknown[][]) {
  const query = mock(async (_strings: TemplateStringsArray, ..._valores: unknown[]) => respostas.shift() ?? []);
  return { query, db: query as unknown as SQL };
}
function requisicao(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, {
    method, headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("Serviço de autenticação sem rede", () => {
  test("login cria token aleatório, armazena só SHA-256 e fixa oito horas", async () => {
    const { db, query } = cliente([[conta], []]);
    const result = await login(db, usuario.email, senha);
    expect(result?.token).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.usuario).toEqual(usuario);
    expect(result?.usuario).not.toHaveProperty("senha_hash");
    const [strings, id, hash, criada, expira, atividade] = query.mock.calls[1]!;
    expect(strings.join("?")).toContain("INSERT INTO sessoes");
    expect(id).toBe(usuario.id);
    expect(hash).toBe(hashToken(result!.token));
    expect(hash).not.toBe(result!.token);
    expect((expira as Date).getTime() - (criada as Date).getTime()).toBe(DURACAO_SESSAO);
    expect(atividade).toBe(criada);
  });
  test.each(["senha incorreta", "inativo", "ausente"])("recusa %s sem inserir sessão", async caso => {
    const { db, query } = cliente([caso === "ausente" ? [] : [{ ...conta, ativo: caso !== "inativo" }]]);
    expect(await login(db, usuario.email, caso === "senha incorreta" ? "outra senha" : senha)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
  test("sessão consulta usuário ativo e renova atividade dentro dos dois prazos", async () => {
    const { db, query } = cliente([[conta]]);
    expect(await obterUsuario(db, token)).toEqual(usuario);
    const [strings, agora, hash, limiteAbsoluto, limiteInatividade] = query.mock.calls[0]!;
    expect(strings.join("?")).toContain("u.ativo = true");
    expect(strings.join("?")).toContain("s.expira_em >");
    expect(strings.join("?")).toContain("s.ultima_atividade_em >");
    expect(hash).toBe(hashToken(token));
    expect(limiteAbsoluto).toBe(agora);
    expect((agora as Date).getTime() - (limiteInatividade as Date).getTime()).toBe(INATIVIDADE);
  });
  test("prazo absoluto, inatividade e usuário inativo bloqueiam a sessão", async () => {
    for (const caso of ["absoluto", "inatividade", "inativo"]) {
      const query = mock(async (_sql: TemplateStringsArray, ...params: unknown[]) => {
        const agora = params[0] as Date;
        const expira = new Date(agora.getTime() + (caso === "absoluto" ? 0 : 10000));
        const atividade = new Date(agora.getTime() - (caso === "inatividade" ? INATIVIDADE : 0));
        return caso !== "inativo" && expira > agora && atividade > (params[3] as Date) ? [usuario] : [];
      });
      expect(await obterUsuario(query as unknown as SQL, token)).toBeNull();
    }
  });
  test("logout remove pelo hash", async () => {
    const { db, query } = cliente([[]]);
    await logout(db, token);
    expect(query.mock.calls[0]![0].join("?")).toContain("DELETE FROM sessoes");
    expect(query.mock.calls[0]![1]).toBe(hashToken(token));
  });
});

describe("Rotas, cookies e permissões", () => {
  test("login normaliza e-mail e emite cookie sem retornar token no JSON", async () => {
    const { db, query } = cliente([[conta], []]);
    const controller = criarAuthController(() => db, false);
    const response = await controller(requisicao("/api/auth/login", "POST", { email: " TESTE@EXAMPLE.COM ", senha }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ usuario });
    expect(query.mock.calls[0]![1]).toBe(usuario.email);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test.each(["incorreta", "inativo", "ausente"])("mesma resposta pública para %s", async caso => {
    const { db } = cliente([caso === "ausente" ? [] : [{ ...conta, ativo: caso !== "inativo" }]]);
    const controller = criarAuthController(() => db, false);
    const response = await controller(requisicao("/api/auth/login", "POST", { email: usuario.email, senha: caso === "incorreta" ? "incorreta" : senha }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "E-mail ou senha inválidos." });
  });
  test("cookie de produção é Secure, HttpOnly, Strict e sem Domain", () => {
    const cookie = cookieSessao(token, true);
    expect(cookie).toStartWith("__Host-sessao=");
    expect(cookie).toContain("; Secure");
    expect(cookie).not.toContain("Domain=");
    expect(lerToken(requisicao("/", "GET", undefined, { Cookie: `__Host-sessao=${token}` }), true)).toBe(token);
    expect(lerToken(requisicao("/", "GET", undefined, { Cookie: "sessao=invalido" }), false)).toBeNull();
  });
  test("origem ausente, externa e configuração de produção insegura são recusadas", async () => {
    const getDb = mock(() => { throw new Error("Não acessar banco"); });
    const controller = criarAuthController(getDb, false);
    for (const request of [new Request("http://localhost:3000/api/auth/login", { method: "POST" }), requisicao("/api/auth/logout", "POST", undefined, { Origin: "https://outro.example" })]) {
      expect((await controller(request)).status).toBe(403);
    }
    expect(origemPermitida(requisicao("/"), undefined, true)).toBe(false);
    expect(origemPermitida(new Request("https://clinica.example/", { headers: { Origin: "https://clinica.example" } }), "https://clinica.example", true)).toBe(true);
    expect(getDb).not.toHaveBeenCalled();
  });
  test("limite bloqueia a sexta tentativa da mesma conta sem SQL adicional", async () => {
    const { db, query } = cliente([]);
    const controller = criarAuthController(() => db, false);
    for (let i = 0; i < 5; i++) await controller(requisicao("/api/auth/login", "POST", { email: usuario.email, senha }));
    const response = await controller(requisicao("/api/auth/login", "POST", { email: usuario.email, senha }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(query).toHaveBeenCalledTimes(5);
  });
  test("limite global bloqueia rotação de contas", () => {
    const permitir = criarLimitador();
    for (let i = 0; i < 60; i++) expect(permitir(`conta${i}@example.com`)).toBe(true);
    expect(permitir("outra@example.com")).toBe(false);
  });
  test("me exige sessão e nunca retorna hash", async () => {
    const { db } = cliente([[conta], []]);
    const controller = criarAuthController(() => db, false);
    expect((await controller(requisicao("/api/auth/me"))).status).toBe(401);
    const response = await controller(requisicao("/api/auth/me", "GET", undefined, { Cookie: `sessao=${token}` }));
    expect(await response.json()).toEqual({ usuario });
    expect((await controller(requisicao("/api/auth/me", "GET", undefined, { Cookie: `sessao=${token}` }))).status).toBe(401);
  });
  test("logout exclui sessão e limpa cookie; é idempotente", async () => {
    const { db, query } = cliente([[]]);
    const controller = criarAuthController(() => db, false);
    const response = await controller(requisicao("/api/auth/logout", "POST", undefined, { Cookie: `sessao=${token}` }));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(query).toHaveBeenCalledTimes(1);
    expect((await controller(requisicao("/api/auth/logout", "POST"))).status).toBe(204);
    expect(query).toHaveBeenCalledTimes(1);
  });
  test("fluxo login, me, logout e sessão revogada com armazenamento simulado", async () => {
    const sessoes = new Set<string>();
    const query = mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("SELECT id, nome")) return [conta];
      if (sql.includes("INSERT INTO sessoes")) { sessoes.add(values[1] as string); return []; }
      if (sql.includes("DELETE FROM sessoes")) { sessoes.delete(values[0] as string); return []; }
      return sessoes.has(values[1] as string) ? [usuario] : [];
    });
    const controller = criarAuthController(() => query as unknown as SQL, false);
    const entrada = await controller(requisicao("/api/auth/login", "POST", { email: usuario.email, senha }));
    const cookie = entrada.headers.get("set-cookie")!.split(";")[0]!;
    expect((await controller(requisicao("/api/auth/me", "GET", undefined, { Cookie: cookie }))).status).toBe(200);
    expect((await controller(requisicao("/api/auth/logout", "POST", undefined, { Cookie: cookie }))).status).toBe(204);
    expect((await controller(requisicao("/api/auth/me", "GET", undefined, { Cookie: cookie }))).status).toBe(401);
    expect(sessoes.size).toBe(0);
  });
  test("perfis e namespace administrativo são protegidos no servidor", async () => {
    const funcionario = { ...usuario, perfil: "funcionario" as const };
    expect(temPerfil(usuario, ["administrador"])).toBe(true);
    expect(temPerfil(funcionario, ["administrador"])).toBe(false);
    expect(temPerfil(funcionario, ["administrador", "funcionario"])).toBe(true);
    const { db } = cliente([[funcionario], [usuario]]);
    const controller = criarAuthController(() => db, false);
    expect((await controller(requisicao("/api/admin/usuarios"))).status).toBe(401);
    const request = () => requisicao("/api/admin/usuarios", "GET", undefined, { Cookie: `sessao=${token}` });
    expect((await controller(request())).status).toBe(403);
    expect((await controller(request())).status).toBe(404); // Funcionalidade ainda não implementada.
  });
  test("integração pública preserva health e protege admin sem abrir banco", async () => {
    expect((await handleRequest(requisicao("/api/auth/me"))).status).toBe(401);
    expect((await handleRequest(requisicao("/api/admin/usuarios"))).status).toBe(401);
    expect((await handleRequest(requisicao("/api/pacientes"))).status).toBe(404);
    expect((await handleRequest(requisicao("/api/health"))).status).toBe(200);
  });
  test("recusa método, JSON inválido e corpo grande antes de abrir banco", async () => {
    const getDb = mock(() => { throw new Error("Não abrir banco"); });
    const controller = criarAuthController(getDb, false);
    expect((await controller(requisicao("/api/auth/login"))).status).toBe(405);
    expect((await controller(requisicao("/api/auth/me", "POST"))).status).toBe(405);
    expect((await controller(requisicao("/api/auth/login", "POST", {}))).status).toBe(400);
    expect((await controller(requisicao("/api/auth/login", "POST", {}, { "Content-Type": "text/plain" }))).status).toBe(415);
    expect((await controller(new Request("http://localhost:3000/api/auth/login", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: "{" }))).status).toBe(400);
    expect((await controller(requisicao("/api/auth/login", "POST", { senha: "a".repeat(5000) }))).status).toBe(413);
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("Primeiro administrador com transação simulada", () => {
  test("recusa quando já existe administrador", async () => {
    const { db: tx, query } = cliente([[], [{ id: "existente" }]]);
    const db = { begin: async (fn: (tx: SQL) => unknown) => fn(tx) } as unknown as SQL;
    await expect(criarPrimeiroAdmin(db, "Teste", "teste@example.com", senha)).rejects.toThrow("Já existe um administrador");
    expect(query).toHaveBeenCalledTimes(2);
  });
  test("cria somente administrador, mantendo operação na mesma transação", async () => {
    const { db: tx, query } = cliente([[], [], [{ ...usuario, ativo: true, data_cadastro: new Date() }]]);
    const db = { begin: async (fn: (tx: SQL) => unknown) => fn(tx) } as unknown as SQL;
    expect((await criarPrimeiroAdmin(db, "Teste", "teste@example.com", senha)).perfil).toBe("administrador");
    expect(query.mock.calls[0]![0].join("")).toContain("LOCK TABLE usuarios");
    expect(query.mock.calls[2]![4]).toBe("administrador");
  });
});
