import type { SQL } from "bun";
import { hasMaxLength, isNonEmptyString } from "../validation";

export type Perfil = "administrador" | "funcionario";

export type Usuario = {
  id: string;
  nome: string;
  email: string;
  perfil: Perfil;
  ativo: boolean;
  data_cadastro: Date;
};

// O chamador fornece o cliente SQL e permanece responsável por fechá-lo.
// Este serviço interno não substitui a autorização de futuras rotas administrativas.
export async function cadastrarUsuario(db: SQL, dados: unknown): Promise<Usuario> {
  if (typeof dados !== "object" || dados === null || Array.isArray(dados)) {
    throw new Error("Dados do usuário inválidos.");
  }
  const { nome, email, senha, perfil } = dados as Record<string, unknown>;
  if (typeof nome !== "string" || !isNonEmptyString(nome) || !hasMaxLength(nome.trim(), 150)) {
    throw new Error("Nome deve conter de 1 a 150 caracteres.");
  }
  if (typeof email !== "string") {
    throw new Error("E-mail inválido.");
  }
  const emailNormalizado = email.trim().toLowerCase();
  if (!hasMaxLength(emailNormalizado, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
    throw new Error("E-mail inválido.");
  }
  if (typeof senha !== "string" || !isNonEmptyString(senha) || senha.length < 15 || !hasMaxLength(senha, 128)) {
    throw new Error("Senha deve conter de 15 a 128 caracteres e não pode conter apenas espaços.");
  }
  if (perfil !== "administrador" && perfil !== "funcionario") {
    throw new Error("Perfil inválido.");
  }

  const senhaHash = await Bun.password.hash(senha, { algorithm: "argon2id" });
  let rows: Usuario[];
  try {
    rows = await db<Usuario[]>`
      INSERT INTO usuarios (nome, email, senha_hash, perfil)
      VALUES (${nome.trim()}, ${emailNormalizado}, ${senhaHash}, ${perfil})
      ON CONFLICT (email) DO NOTHING
      RETURNING id, nome, email, perfil, ativo, data_cadastro
    `;
  } catch {
    throw new Error("Não foi possível cadastrar o usuário.");
  }
  const usuario = rows[0];
  if (!usuario) {
    throw new Error("E-mail já cadastrado.");
  }
  // Lista explícita também impede que campos adicionais do banco sejam expostos.
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    perfil: usuario.perfil,
    ativo: usuario.ativo,
    data_cadastro: usuario.data_cadastro,
  };
}
