// Uma única ordem de bloqueio para geração, preparação e alteração de consentimento.
import type { SQL } from "bun";
export async function bloquearNotificacoes(tx: SQL) {
  await tx`SELECT pg_advisory_xact_lock(hashtext('mara:notificacoes:v1'))`;
}
