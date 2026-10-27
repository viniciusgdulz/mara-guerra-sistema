import type { SQL } from "bun";

export class DadosPacienteInvalidos extends Error {}
export type Paciente = {
  id: string; nome: string; telefone: string; email: string | null;
  data_nascimento: string | null; data_cadastro: Date;
};

function publico(p: Paciente): Paciente {
  return { id: p.id, nome: p.nome, telefone: p.telefone, email: p.email,
    data_nascimento: p.data_nascimento, data_cadastro: p.data_cadastro };
}

export async function cadastrarPaciente(db: SQL, dados: unknown): Promise<Paciente> {
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) throw new DadosPacienteInvalidos("Dados do paciente inválidos.");
  const { nome, telefone, email, data_nascimento } = dados as Record<string, unknown>;
  if (typeof nome !== "string" || !nome.trim() || nome.trim().length > 150) throw new DadosPacienteInvalidos("Nome deve conter de 1 a 150 caracteres.");
  if (typeof telefone !== "string" || telefone.trim().length > 20 || !/^[+\d\s().-]+$/.test(telefone.trim()) || telefone.replace(/\D/g, "").length < 8 || telefone.replace(/\D/g, "").length > 15) throw new DadosPacienteInvalidos("Informe um telefone válido, com 8 a 15 dígitos e até 20 caracteres.");
  let emailNormalizado: string | null = null;
  if (email !== undefined && email !== null) {
    if (typeof email !== "string") throw new DadosPacienteInvalidos("E-mail inválido.");
    emailNormalizado = email.trim().toLowerCase() || null;
    if (emailNormalizado && (emailNormalizado.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado))) throw new DadosPacienteInvalidos("E-mail inválido.");
  }
  let nascimento: string | null = null;
  if (data_nascimento !== undefined && data_nascimento !== null && data_nascimento !== "") {
    if (typeof data_nascimento !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data_nascimento)) throw new DadosPacienteInvalidos("Data de nascimento inválida.");
    const data = new Date(`${data_nascimento}T00:00:00Z`);
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== data_nascimento || data_nascimento < "0001-01-01" || data_nascimento > hoje) throw new DadosPacienteInvalidos("Informe uma data de nascimento existente e não futura.");
    nascimento = data_nascimento;
  }
  const rows = await db<Paciente[]>`INSERT INTO pacientes (nome, telefone, email, data_nascimento)
    VALUES (${nome.trim()}, ${telefone.trim()}, ${emailNormalizado}, ${nascimento})
    RETURNING id, nome, telefone, email, data_nascimento::text AS data_nascimento, data_cadastro`;
  if (!rows[0]) throw new Error("Cadastro não retornado.");
  return publico(rows[0]);
}

export async function listarPacientes(db: SQL, busca: string, pagina: number): Promise<Paciente[]> {
  // Escapa curingas para que %, _ e barra sejam pesquisados literalmente.
  const filtro = `%${busca.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db<Paciente[]>`SELECT id, nome, telefone, email, data_nascimento::text AS data_nascimento, data_cadastro
    FROM pacientes WHERE nome ILIKE ${filtro}
    ORDER BY nome, id LIMIT 51 OFFSET ${(pagina - 1) * 50}`;
  return rows.map(publico);
}
