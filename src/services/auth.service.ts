import type { SQL } from "bun";
import { randomBytes, createHash } from "node:crypto";
import type { Perfil } from "./usuarios.service";

export type UsuarioAutenticado = { id: string; nome: string; email: string; perfil: Perfil };
export const DURACAO_SESSAO = 8 * 60 * 60 * 1000;
export const INATIVIDADE = 30 * 60 * 1000;
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
let hashSimulado: Promise<string> | undefined;

export async function login(db: SQL, email: string, senha: string) {
  const rows = await db`SELECT id, nome, email, perfil, ativo, senha_hash FROM usuarios WHERE email = ${email}`;
  const usuario = rows[0];
  // Executa a verificação também para contas ausentes, evitando resposta imediata.
  const hashAusente = await (hashSimulado ??= Bun.password.hash(randomBytes(32).toString("hex"), { algorithm: "argon2id" }));
  const valido = await Bun.password.verify(senha, usuario?.senha_hash ?? hashAusente);
  if (!usuario || !valido || !usuario.ativo) return null;
  const token = randomBytes(32).toString("hex");
  const agora = new Date();
  await db`INSERT INTO sessoes (usuario_id, token_hash, criada_em, expira_em, ultima_atividade_em)
    VALUES (${usuario.id}, ${hashToken(token)}, ${agora}, ${new Date(agora.getTime() + DURACAO_SESSAO)}, ${agora})`;
  return { token, usuario: dadosPublicos(usuario) };
}

function dadosPublicos(usuario: UsuarioAutenticado): UsuarioAutenticado {
  return { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil };
}

export async function obterUsuario(db: SQL, token: string): Promise<UsuarioAutenticado | null> {
  const agora = new Date();
  // A atualização condicional valida os prazos e registra atividade atomicamente.
  const rows = await db`UPDATE sessoes s SET ultima_atividade_em = ${agora}
    FROM usuarios u WHERE s.usuario_id = u.id AND s.token_hash = ${hashToken(token)}
    AND u.ativo = true AND s.expira_em > ${agora}
    AND s.ultima_atividade_em > ${new Date(agora.getTime() - INATIVIDADE)}
    RETURNING u.id, u.nome, u.email, u.perfil`;
  return rows[0] ? dadosPublicos(rows[0]) : null;
}

export async function logout(db: SQL, token: string): Promise<void> {
  await db`DELETE FROM sessoes WHERE token_hash = ${hashToken(token)}`;
}
