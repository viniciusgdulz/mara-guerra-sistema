export type TipoLembrete = "lembrete_agendamento" | "lembrete_retorno";
export type WhatsAppPayload = {
  messaging_product: "whatsapp"; to: string; type: "template";
  biz_opaque_callback_data?: string;
  template: { name: string; language: { code: "pt_BR" }; components: Array<{ type: "body"; parameters: Array<{ type: "text"; text: string }> }> };
};
export class FalhaPreparacao extends Error {}
// Contrato de preparação, sem método de envio ou transporte HTTP.
export interface ProvedorWhatsApp {
  readonly modo: "simulado";
  preparar(payload: WhatsAppPayload): Promise<{ simulado: true }>;
}
export function normalizarWhatsApp(telefone: string): string {
  const limpo = telefone.trim();
  if (!/^[+\d\s().-]+$/.test(limpo)) throw new FalhaPreparacao("Telefone incompatível com WhatsApp. Confira DDD e código do país.");
  let digitos = limpo.replace(/\D/g, "");
  if (!limpo.startsWith("+") && [10, 11].includes(digitos.length)) digitos = `55${digitos}`;
  if (!/^[1-9]\d{9,14}$/.test(digitos) || (!limpo.startsWith("+") && !/^55\d{10,11}$/.test(digitos))) throw new FalhaPreparacao("Telefone incompatível com WhatsApp. Confira DDD e código do país.");
  return digitos;
}
export function prepararMensagem(tipo: TipoLembrete, nome: string, telefone: string, horario?: Date) {
  const primeiroNome = nome.trim().split(/\s+/)[0]?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 40) || "Olá";
  const parametros = [primeiroNome];
  let mensagem: string;
  if (tipo === "lembrete_agendamento") {
    if (!horario || !Number.isFinite(horario.getTime())) throw new FalhaPreparacao("Data do agendamento inválida.");
    const data = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" }).format(horario);
    const hora = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(horario);
    parametros.push(data, hora);
    mensagem = `Olá, ${primeiroNome}. Você tem um horário na Mara Guerra em ${data} às ${hora}. Para confirmar ou alterar, fale com a recepção.`;
  } else mensagem = `Olá, ${primeiroNome}. A equipe Mara Guerra está disponível para combinar seu próximo horário. Se desejar, fale com a recepção.`;
  const payload: WhatsAppPayload = { messaging_product: "whatsapp", to: normalizarWhatsApp(telefone), type: "template",
    template: { name: tipo === "lembrete_agendamento" ? "rascunho_lembrete_agendamento" : "rascunho_lembrete_retorno", language: { code: "pt_BR" },
      components: [{ type: "body", parameters: parametros.map(text => ({ type: "text", text })) }] } };
  return { mensagem, payload };
}
export const provedorSimulado: ProvedorWhatsApp = Object.freeze({ modo: "simulado" as const,
  async preparar(_payload: WhatsAppPayload) { return { simulado: true as const }; } });
