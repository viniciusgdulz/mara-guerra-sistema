import type { SQL } from "bun";
import { validarId } from "./atendimentos.service";
import { bloquearNotificacoes } from "./notificacoes-lock";
import { prepararMensagem, provedorSimulado, type ProvedorWhatsApp, type TipoLembrete } from "../integrations/whatsapp";
import { horarioAgenda } from "./agenda.service";
import { canalSimulado, selecionarProvedorWhatsApp, type CanalNotificacoes } from "../integrations/whatsapp-provider";
import { randomUUID } from "node:crypto";
import { ErroWhatsAppMeta } from "../integrations/whatsapp-meta";
import { expirarReservasMeta, registrarAceitacaoMeta, registrarBloqueioMeta, registrarFalhaMeta, reservarTentativaMeta } from "./notificacoes-meta.repository";
import { reconciliarEventosMeta } from "./meta-webhook.repository";
export class ErroNotificacao extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
type Contexto = { id: string; paciente_id: string; agendamento_id: string | null; atendimento_id: string | null; tipo: TipoLembrete;
  previsao_envio: Date; data_envio: Date | null; status: string; nome: string; telefone: string;
  consentimento_whatsapp: boolean; consentimento_whatsapp_em: Date | null; data_hora: Date | null; agendamento_status: string | null;
  data_retorno_sugerida: string | null; procedimento_ativo: boolean | null; retorno_agendado: boolean;
  meta_estado?: string; meta_wamid?: string | null; meta_entrega_estado?: string; meta_entrega_em?: string | null;
  meta_entrega_erro?: number | null; meta_falha_codigo?: number | null };
const temTentativaMeta = (c: Contexto) => (c.meta_estado ?? "nao_iniciado") !== "nao_iniciado" || Boolean(c.meta_wamid);
const diaSP = (agora: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);
export function bloqueioNotificacao(c: Contexto, agora: Date): string | null {
  if (!c.consentimento_whatsapp || !c.consentimento_whatsapp_em) return "Consentimento WhatsApp ausente ou revogado.";
  if (c.tipo === "lembrete_agendamento") {
    if (!c.data_hora || !["pendente", "confirmado"].includes(c.agendamento_status ?? "")) return "Agendamento encerrado ou indisponível.";
    if (new Date(c.data_hora).getTime() <= agora.getTime()) return "Horário do agendamento já passou.";
  } else {
    if (!c.data_retorno_sugerida || c.data_retorno_sugerida < diaSP(agora)) return "Sugestão de retorno ausente ou vencida.";
    if (!c.procedimento_ativo) return "Procedimento da sugestão está inativo.";
    if (c.retorno_agendado) return "Possível retorno já agendado. Confira a agenda.";
  }
  return null;
}
async function contextos(db: SQL, id: string | null, status: string | null, pagina: number) {
  return await db<Contexto[]>`SELECT n.id, n.paciente_id, n.agendamento_id, n.atendimento_id, n.tipo, n.previsao_envio, n.data_envio, n.status,
    COALESCE(to_jsonb(n)->>'meta_estado', 'nao_iniciado') AS meta_estado, to_jsonb(n)->>'meta_wamid' AS meta_wamid,
    COALESCE(to_jsonb(n)->>'meta_entrega_estado', 'nao_confirmada') AS meta_entrega_estado, to_jsonb(n)->>'meta_entrega_em' AS meta_entrega_em,
    (to_jsonb(n)->>'meta_entrega_erro')::integer AS meta_entrega_erro, (to_jsonb(n)->>'meta_falha_codigo')::integer AS meta_falha_codigo,
    p.nome, p.telefone, p.consentimento_whatsapp, p.consentimento_whatsapp_em, g.data_hora, g.status AS agendamento_status,
    a.data_retorno_sugerida::text AS data_retorno_sugerida, pr.ativo AS procedimento_ativo,
    EXISTS (SELECT 1 FROM agendamentos r WHERE r.paciente_id = a.paciente_id AND r.procedimento_id = a.procedimento_id
      AND r.status IN ('pendente', 'confirmado', 'realizado')
      AND (r.data_hora AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN a.data_retorno_sugerida AND a.data_retorno_sugerida + 30) AS retorno_agendado
    FROM notificacoes n JOIN pacientes p ON p.id = n.paciente_id
    LEFT JOIN agendamentos g ON g.id = n.agendamento_id LEFT JOIN atendimentos a ON a.id = n.atendimento_id
    LEFT JOIN procedimentos pr ON pr.id = a.procedimento_id
    WHERE (${id}::uuid IS NULL OR n.id = ${id}::uuid) AND (${status}::text IS NULL OR n.status = ${status})
    ORDER BY n.previsao_envio, n.id LIMIT 51 OFFSET ${(pagina - 1) * 50}`;
}
const previsaoAgendamento = (data: Date, agora: Date) => new Date(Math.max(agora.getTime(), new Date(data).getTime() - 86400000));
export async function gerarNotificacoes(db: SQL, agora = new Date()) {
  return db.begin(async tx => {
    const sql = tx as unknown as SQL;
    await bloquearNotificacoes(sql);
    let canceladas = 0, geradas = 0, atualizadas = 0;
    // Percorre a fila por páginas, sem alterar sua ordenação durante esta leitura.
    const pendentes: Contexto[] = [];
    for (const status of ["pendente", "falhou"]) {
      for (let pagina = 1; ; pagina++) {
        const rows = await contextos(sql, null, status, pagina); pendentes.push(...rows.slice(0, 50));
        if (rows.length <= 50) break;
      }
    }
    for (const c of pendentes) {
      if (temTentativaMeta(c)) continue; // Não reabrir aceitação, reserva, falha ou resultado incerto.
      if (bloqueioNotificacao(c, agora)) {
        await tx`UPDATE notificacoes SET status = 'cancelada', data_envio = NULL WHERE id = ${c.id} AND status IN ('pendente', 'falhou')`;
        canceladas++;
      } else {
        const data = c.tipo === "lembrete_agendamento" ? previsaoAgendamento(c.data_hora!, agora) : new Date(Math.max(agora.getTime(), horarioRetorno(c.data_retorno_sugerida!).getTime()));
        await tx`UPDATE notificacoes SET previsao_envio = ${data} WHERE id = ${c.id} AND status IN ('pendente', 'falhou')`;
        atualizadas++;
      }
    }
    const candidatos = await tx`SELECT g.id AS origem_id, g.paciente_id, 'lembrete_agendamento' AS tipo, g.data_hora, NULL::text AS data_retorno_sugerida
      FROM agendamentos g JOIN pacientes p ON p.id = g.paciente_id
      WHERE p.consentimento_whatsapp = true AND p.consentimento_whatsapp_em IS NOT NULL
        AND g.status IN ('pendente', 'confirmado') AND g.data_hora > ${agora} AND g.data_hora <= ${new Date(agora.getTime() + 48 * 3600000)}
      UNION ALL
      SELECT a.id, a.paciente_id, 'lembrete_retorno', NULL::timestamptz, a.data_retorno_sugerida::text
      FROM atendimentos a JOIN pacientes p ON p.id = a.paciente_id JOIN procedimentos pr ON pr.id = a.procedimento_id
      WHERE p.consentimento_whatsapp = true AND p.consentimento_whatsapp_em IS NOT NULL AND pr.ativo = true
        AND a.data_retorno_sugerida BETWEEN ${diaSP(agora)}::date AND ${diaSP(agora)}::date + 7
        AND NOT EXISTS (SELECT 1 FROM agendamentos r WHERE r.paciente_id = a.paciente_id AND r.procedimento_id = a.procedimento_id
          AND r.status IN ('pendente', 'confirmado', 'realizado')
          AND (r.data_hora AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN a.data_retorno_sugerida AND a.data_retorno_sugerida + 30)
      ORDER BY tipo, origem_id`;
    for (const c of candidatos) {
      const agendamento = c.tipo === "lembrete_agendamento" ? c.origem_id : null;
      const atendimento = c.tipo === "lembrete_retorno" ? c.origem_id : null;
      const existentes = await tx`SELECT id FROM notificacoes WHERE tipo = ${c.tipo}
        AND (agendamento_id = ${agendamento}::uuid OR atendimento_id = ${atendimento}::uuid) LIMIT 1`;
      // Uma notificação por origem/tipo, inclusive após falha, cancelamento ou revogação.
      if (existentes[0]) continue;
      const data = c.tipo === "lembrete_agendamento" ? previsaoAgendamento(c.data_hora, agora) : new Date(Math.max(agora.getTime(), horarioRetorno(c.data_retorno_sugerida).getTime()));
      await tx`INSERT INTO notificacoes (paciente_id, agendamento_id, atendimento_id, tipo, previsao_envio, status)
        VALUES (${c.paciente_id}, ${agendamento}, ${atendimento}, ${c.tipo}, ${data}, 'pendente')`;
      geradas++;
    }
    return { geradas, atualizadas, canceladas, modo: "simulado" };
  });
}
const horarioRetorno = (data: string) => horarioAgenda(data, "09:00");
function visualizar(c: Contexto, agora: Date) {
  const bloqueio = bloqueioNotificacao(c, agora);
  const tentativa = temTentativaMeta(c);
  let mensagem: string | null = null, diagnostico = tentativa ? `Tentativa Meta registrada (${c.meta_estado ?? "aceita"}). Reenvio bloqueado; aceitação não comprova entrega. Estado de webhook: ${c.meta_entrega_estado ?? "nao_confirmada"}.${c.meta_entrega_erro != null || c.meta_falha_codigo != null ? ` Código Meta: ${c.meta_entrega_erro ?? c.meta_falha_codigo}.` : ""}` : bloqueio;
  if (!bloqueio && !tentativa && !["cancelada", "enviada"].includes(c.status)) {
    try { mensagem = prepararMensagem(c.tipo, c.nome, c.telefone, c.data_hora ? new Date(c.data_hora) : undefined).mensagem; }
    catch { diagnostico = "Telefone incompatível com WhatsApp. Confira DDD e código do país."; }
  }
  if (!diagnostico && c.status === "falhou") diagnostico = "Falha anterior de preparação; o schema não armazena o detalhe. Simule novamente para conferir.";
  return { id: c.id, paciente_id: c.paciente_id, paciente_nome: c.nome, tipo: c.tipo, status: c.status,
    previsao_envio: c.previsao_envio, data_envio: c.data_envio, consentimento_whatsapp: c.consentimento_whatsapp && Boolean(c.consentimento_whatsapp_em),
    mensagem, diagnostico, meta_estado: c.meta_estado ?? "nao_iniciado",
    meta_entrega_estado: c.meta_entrega_estado ?? "nao_confirmada", meta_entrega_em: c.meta_entrega_em ?? null,
    meta_entrega_erro: c.meta_entrega_erro ?? null, meta_falha_codigo: c.meta_falha_codigo ?? null,
    pode_simular: !bloqueio && !tentativa && ["pendente", "falhou"].includes(c.status),
    pode_processar: !bloqueio && !tentativa && ["pendente", "falhou"].includes(c.status) };
}
export async function listarNotificacoes(db: SQL, status: string | null, pagina: number, agora = new Date()) {
  return (await contextos(db, null, status, pagina)).map(c => visualizar(c, agora));
}
export async function simularNotificacao(db: SQL, id: string, provedor: ProvedorWhatsApp = provedorSimulado, agora = new Date()) {
  if (provedor.modo !== "simulado") throw new ErroNotificacao("Envios reais estão desativados.", 403);
  return processarNotificacao(db, id, canalSimulado(provedor), agora);
}
// Único processamento de negócio: consentimento, elegibilidade, telefone e guarda de reenvio.
export async function processarNotificacao(db: SQL, id: string, canal: CanalNotificacoes = selecionarProvedorWhatsApp(), agora = new Date()) {
  validarId(id);
  const preparacao = await db.begin(async tx => {
    await bloquearNotificacoes(tx as unknown as SQL);
    const rows = await contextos(tx as unknown as SQL, id, null, 1);
    const c = rows[0]; if (!c) throw new ErroNotificacao("Notificação não encontrada.", 404);
    if (!["pendente", "falhou"].includes(c.status)) throw new ErroNotificacao("Notificação encerrada; não é possível simular.", 409);
    if (temTentativaMeta(c)) throw new ErroNotificacao("Tentativa Meta já registrada. Reenvio bloqueado até reconciliação explícita.", 409);
    const bloqueio = bloqueioNotificacao(c, agora);
    if (bloqueio) {
      await tx`UPDATE notificacoes SET status = 'cancelada', data_envio = NULL WHERE id = ${id}`;
      return { simulado: true, preparado: false, status: "cancelada", mensagem: bloqueio };
    }
    try {
      const mensagem = prepararMensagem(c.tipo, c.nome, c.telefone, c.data_hora ? new Date(c.data_hora) : undefined);
      if (canal.provedor === "meta") {
        if (!canal.persistenciaHabilitada) return { simulado: false, preparado: false, bloqueado: true, provedor: "meta",
          motivo: "persistencia_desabilitada", status: c.status, mensagem: "Persistência Meta desabilitada. Nenhuma chamada externa foi realizada." };
        const tentativaId = randomUUID();
        let reservada: boolean;
        try { reservada = await reservarTentativaMeta(tx as unknown as SQL, id, agora, tentativaId); }
        catch { throw new ErroNotificacao("Persistência Meta indisponível. Valide as migrações em banco isolado antes de habilitá-la.", 503); }
        if (!reservada) throw new ErroNotificacao("Notificação já reservada, encerrada ou ainda fora da previsão de processamento.", 409);
        return { reserva: true as const, tentativaId, payload: { ...mensagem.payload, biz_opaque_callback_data: id }, statusAnterior: c.status };
      }
      const resultado = await canal.processar(mensagem.payload);
      if (resultado.estado === "bloqueado") return { simulado: false, preparado: false, bloqueado: true, provedor: canal.provedor,
        motivo: resultado.motivo, status: c.status, mensagem: resultado.mensagem };
      if (resultado.estado !== "simulado") throw new Error("Resultado incompatível.");
      await tx`UPDATE notificacoes SET status = 'pendente', data_envio = NULL WHERE id = ${id}`;
      return { simulado: true, preparado: true, provedor: canal.provedor, status: "pendente", mensagem: "Preparação simulada concluída. Nenhuma mensagem foi enviada.", previa: mensagem.mensagem };
    } catch (error) {
      if (error instanceof ErroNotificacao) throw error;
      await tx`UPDATE notificacoes SET status = 'falhou', data_envio = NULL WHERE id = ${id}`;
      return { simulado: true, preparado: false, status: "falhou", mensagem: "Falha na preparação simulada. Confira telefone e diagnóstico; nenhum envio foi realizado." };
    }
  });
  if (!("reserva" in preparacao) || preparacao.reserva !== true) return preparacao;
  const { payload, tentativaId, statusAnterior } = preparacao;
  // db.begin já confirmou a reserva. Nenhum canal é chamado antes deste ponto.
  const concluir = async <T>(fn: (tx: SQL) => Promise<T>) => db.begin(async tx => {
    const sql = tx as unknown as SQL; await bloquearNotificacoes(sql); return fn(sql);
  });
  let resultado;
  try { resultado = await canal.processar(payload); }
  catch (error) {
    try {
      const estado = await concluir(tx => registrarFalhaMeta(tx, id,
        error instanceof ErroWhatsAppMeta ? error : { resultadoIncerto: true }, tentativaId));
      return { preparado: false, simulado: false, provedor: "meta", status: statusAnterior,
        meta_estado: estado.estado, mensagem: estado.estado === "aceita" ? "Resultado reconciliado por webhook. Não reenviar." : "Tentativa Meta com falha ou resultado incerto. Reenvio automático bloqueado." };
    } catch { throw new ErroNotificacao("Falha ao persistir resultado Meta. A reserva foi mantida; não repita o envio.", 503); }
  }
  try {
    if (resultado.estado === "bloqueado") {
      await concluir(tx => registrarBloqueioMeta(tx, id, tentativaId));
      return { preparado: false, simulado: false, bloqueado: true, provedor: "meta", meta_estado: "bloqueado",
        status: statusAnterior, motivo: resultado.motivo, mensagem: resultado.mensagem };
    }
    if (resultado.estado !== "aceita") throw new Error("Resultado Meta incompatível.");
    const messageId = resultado.messageId;
    const recibo = await concluir(tx => registrarAceitacaoMeta(tx, id, messageId, agora, tentativaId));
    return { preparado: true, simulado: false, provedor: "meta", meta_estado: "aceita", messageId: recibo.messageId,
      mensagem: "Aceitação Meta persistida. Entrega é confirmada somente por webhook verificado." };
  } catch { throw new ErroNotificacao("Não foi possível confirmar o resultado persistido. A reserva impede reenvio; reconcilie antes de repetir.", 503); }
}
export async function reconciliarNotificacoesMeta(db: SQL, agora = new Date()) {
  return db.begin(async tx => {
    const sql = tx as unknown as SQL; await bloquearNotificacoes(sql);
    const expiradas = await expirarReservasMeta(sql, agora);
    const filas = await tx`SELECT DISTINCT e.meta_wamid FROM meta_webhook_eventos e JOIN notificacoes n ON n.meta_wamid = e.meta_wamid
      WHERE e.aplicado_em IS NULL AND n.meta_estado = 'aceita' LIMIT 100`;
    let aplicados = 0;
    for (const fila of filas) aplicados += await reconciliarEventosMeta(sql, fila.meta_wamid, agora);
    return { expiradas, aplicados, reenviadas: 0 };
  });
}
export async function cancelarNotificacao(db: SQL, id: string) {
  validarId(id);
  return db.begin(async tx => {
    await bloquearNotificacoes(tx as unknown as SQL);
      const rows = await tx`UPDATE notificacoes SET status = 'cancelada', data_envio = NULL WHERE id = ${id} AND status IN ('pendente', 'falhou', 'cancelada')
        AND COALESCE(to_jsonb(notificacoes)->>'meta_estado', 'nao_iniciado') = 'nao_iniciado'
        AND to_jsonb(notificacoes)->>'meta_wamid' IS NULL RETURNING id, status`;
    if (!rows[0]) throw new ErroNotificacao("Notificação ausente ou já enviada.", 409);
    return { id: rows[0].id, status: rows[0].status };
  });
}
