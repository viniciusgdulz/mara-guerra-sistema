import type { SQL } from "bun";

export class DadosProcedimentoInvalidos extends Error {}
export type Procedimento = { id: string; nome: string; descricao: string | null; intervalo_retorno_dias: number | null; ativo: boolean };

function publico(p: Procedimento): Procedimento {
  return { id: p.id, nome: p.nome, descricao: p.descricao, intervalo_retorno_dias: p.intervalo_retorno_dias, ativo: p.ativo };
}

function validar(dados: unknown) {
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) throw new DadosProcedimentoInvalidos("Dados do procedimento inválidos.");
  const entrada = dados as Record<string, unknown>;
  if (Object.keys(entrada).some(chave => !["nome", "descricao", "intervalo_retorno_dias"].includes(chave))) throw new DadosProcedimentoInvalidos("Envie somente nome, descrição e intervalo de retorno.");
  const { nome, descricao, intervalo_retorno_dias: intervalo } = entrada;
  if (typeof nome !== "string" || !nome.trim() || nome.trim().length > 150) throw new DadosProcedimentoInvalidos("Nome deve conter de 1 a 150 caracteres.");
  if (descricao !== undefined && descricao !== null && (typeof descricao !== "string" || descricao.trim().length > 4000)) throw new DadosProcedimentoInvalidos("Descrição deve conter até 4000 caracteres.");
  if (intervalo !== undefined && intervalo !== null && (typeof intervalo !== "number" || !Number.isInteger(intervalo) || intervalo < 1 || intervalo > 2147483647)) throw new DadosProcedimentoInvalidos("Intervalo de retorno deve ser um número inteiro de 1 a 2147483647 dias.");
  return { nome: nome.trim(), descricao: typeof descricao === "string" ? descricao.trim() || null : null, intervalo: intervalo ?? null };
}

export async function cadastrarProcedimento(db: SQL, dados: unknown): Promise<Procedimento> {
  const p = validar(dados);
  const rows = await db<Procedimento[]>`INSERT INTO procedimentos (nome, descricao, intervalo_retorno_dias)
    VALUES (${p.nome}, ${p.descricao}, ${p.intervalo})
    RETURNING id, nome, descricao, intervalo_retorno_dias, ativo`;
  if (!rows[0]) throw new Error("Cadastro não retornado.");
  return publico(rows[0]);
}

export async function editarProcedimento(db: SQL, id: string, dados: unknown): Promise<Procedimento | null> {
  const p = validar(dados);
  const rows = await db<Procedimento[]>`UPDATE procedimentos SET nome = ${p.nome}, descricao = ${p.descricao}, intervalo_retorno_dias = ${p.intervalo}
    WHERE id = ${id} RETURNING id, nome, descricao, intervalo_retorno_dias, ativo`;
  return rows[0] ? publico(rows[0]) : null;
}

export async function inativarProcedimento(db: SQL, id: string): Promise<Procedimento | null> {
  const rows = await db<Procedimento[]>`UPDATE procedimentos SET ativo = false WHERE id = ${id}
    RETURNING id, nome, descricao, intervalo_retorno_dias, ativo`;
  return rows[0] ? publico(rows[0]) : null;
}

export async function listarProcedimentos(db: SQL, nome: string, pagina: number, administrador: boolean): Promise<Procedimento[]> {
  const filtro = `%${nome.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db<Procedimento[]>`SELECT id, nome, descricao, intervalo_retorno_dias, ativo FROM procedimentos
    WHERE (${administrador} OR ativo = true) AND nome ILIKE ${filtro}
    ORDER BY nome, id LIMIT 51 OFFSET ${(pagina - 1) * 50}`;
  return rows.map(publico);
}
