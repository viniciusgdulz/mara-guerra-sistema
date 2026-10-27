import type { SQL } from "bun";

export class ErroAtendimento extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function validarId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ErroAtendimento("Identificador inválido.");
}
export function validarData(valor: unknown): asserts valor is string {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor) || valor < "0001-01-01") throw new ErroAtendimento("Informe uma data válida no formato AAAA-MM-DD.");
  const data = new Date(`${valor}T00:00:00Z`);
  if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== valor) throw new ErroAtendimento("Informe uma data existente.");
}
export function calcularRetorno(data: string, intervalo: number | null): string | null {
  if (intervalo === null) return null;
  const resultado = new Date(`${data}T00:00:00Z`);
  resultado.setUTCDate(resultado.getUTCDate() + intervalo);
  if (!Number.isFinite(resultado.getTime()) || resultado.getUTCFullYear() > 9999) throw new ErroAtendimento("O intervalo do procedimento excede o limite de data. Ajuste o retorno manualmente.");
  return resultado.toISOString().slice(0, 10);
}
function objeto(dados: unknown, campos: string[]): Record<string, unknown> {
  if (!dados || typeof dados !== "object" || Array.isArray(dados) || Object.keys(dados).some(c => !campos.includes(c))) throw new ErroAtendimento("Dados do atendimento inválidos.");
  return dados as Record<string, unknown>;
}
function retornoManual(valor: unknown, data: string): string | null {
  if (valor === null) return null;
  validarData(valor);
  if (valor < data) throw new ErroAtendimento("O retorno não pode ser anterior ao atendimento.");
  return valor;
}
export type Atendimento = { id: string; paciente_id: string; procedimento_id: string; data_atendimento: string; data_retorno_sugerida: string | null };
function publico(a: Atendimento): Atendimento {
  return { id: a.id, paciente_id: a.paciente_id, procedimento_id: a.procedimento_id, data_atendimento: a.data_atendimento, data_retorno_sugerida: a.data_retorno_sugerida };
}
export async function cadastrarAtendimento(db: SQL, dados: unknown): Promise<Atendimento> {
  const entrada = objeto(dados, ["paciente_id", "procedimento_id", "data_atendimento", "data_retorno_sugerida"]);
  const { paciente_id, procedimento_id, data_atendimento } = entrada;
  validarId(paciente_id); validarId(procedimento_id); validarData(data_atendimento);
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (data_atendimento > hoje) throw new ErroAtendimento("A data do atendimento não pode ser futura.");
  const manual = Object.hasOwn(entrada, "data_retorno_sugerida");
  const ajustado = manual ? retornoManual(entrada.data_retorno_sugerida, data_atendimento) : null;
  return db.begin(async tx => {
    const pacientes = await tx`SELECT id FROM pacientes WHERE id = ${paciente_id} FOR KEY SHARE`;
    if (!pacientes[0]) throw new ErroAtendimento("Paciente não encontrado.", 404);
    // O bloqueio impede inativação/alteração concorrente até concluir o registro.
    const procedimentos = await tx`SELECT id, intervalo_retorno_dias FROM procedimentos WHERE id = ${procedimento_id} AND ativo = true FOR SHARE`;
    if (!procedimentos[0]) throw new ErroAtendimento("Selecione um procedimento ativo existente.", 400);
    const retorno = manual ? ajustado : calcularRetorno(data_atendimento, procedimentos[0].intervalo_retorno_dias);
    const rows = await tx`INSERT INTO atendimentos (paciente_id, procedimento_id, data_atendimento, data_retorno_sugerida)
      VALUES (${paciente_id}, ${procedimento_id}, ${data_atendimento}, ${retorno})
      RETURNING id, paciente_id, procedimento_id, data_atendimento::text AS data_atendimento, data_retorno_sugerida::text AS data_retorno_sugerida`;
    if (!rows[0]) throw new Error("Registro não retornado.");
    return publico(rows[0]);
  });
}
export async function ajustarRetorno(db: SQL, id: string, dados: unknown): Promise<Atendimento> {
  validarId(id);
  const entrada = objeto(dados, ["data_retorno_sugerida"]);
  if (!Object.hasOwn(entrada, "data_retorno_sugerida")) throw new ErroAtendimento("Informe a data sugerida de retorno ou null.");
  return db.begin(async tx => {
    const rows = await tx`SELECT data_atendimento::text AS data_atendimento FROM atendimentos WHERE id = ${id} FOR UPDATE`;
    if (!rows[0]) throw new ErroAtendimento("Atendimento não encontrado.", 404);
    const retorno = retornoManual(entrada.data_retorno_sugerida, rows[0].data_atendimento);
    const atualizados = await tx`UPDATE atendimentos SET data_retorno_sugerida = ${retorno} WHERE id = ${id}
      RETURNING id, paciente_id, procedimento_id, data_atendimento::text AS data_atendimento, data_retorno_sugerida::text AS data_retorno_sugerida`;
    if (!atualizados[0]) throw new Error("Registro não retornado.");
    return publico(atualizados[0]);
  });
}
export async function historicoPaciente(db: SQL, pacienteId: string, pagina: number) {
  validarId(pacienteId);
  const pacientes = await db`SELECT id FROM pacientes WHERE id = ${pacienteId}`;
  if (!pacientes[0]) throw new ErroAtendimento("Paciente não encontrado.", 404);
  // Sem filtro de ativo: a inativação do catálogo preserva o histórico.
  const rows = await db`SELECT a.id, a.paciente_id, a.procedimento_id, a.data_atendimento::text AS data_atendimento,
    a.data_retorno_sugerida::text AS data_retorno_sugerida, p.nome AS procedimento_nome, p.ativo AS procedimento_ativo
    FROM atendimentos a JOIN procedimentos p ON p.id = a.procedimento_id
    WHERE a.paciente_id = ${pacienteId} ORDER BY a.data_atendimento ASC, a.id ASC LIMIT 51 OFFSET ${(pagina - 1) * 50}`;
  return rows.map((a: Atendimento & { procedimento_nome: string; procedimento_ativo: boolean }) => ({ ...publico(a), procedimento_nome: a.procedimento_nome, procedimento_ativo: a.procedimento_ativo }));
}
