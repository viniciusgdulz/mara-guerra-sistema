import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { cadastrarUsuario } from "../src/services/usuarios.service";

const dadosValidos = {
  nome: " Pessoa de Teste ",
  email: " TESTE@EXAMPLE.COM ",
  senha: " frase de teste segura ",
  perfil: "funcionario",
};

const usuario = {
  id: "00000000-0000-4000-8000-000000000001",
  nome: "Pessoa de Teste",
  email: "teste@example.com",
  perfil: "funcionario",
  ativo: true,
  data_cadastro: new Date("2026-01-01T00:00:00Z"),
};

describe("Cadastro de usuários sem conexão com o banco", () => {
  test.each([
    { caso: "dados nulos", dados: null },
    { caso: "dados incompletos", dados: {} },
    { caso: "nome vazio", dados: { ...dadosValidos, nome: "" } },
    { caso: "nome com espaços", dados: { ...dadosValidos, nome: " \t\n " } },
    { caso: "nome longo", dados: { ...dadosValidos, nome: "a".repeat(151) } },
    { caso: "nome numérico", dados: { ...dadosValidos, nome: 123 } },
    { caso: "e-mail nulo", dados: { ...dadosValidos, email: null } },
    { caso: "e-mail vazio", dados: { ...dadosValidos, email: "" } },
    { caso: "e-mail sem domínio", dados: { ...dadosValidos, email: "teste@" } },
    { caso: "e-mail com espaços internos", dados: { ...dadosValidos, email: "te ste@example.com" } },
    { caso: "e-mail longo", dados: { ...dadosValidos, email: "a".repeat(243) + "@example.com" } },
    { caso: "senha nula", dados: { ...dadosValidos, senha: null } },
    { caso: "senha curta", dados: { ...dadosValidos, senha: "a".repeat(14) } },
    { caso: "senha longa", dados: { ...dadosValidos, senha: "a".repeat(129) } },
    { caso: "senha só com espaços", dados: { ...dadosValidos, senha: " ".repeat(15) } },
    { caso: "perfil desconhecido", dados: { ...dadosValidos, perfil: "visitante" } },
    { caso: "perfil nulo", dados: { ...dadosValidos, perfil: null } },
  ])("rejeita $caso antes de consultar SQL", async ({ dados }) => {
    const query = mock(() => { throw new Error("SQL não deveria ser chamado"); });
    await expect(cadastrarUsuario(query as unknown as SQL, dados)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  test.each(["administrador", "funcionario"])("cadastra %s com hash Argon2id e parâmetros", async (perfil) => {
    const query = mock(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [
      { ...usuario, perfil, senha_hash: "campo que não deve retornar" },
    ]);
    const result = await cadastrarUsuario(query as unknown as SQL, { ...dadosValidos, perfil });
    expect(result).toEqual({ ...usuario, perfil });
    expect(result).not.toHaveProperty("senha_hash");
    expect(result).not.toHaveProperty("senha");
    expect(query).toHaveBeenCalledTimes(1);
    const [strings, ...values] = query.mock.calls[0]!;
    expect(strings.join("?")).toContain("ON CONFLICT (email) DO NOTHING");
    expect(strings.join("?")).not.toContain(dadosValidos.senha);
    expect(values[0]).toBe("Pessoa de Teste");
    expect(values[1]).toBe("teste@example.com");
    expect(values[3]).toBe(perfil);
    const hash = values[2] as string;
    expect(hash).toStartWith("$argon2id$");
    expect(await Bun.password.verify(dadosValidos.senha, hash)).toBe(true);
    expect(await Bun.password.verify("senha incorreta de teste", hash)).toBe(false);
    expect(await Bun.password.verify(dadosValidos.senha.trim(), hash)).toBe(false);
  });

  test("aceita os limites e gera hashes diferentes para a mesma senha", async () => {
    const query = mock(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [usuario]);
    const db = query as unknown as SQL;
    const dados = {
      ...dadosValidos,
      nome: "a".repeat(150),
      email: "a".repeat(64) + "@" + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(61),
      senha: "a".repeat(15),
    };
    await cadastrarUsuario(db, dados);
    await cadastrarUsuario(db, dados);
    expect(query.mock.calls[0]![3]).not.toBe(query.mock.calls[1]![3]);
    await cadastrarUsuario(db, { ...dados, senha: "a".repeat(128) });
    expect(query).toHaveBeenCalledTimes(3);
  });

  test("trata conflito de e-mail sem detalhes internos", async () => {
    const query = mock(async () => []);
    await expect(cadastrarUsuario(query as unknown as SQL, dadosValidos))
      .rejects.toThrow("E-mail já cadastrado.");
  });

  test("oculta detalhes de uma falha no banco", async () => {
    const query = mock(async () => { throw new Error("Detalhes internos do banco"); });
    await expect(cadastrarUsuario(query as unknown as SQL, dadosValidos))
      .rejects.toThrow("Não foi possível cadastrar o usuário.");
  });
});
