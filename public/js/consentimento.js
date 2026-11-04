const ce = id => document.getElementById(`consentimento-${id}`);
let consentUser = null, consentPatient = null, consentVersion = 0, consentBusy = false;
function closeConsentimento() {
  consentVersion++; consentPatient = null; consentBusy = false;
  ce("editor").hidden = true; ce("form").reset();
  ce("estado").textContent = ce("message").textContent = "";
  ce("autorizar").disabled = ce("revogar").disabled = true;
}
function setupConsentimento(usuario) {
  if (!usuario || consentUser?.id !== usuario.id || consentUser?.perfil !== usuario.perfil) closeConsentimento();
  consentUser = usuario;
}
function consentState(c) {
  ce("estado").textContent = c.consentimento_whatsapp ? `Autorizado em ${new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(c.consentimento_whatsapp_em))}.` : "Sem autorização ativa para WhatsApp.";
  ce("autorizar").disabled = consentBusy || c.consentimento_whatsapp;
  ce("revogar").disabled = consentBusy || !c.consentimento_whatsapp;
}
async function openConsentimento(paciente) {
  if (!consentUser) return;
  showEditor("pacientes", false, false);
  consentPatient = paciente; const version = ++consentVersion;
  ce("editor").hidden = false; document.getElementById("pacientes-consulta").hidden = true; document.getElementById("novo-paciente").hidden = true;
  ce("title").textContent = `Consentimento WhatsApp — ${paciente.nome}`; ce("title").focus(); ce("estado").textContent = "Consultando autorização…";
  try {
    const response = await fetch(`/api/pacientes/${encodeURIComponent(paciente.id)}/consentimento-whatsapp`, { cache: "no-store" });
    if (version !== consentVersion) return;
    if (expiredSession(response)) return;
    const data = await response.json(); if (version !== consentVersion) return;
    if (!response.ok) throw new Error(data.error ?? "Não foi possível consultar o consentimento.");
    consentState(data.consentimento);
  } catch (error) { if (version === consentVersion) ce("message").textContent = error.message; }
}
async function saveConsentimento(autorizar) {
  if (consentBusy || !consentPatient || !consentUser) return;
  if (!ce("confirmacao").checked) { ce("message").textContent = "Confirme a manifestação explícita do paciente antes de continuar."; return; }
  const version = consentVersion; consentBusy = true; ce("autorizar").disabled = ce("revogar").disabled = true;
  ce("message").textContent = "Registrando…";
  try {
    const response = await fetch(`/api/pacientes/${encodeURIComponent(consentPatient.id)}/consentimento-whatsapp`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consentimento_whatsapp: autorizar, confirmacao_explicita: true }),
    });
    if (version !== consentVersion) return;
    if (expiredSession(response)) return;
    const data = await response.json(); if (version !== consentVersion) return;
    if (!response.ok) throw new Error(data.error ?? "Não foi possível registrar a alteração.");
    consentBusy = false; ce("form").reset(); consentState(data.consentimento);
    ce("message").textContent = autorizar ? "Autorização registrada. Nenhuma mensagem foi enviada." : "Autorização revogada. Notificações pendentes canceladas.";
  } catch (error) {
    if (version === consentVersion) {
      ce("message").textContent = `${error.message} Reabra o consentimento para conferir o estado antes de repetir.`;
      // Falha ambígua: reconsultar antes de permitir nova alteração.
    }
  } finally { if (version === consentVersion) consentBusy = false; }
}
ce("form").addEventListener("submit", event => { event.preventDefault(); saveConsentimento(true); });
ce("revogar").addEventListener("click", () => saveConsentimento(false));
ce("voltar").addEventListener("click", () => showEditor("pacientes", false));
