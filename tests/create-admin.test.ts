import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { EventEmitter } from "node:events";
import { executarCadastro, lerSenha } from "../scripts/create-admin";

const senha = "senha fictícia para teste";
const dados = { nome: "Teste", email: "teste@example.com", senha, confirmacao: senha };
const segredoSimulado = "detalhe confidencial simulado";

function cliente(opcoes: { falha?: string; existente?: boolean; duplicado?: boolean } = {}) {
  const query = mock(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("LOCK") && opcoes.falha === "lock") throw new Error(segredoSimulado);
    if (sql.includes("SELECT")) return opcoes.existente ? [{ id: "existente" }] : [];
    if (sql.includes("INSERT")) {
      if (opcoes.falha === "insert") throw new Error(segredoSimulado);
      if (opcoes.duplicado) return [];
      return [{ id: "teste", nome: dados.nome, email: dados.email, perfil: "administrador", ativo: true, data_cadastro: new Date() }];
    }
    return [];
  });
  const rollback = mock(() => {});
  const begin = mock(async (fn: (tx: SQL) => unknown) => {
    if (opcoes.falha === "begin") throw new Error(segredoSimulado);
    try {
      const resultado = await fn(query as unknown as SQL);
      if (opcoes.falha === "commit") throw new Error(segredoSimulado);
      return resultado;
    } catch (error) { rollback(); throw error; }
  });
  const connect = mock(async () => {
    if (opcoes.falha === "connect") throw new Error(segredoSimulado);
  });
  const close = mock(async () => {
    if (opcoes.falha === "close") throw new Error(segredoSimulado);
  });
  return { db: { begin, connect, close } as unknown as SQL, begin, query, connect, close, rollback };
}

async function executar(opcoes: Parameters<typeof cliente>[0] = {}, entrada = dados) {
  const banco = cliente(opcoes);
  const mensagens: string[] = [];
  const erros: string[] = [];
  const sucesso = await executarCadastro(async () => entrada, () => banco.db,
    mensagem => mensagens.push(mensagem), mensagem => erros.push(mensagem));
  expect([...mensagens, ...erros].join(" ")).not.toContain(segredoSimulado);
  expect([...mensagens, ...erros].join(" ")).not.toContain(senha);
  return { ...banco, sucesso, mensagens, erros };
}

describe("Diagnóstico seguro do primeiro administrador", () => {
  test.each([
    { campo: "nome", valor: " ", esperado: "Nome deve conter de 1 a 150 caracteres." },
    { campo: "nome", valor: "a".repeat(151), esperado: "Nome deve conter de 1 a 150 caracteres." },
    { campo: "email", valor: "sem-arroba", esperado: "E-mail inválido." },
    { campo: "senha", valor: "curta", esperado: "Senha deve conter de 15 a 128 caracteres e não pode conter apenas espaços." },
    { campo: "senha", valor: " ".repeat(15), esperado: "Senha deve conter de 15 a 128 caracteres e não pode conter apenas espaços." },
    { campo: "senha", valor: "a".repeat(129), esperado: "Senha deve conter de 15 a 128 caracteres e não pode conter apenas espaços." },
  ])("explica validação de $campo", async ({ campo, valor, esperado }) => {
    const entrada = { ...dados, [campo]: valor, confirmacao: campo === "senha" ? valor : dados.confirmacao };
    const result = await executar({}, entrada);
    expect(result.sucesso).toBe(false);
    expect(result.erros).toEqual([esperado]);
    expect(result.query.mock.calls.some(([strings]) => strings.join("").includes("INSERT"))).toBe(false);
    expect(result.rollback).toHaveBeenCalledTimes(1);
    expect(result.close).toHaveBeenCalledTimes(1);
  });
  test("senhas diferentes não abrem conexão", async () => {
    const result = await executar({}, { ...dados, confirmacao: "diferente" });
    expect(result.sucesso).toBe(false);
    expect(result.erros).toEqual(["A senha e a confirmação são diferentes. Administrador não criado."]);
    expect(result.connect).not.toHaveBeenCalled();
  });
  test("erro de leitura não expõe detalhes nem abre conexão", async () => {
    const conectar = mock(() => { throw new Error("Não conectar"); });
    const erros: string[] = [];
    const sucesso = await executarCadastro(async () => { throw new Error(segredoSimulado); }, conectar,
      () => {}, mensagem => erros.push(mensagem));
    expect(sucesso).toBe(false);
    expect(erros).toEqual(["Falha na leitura interativa do terminal."]);
    expect(conectar).not.toHaveBeenCalled();
  });
  test("configuração inválida recebe erro seguro de conexão", async () => {
    const erros: string[] = [];
    expect(await executarCadastro(async () => dados, () => { throw new Error(segredoSimulado); },
      () => {}, mensagem => erros.push(mensagem))).toBe(false);
    expect(erros).toEqual(["Falha na conexão. Confira DATABASE_URL no .env e o acesso ao PostgreSQL."]);
  });
  test.each(["connect", "begin", "lock", "insert", "commit"])("identifica etapa %s sem erro bruto", async falha => {
    const result = await executar({ falha });
    expect(result.sucesso).toBe(false);
    expect(result.erros[0]).toContain(falha === "connect" ? "Falha na conexão" : falha === "insert" ? "Falha no cadastro" : "Falha na transação");
    if (falha === "connect") expect(result.begin).not.toHaveBeenCalled();
    expect(result.close).toHaveBeenCalledTimes(1);
  });
  test("preserva proteção contra segundo administrador", async () => {
    const result = await executar({ existente: true });
    expect(result.erros).toEqual(["Já existe um administrador. Operação cancelada."]);
    expect(result.query).toHaveBeenCalledTimes(2);
    expect(result.rollback).toHaveBeenCalledTimes(1);
  });
  test("explica e-mail duplicado", async () => {
    const result = await executar({ duplicado: true });
    expect(result.erros).toEqual(["E-mail já cadastrado."]);
    expect(result.rollback).toHaveBeenCalledTimes(1);
  });
  test("confirma sucesso e fecha conexão", async () => {
    const result = await executar();
    expect(result.sucesso).toBe(true);
    expect(result.mensagens).toEqual(["Primeiro administrador criado com sucesso."]);
    expect(result.erros).toEqual([]);
    expect(result.close).toHaveBeenCalledTimes(1);
  });
  test("falha de fechamento após sucesso não sugere repetir o cadastro", async () => {
    const result = await executar({ falha: "close" });
    expect(result.sucesso).toBe(true);
    expect(result.erros).toEqual(["Administrador criado, mas houve falha ao encerrar a conexão. Não repita o cadastro."]);
  });
});

function terminalSimulado() {
  const input = Object.assign(new EventEmitter(), {
    isRaw: false,
    setRawMode: mock((_valor: boolean) => {}),
    setEncoding: mock((_valor: string) => {}),
    resume: mock(() => {}),
    pause: mock(() => {}),
  });
  const saida: string[] = [];
  const output = { write: (texto: string) => { saida.push(texto); return true; } };
  return { input, output, saida, ler: () => lerSenha("Senha (oculta): ", input as unknown as typeof process.stdin, output as unknown as typeof process.stdout) };
}

describe("Leitura oculta com terminal simulado", () => {
  test("lê senha sem eco e restaura terminal", async () => {
    const t = terminalSimulado();
    const result = t.ler();
    t.input.emit("data", senha + "\r");
    expect(await result).toBe(senha);
    expect(t.saida).toEqual(["Senha (oculta): ", "\n"]);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.input.listenerCount("data")).toBe(0);
  });
  test.each(["error", "end"])("trata evento %s sem expor detalhes", async evento => {
    const t = terminalSimulado();
    const result = t.ler();
    t.input.emit(evento, new Error(segredoSimulado));
    await expect(result).rejects.toThrow("Falha na leitura interativa do terminal.");
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.saida.join("")).not.toContain(segredoSimulado);
  });
  test("trata falha ao ativar modo oculto", async () => {
    const t = terminalSimulado();
    t.input.setRawMode.mockImplementation(() => { throw new Error(segredoSimulado); });
    await expect(t.ler()).rejects.toThrow("Falha na leitura interativa do terminal.");
  });
  test("cancelamento limpa listeners e restaura terminal", async () => {
    const t = terminalSimulado();
    const result = t.ler();
    t.input.emit("data", "\u0003");
    await expect(result).rejects.toThrow("Operação cancelada no terminal.");
    expect(t.input.listenerCount("data")).toBe(0);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
  });
});
