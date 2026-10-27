import type { SQL } from "bun";
import { validarData, validarId } from "./atendimentos.service";

export class ErroAgenda extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function objetoAgenda(dados: unknown, campos: string[]): Record<string, unknown> {
  if (!dados || typeof dados !== "object" || Array.isArray(dados) || Object.keys(dados).some(c => !campos.includes(c))) throw new ErroAgenda("Dados do agendamento inválidos.");
  return dados as Record<string, unknown>;
}
const formato = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
export function horarioAgenda(data: unknown, hora: unknown): Date {
  validarData(data);
  if (typeof hora !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new ErroAgenda("Informe um horário válido (HH:MM).");
  const local = `${data}T${hora}:00`;
  const desejado = Date.parse(`${local}Z`);
  let instante = desejado;
  for (let i = 0; i < 3; i++) {
    const partes = Object.fromEntries(formato.formatToParts(new Date(instante)).map(p => [p.type, p.value]));
    const exibido = `${partes.year!.padStart(4, "0")}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}`;
    const diferenca = desejado - Date.parse(`${exibido}Z`);
    if (diferenca === 0) return new Date(instante);
    instante += diferenca;
  }
  throw new ErroAgenda("Horário inexistente no fuso de São Paulo. Escolha outro horário.");
}
export type Agendamento = { id: string; paciente_id: string; procedimento_id: string | null; data_hora: Date; status: string };
function publico(a: Agendamento): Agendamento {
  return { id: a.id, paciente_id: a.paciente_id, procedimento_id: a.procedimento_id, data_hora: a.data_hora, status: a.status };
}
async function inserir(tx: SQL, paciente: string, procedimento: string, horario: Date) {
  await validarDisponibilidade(tx, paciente, procedimento, horario, null);
  const rows = await tx`INSERT INTO agendamentos (paciente_id, procedimento_id, data_hora, status)
    VALUES (${paciente}, ${procedimento}, ${horario}, 'pendente') RETURNING id, paciente_id, procedimento_id, data_hora, status`;
  if (!rows[0]) throw new Error("Agendamento não retornado.");
  return publico(rows[0]);
}
async function validarDisponibilidade(tx: SQL, paciente: string, procedimento: string, horario: Date, excluir: string | null) {
  // Serializa cadastro e reagendamento do mesmo paciente sem mudar o schema.
  const pacientes = await tx`SELECT id FROM pacientes WHERE id = ${paciente} FOR UPDATE`;
  if (!pacientes[0]) throw new ErroAgenda("Paciente não encontrado.", 404);
  const procedimentos = await tx`SELECT id FROM procedimentos WHERE id = ${procedimento} AND ativo = true FOR SHARE`;
  if (!procedimentos[0]) throw new ErroAgenda("Selecione um procedimento ativo existente.");
  const duplicados = await tx`SELECT id FROM agendamentos WHERE paciente_id = ${paciente} AND data_hora = ${horario}
    AND status <> 'cancelado' AND (${excluir}::uuid IS NULL OR id <> ${excluir}::uuid) LIMIT 1`;
  if (duplicados[0]) throw new ErroAgenda("Já existe um agendamento para este paciente nesta data e horário.", 409);
}
export async function criarAgendamento(db: SQL, dados: unknown) {
  const d = objetoAgenda(dados, ["paciente_id", "procedimento_id", "data", "hora"]);
  validarId(d.paciente_id); validarId(d.procedimento_id);
  const horario = horarioAgenda(d.data, d.hora);
  return db.begin(tx => inserir(tx as unknown as SQL, d.paciente_id as string, d.procedimento_id as string, horario));
}
export async function reagendar(db: SQL, id: string, dados: unknown) {
  validarId(id);
  const d = objetoAgenda(dados, ["procedimento_id", "data", "hora"]);
  validarId(d.procedimento_id);
  const horario = horarioAgenda(d.data, d.hora);
  return db.begin(async tx => {
    const rows = await tx`SELECT id, paciente_id, status FROM agendamentos WHERE id = ${id} FOR UPDATE`;
    const a = rows[0];
    if (!a) throw new ErroAgenda("Agendamento não encontrado.", 404);
    if (!["pendente", "confirmado"].includes(a.status)) throw new ErroAgenda("Somente agendamentos em aberto podem ser reagendados.", 409);
    await validarDisponibilidade(tx as unknown as SQL, a.paciente_id, d.procedimento_id as string, horario, id);
    const atualizados = await tx`UPDATE agendamentos SET procedimento_id = ${d.procedimento_id}, data_hora = ${horario}
      WHERE id = ${id} RETURNING id, paciente_id, procedimento_id, data_hora, status`;
    if (!atualizados[0]) throw new Error("Agendamento não retornado.");
    return publico(atualizados[0]);
  });
}
export async function mudarStatus(db: SQL, id: string, status: unknown) {
  validarId(id);
  if (status !== "cancelado" && status !== "realizado") throw new ErroAgenda("Status inválido.");
  return db.begin(async tx => {
    const rows = await tx`SELECT id, paciente_id, procedimento_id, data_hora, status FROM agendamentos WHERE id = ${id} FOR UPDATE`;
    const a = rows[0];
    if (!a) throw new ErroAgenda("Agendamento não encontrado.", 404);
    if (a.status === status) return publico(a);
    if (!["pendente", "confirmado"].includes(a.status)) throw new ErroAgenda("Este agendamento já foi encerrado.", 409);
    const atualizados = await tx`UPDATE agendamentos SET status = ${status} WHERE id = ${id}
      RETURNING id, paciente_id, procedimento_id, data_hora, status`;
    if (!atualizados[0]) throw new Error("Agendamento não retornado.");
    return publico(atualizados[0]);
  });
}
export async function listarAgenda(db: SQL, data: string, nome: string, pagina: number) {
  validarData(data);
  const filtro = `%${nome.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db`SELECT g.id, g.paciente_id, g.procedimento_id, g.data_hora, g.status,
    p.nome AS paciente_nome, p.telefone AS paciente_telefone, pr.nome AS procedimento_nome
    FROM agendamentos g JOIN pacientes p ON p.id = g.paciente_id LEFT JOIN procedimentos pr ON pr.id = g.procedimento_id
    WHERE (g.data_hora AT TIME ZONE 'America/Sao_Paulo')::date = ${data}::date AND p.nome ILIKE ${filtro}
    ORDER BY g.data_hora, g.id LIMIT 51 OFFSET ${(pagina - 1) * 50}`;
  return rows.map((a: Agendamento & { paciente_nome: string; paciente_telefone: string; procedimento_nome: string | null }) => ({ ...publico(a), paciente_nome: a.paciente_nome, paciente_telefone: a.paciente_telefone, procedimento_nome: a.procedimento_nome }));
}
export async function listarRetornos(db: SQL, inicio: string, fim: string, pagina: number) {
  validarData(inicio); validarData(fim);
  if (fim < inicio || Date.parse(fim) - Date.parse(inicio) > 366 * 86400000) throw new ErroAgenda("Selecione um período de até 366 dias, com fim igual ou posterior ao início.");
  const rows = await db`SELECT a.id AS sugestao_id, a.paciente_id, a.procedimento_id, a.data_retorno_sugerida::text AS data_retorno_sugerida,
    p.nome AS paciente_nome, pr.nome AS procedimento_nome, pr.ativo AS procedimento_ativo
    FROM atendimentos a JOIN pacientes p ON p.id = a.paciente_id JOIN procedimentos pr ON pr.id = a.procedimento_id
    WHERE a.data_retorno_sugerida BETWEEN ${inicio}::date AND ${fim}::date
    ORDER BY a.data_retorno_sugerida, a.id LIMIT 51 OFFSET ${(pagina - 1) * 50}`;
  return rows.map((r: { sugestao_id: string; paciente_id: string; procedimento_id: string; data_retorno_sugerida: string; paciente_nome: string; procedimento_nome: string; procedimento_ativo: boolean }) => ({ sugestao_id: r.sugestao_id, paciente_id: r.paciente_id, procedimento_id: r.procedimento_id, data_retorno_sugerida: r.data_retorno_sugerida, paciente_nome: r.paciente_nome, procedimento_nome: r.procedimento_nome, procedimento_ativo: r.procedimento_ativo }));
}
export async function agendarRetorno(db: SQL, id: string, dados: unknown) {
  validarId(id);
  const d = objetoAgenda(dados, ["data", "hora"]);
  const horario = horarioAgenda(d.data, d.hora);
  return db.begin(async tx => {
    const rows = await tx`SELECT paciente_id, procedimento_id FROM atendimentos WHERE id = ${id} AND data_retorno_sugerida IS NOT NULL FOR SHARE`;
    if (!rows[0]) throw new ErroAgenda("Sugestão de retorno não encontrada.", 404);
    return inserir(tx as unknown as SQL, rows[0].paciente_id, rows[0].procedimento_id, horario);
  });
}
