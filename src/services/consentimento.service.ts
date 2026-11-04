import type { SQL } from "bun";
import { validarId } from "./atendimentos.service";
import { bloquearNotificacoes } from "./notificacoes-lock";
export class ErroConsentimento extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function publico(p: { id: string; consentimento_whatsapp: boolean; consentimento_whatsapp_em: Date | null }) {
  return { id: p.id, consentimento_whatsapp: p.consentimento_whatsapp, consentimento_whatsapp_em: p.consentimento_whatsapp_em };
}
export async function obterConsentimento(db: SQL, id: string) {
  validarId(id);
  const rows = await db`SELECT id, consentimento_whatsapp, consentimento_whatsapp_em FROM pacientes WHERE id = ${id}`;
  if (!rows[0]) throw new ErroConsentimento("Paciente não encontrado.", 404);
  return publico(rows[0]);
}
export async function alterarConsentimento(db: SQL, id: string, dados: unknown) {
  validarId(id);
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) throw new ErroConsentimento("Dados de consentimento inválidos.");
  const d = dados as Record<string, unknown>;
  if (Object.keys(d).some(c => !["consentimento_whatsapp", "confirmacao_explicita"].includes(c)) || typeof d.consentimento_whatsapp !== "boolean" || d.confirmacao_explicita !== true) throw new ErroConsentimento("Confirme explicitamente a autorização ou a solicitação de revogação do paciente.");
  const autoriza = d.consentimento_whatsapp;
  return db.begin(async tx => {
    await bloquearNotificacoes(tx as unknown as SQL);
    const rows = await tx`UPDATE pacientes SET consentimento_whatsapp = ${autoriza},
      consentimento_whatsapp_em = CASE WHEN ${autoriza} THEN COALESCE(consentimento_whatsapp_em, CURRENT_TIMESTAMP) ELSE NULL END
      WHERE id = ${id} RETURNING id, consentimento_whatsapp, consentimento_whatsapp_em`;
    if (!rows[0]) throw new ErroConsentimento("Paciente não encontrado.", 404);
    if (!autoriza) await tx`UPDATE notificacoes SET status = 'cancelada', data_envio = NULL
      WHERE paciente_id = ${id} AND status IN ('pendente', 'falhou')`;
    return publico(rows[0]);
  });
}
