import type { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { validarId } from "./atendimentos.service";
import type { ErroWhatsAppMeta } from "../integrations/whatsapp-meta";
import { reconciliarEventosMeta } from "./meta-webhook.repository";
// Reserva deve estar confirmada em transação própria ANTES de chamar o canal.
export async function reservarTentativaMeta(tx: SQL, id: string, agora = new Date(), tentativaId = randomUUID()): Promise<boolean> {
  validarId(id); validarId(tentativaId);
  const rows = await tx`UPDATE notificacoes SET meta_estado = 'reservado', meta_tentativa_em = ${agora}, meta_tentativa_id = ${tentativaId}::uuid,
    meta_reserva_expira_em = ${new Date(agora.getTime() + 5 * 60000)}
    WHERE id = ${id} AND status IN ('pendente', 'falhou') AND previsao_envio <= ${agora}
      AND meta_estado = 'nao_iniciado' AND meta_wamid IS NULL RETURNING id`;
  return Boolean(rows[0]);
}
export async function registrarAceitacaoMeta(tx: SQL, id: string, wamid: string, agora = new Date(), tentativaId: string | null = null) {
  validarId(id); if (tentativaId) validarId(tentativaId);
  if (typeof wamid !== "string" || !/^wamid\.[^\s]{1,2048}$/.test(wamid)) throw new Error("Identificador Meta inválido.");
  const rows = await tx`UPDATE notificacoes SET meta_estado = 'aceita', meta_falha_codigo = NULL, meta_wamid = ${wamid}, meta_aceita_em = COALESCE(meta_aceita_em, ${agora})
    WHERE id = ${id} AND (${tentativaId}::uuid IS NULL OR meta_tentativa_id = ${tentativaId}::uuid)
      AND (meta_estado IN ('reservado', 'incerto') OR (meta_estado = 'aceita' AND meta_wamid = ${wamid}))
    RETURNING id, meta_estado, meta_wamid`;
  if (!rows[0]) throw new Error("Aceitação incompatível com o estado da tentativa Meta.");
  await reconciliarEventosMeta(tx, wamid, agora);
  return { id: rows[0].id as string, estado: "aceita" as const, messageId: rows[0].meta_wamid as string };
}
export async function registrarFalhaMeta(tx: SQL, id: string, erro: Pick<ErroWhatsAppMeta, "resultadoIncerto"> & { codigoMeta?: number }, tentativaId: string | null = null) {
  validarId(id); if (tentativaId) validarId(tentativaId);
  const estado = erro.resultadoIncerto === false ? "falhou" : "incerto";
  const codigo = Number.isInteger(erro.codigoMeta) && erro.codigoMeta! >= 0 && erro.codigoMeta! <= 2147483647 ? erro.codigoMeta! : null;
  const rows = await tx`UPDATE notificacoes SET meta_estado = ${estado}, meta_falha_codigo = ${codigo}
    WHERE id = ${id} AND meta_estado = 'reservado'
      AND (${tentativaId}::uuid IS NULL OR meta_tentativa_id = ${tentativaId}::uuid) RETURNING id`;
  if (!rows[0]) {
    const atuais = await tx`SELECT meta_estado FROM notificacoes WHERE id = ${id} AND meta_estado IN ('aceita', 'incerto')
      AND (${tentativaId}::uuid IS NULL OR meta_tentativa_id = ${tentativaId}::uuid)`;
    if (atuais[0]) return { id, estado: atuais[0].meta_estado as string };
    throw new Error("Falha incompatível com o estado da tentativa Meta.");
  }
  return { id, estado };
}
export async function registrarBloqueioMeta(tx: SQL, id: string, tentativaId: string) {
  validarId(id); validarId(tentativaId);
  const rows = await tx`UPDATE notificacoes SET meta_estado = 'bloqueado' WHERE id = ${id}
    AND meta_tentativa_id = ${tentativaId}::uuid AND meta_estado IN ('reservado', 'incerto') RETURNING id`;
  if (!rows[0]) throw new Error("Bloqueio incompatível com a reserva Meta.");
}
export async function expirarReservasMeta(tx: SQL, agora = new Date()) {
  const rows = await tx`UPDATE notificacoes SET meta_estado = 'incerto' WHERE meta_estado = 'reservado'
    AND meta_reserva_expira_em <= ${agora} RETURNING id`;
  return rows.length;
}
