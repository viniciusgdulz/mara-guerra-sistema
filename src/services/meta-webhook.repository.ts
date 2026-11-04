import type { SQL } from "bun";
import { bloquearNotificacoes } from "./notificacoes-lock";
export type EstadoEntrega = "sent" | "delivered" | "read" | "failed";
export type EventoMeta = { wamid: string; estado: EstadoEntrega; ocorridoEm: Date; phoneNumberId: string; erroCodigo: number | null; correlacao: string | null };
const ranking: Record<string, number> = { nao_confirmada: 0, sent: 1, delivered: 2, read: 3 };
export function deveAvancarEntrega(atual: string, proximo: EstadoEntrega): boolean {
  if (proximo === "failed") return atual === "nao_confirmada" || atual === "sent";
  if (atual === "failed") return proximo === "delivered" || proximo === "read";
  return (ranking[proximo] ?? 0) > (ranking[atual] ?? 0);
}
// Chamador mantém transação/lock. Nunca associa por telefone ou conteúdo.
export async function reconciliarEventosMeta(tx: SQL, wamid: string, agora = new Date()): Promise<number> {
  const notificacoes = await tx`SELECT id, status, meta_entrega_estado, meta_entrega_em, meta_tentativa_em FROM notificacoes
    WHERE meta_wamid = ${wamid} AND meta_estado = 'aceita' FOR UPDATE`;
  const n = notificacoes[0]; if (!n) return 0;
  const eventos = await tx`SELECT id, estado, ocorrido_em, erro_codigo FROM meta_webhook_eventos
    WHERE meta_wamid = ${wamid} AND aplicado_em IS NULL ORDER BY ocorrido_em, id FOR UPDATE`;
  let aplicados = 0;
  for (const e of eventos) {
    const entrega = n.meta_entrega_estado ?? "nao_confirmada";
    const data = new Date(e.ocorrido_em);
    const anterior = n.meta_entrega_em ? new Date(n.meta_entrega_em) : null;
    // failed não substitui delivered/read; falha anterior ao sent atual é obsoleta.
    const avancar = deveAvancarEntrega(entrega, e.estado) && !(e.estado === "failed" && anterior && data < anterior);
    if (avancar) {
      await tx`UPDATE notificacoes SET meta_entrega_estado = ${e.estado}, meta_entrega_em = ${data}, meta_entrega_erro = ${e.estado === "failed" ? e.erro_codigo : null},
        status = CASE WHEN status = 'cancelada' THEN status WHEN ${e.estado} = 'failed' THEN 'falhou' ELSE 'enviada' END,
        data_envio = CASE WHEN status = 'cancelada' OR ${e.estado} = 'failed' THEN NULL ELSE COALESCE(data_envio, ${data}) END
        WHERE id = ${n.id}`;
      n.meta_entrega_estado = e.estado; n.meta_entrega_em = data;
    }
    await tx`UPDATE meta_webhook_eventos SET notificacao_id = ${n.id}, aplicado_em = ${agora} WHERE id = ${e.id} AND aplicado_em IS NULL`;
    aplicados++;
  }
  return aplicados;
}
export async function receberEventosMeta(db: SQL, eventos: EventoMeta[], agora = new Date()) {
  return db.begin(async tx => {
    const sql = tx as unknown as SQL; await bloquearNotificacoes(sql);
    let novos = 0, duplicados = 0, aplicados = 0;
    for (const e of eventos) {
      const rows = await tx`INSERT INTO meta_webhook_eventos (phone_number_id, meta_wamid, estado, ocorrido_em, erro_codigo, correlacao)
        VALUES (${e.phoneNumberId}, ${e.wamid}, ${e.estado}, ${e.ocorridoEm}, ${e.erroCodigo}, ${e.correlacao}::uuid)
        ON CONFLICT (phone_number_id, meta_wamid, estado, ocorrido_em) DO NOTHING RETURNING id`;
      if (rows[0]) novos++; else duplicados++;
      // Callback opaco enviado pela aplicação pode reconciliar timeout sem wamid persistido.
      if (e.correlacao) await tx`UPDATE notificacoes SET meta_estado = 'aceita', meta_falha_codigo = NULL, meta_wamid = ${e.wamid}, meta_aceita_em = ${agora}
        WHERE id = ${e.correlacao}::uuid AND meta_estado IN ('reservado', 'incerto') AND meta_wamid IS NULL
          AND meta_tentativa_em <= ${e.ocorridoEm}::timestamptz + INTERVAL '5 minutes'`;
      aplicados += await reconciliarEventosMeta(sql, e.wamid, agora);
    }
    return { novos, duplicados, aplicados };
  });
}
