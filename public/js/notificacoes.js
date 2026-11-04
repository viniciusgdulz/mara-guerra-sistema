const nt = id => document.getElementById(`notificacoes-${id}`);
let notificationUser = null, notificationSession = 0, notificationVersion = 0, notificationLoaded = false, notificationPage = 1, notificationBusy = false;
function setupNotificacoes(usuario) {
  const admin = usuario?.perfil === "administrador" ? usuario : null;
  const changed = notificationUser?.id !== admin?.id;
  notificationUser = admin;
  if (!admin || changed) {
    notificationSession++; notificationVersion++; notificationLoaded = false; notificationBusy = false; notificationPage = 1;
    nt("filtros").reset(); nt("lista").replaceChildren();
    for (const id of ["message", "lista-message", "pagina"]) nt(id).textContent = "";
    nt("provedor").textContent = "Envios externos bloqueados na Etapa 3.";
    nt("reconciliar").hidden = true;
    nt("anterior").disabled = nt("proxima").disabled = true; nt("gerar").disabled = false;
    if (!admin) nt("area").hidden = true;
  }
}
function openNotificacoes() {
  if (notificationUser && !notificationLoaded) { notificationLoaded = true; loadNotificacoes(1); }
}
async function notificationResponse(response) {
  if (response.status === 401) { showUser(null); document.getElementById("login-message").textContent = "Sua sessão expirou. Entre novamente."; return null; }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Não foi possível concluir a operação.");
  return data;
}
function notificationButton(label, action) {
  const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = notificationBusy;
  button.addEventListener("click", action); return button;
}
async function loadNotificacoes(page) {
  if (!notificationUser) return;
  const session = notificationSession, version = ++notificationVersion;
  nt("lista").replaceChildren(); nt("lista-message").textContent = "Consultando notificações…"; nt("anterior").disabled = nt("proxima").disabled = true;
  try {
    const params = new URLSearchParams({ pagina: String(page), status: nt("status").value });
    const response = await fetch(`/api/notificacoes?${params}`, { cache: "no-store" });
    if (session !== notificationSession || version !== notificationVersion) return;
    const data = await notificationResponse(response);
    if (!data || session !== notificationSession || version !== notificationVersion) return;
    nt("provedor").textContent = `Provedor selecionado: ${data.processamento?.provedor ?? "simulado"}. Envios externos bloqueados na Etapa 3, mesmo com habilitação configurada.`;
    nt("reconciliar").hidden = !data.processamento?.persistencia_habilitada;
    for (const n of data.notificacoes) {
      const row = document.createElement("tr");
      const dataHora = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(n.previsao_envio));
      for (const value of [n.paciente_nome, n.tipo === "lembrete_agendamento" ? "Lembrete de horário" : "Contato de retorno", dataHora, n.status, [n.mensagem, n.diagnostico].filter(Boolean).join("\n") || "Sem prévia disponível."]) {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      }
      const actions = document.createElement("td");
      if (n.pode_simular) actions.append(notificationButton("Simular preparação", () => writeNotificacao(`/api/notificacoes/${encodeURIComponent(n.id)}/simular`)));
      if (n.pode_processar ?? n.pode_simular) actions.append(notificationButton("Processar com provedor selecionado", () => writeNotificacao(`/api/notificacoes/${encodeURIComponent(n.id)}/processar`)));
      if (["pendente", "falhou"].includes(n.status)) actions.append(notificationButton("Cancelar", () => { if (confirm("Cancelar esta notificação? Nenhuma mensagem será enviada.")) writeNotificacao(`/api/notificacoes/${encodeURIComponent(n.id)}/cancelar`); }));
      row.append(actions); nt("lista").append(row);
    }
    notificationPage = page; nt("pagina").textContent = `Página ${page}`; nt("anterior").disabled = page === 1; nt("proxima").disabled = !data.temMais;
    nt("lista-message").textContent = data.notificacoes.length ? `${data.notificacoes.length} notificação(ões) nesta página. Modo simulado.` : "Nenhuma notificação encontrada.";
  } catch (error) { if (session === notificationSession && version === notificationVersion) nt("lista-message").textContent = error.message; }
}
async function writeNotificacao(path) {
  if (!notificationUser || notificationBusy) return;
  const session = notificationSession; notificationBusy = true; nt("gerar").disabled = nt("reconciliar").disabled = true;
  for (const button of nt("lista").querySelectorAll("button")) button.disabled = true;
  nt("message").textContent = "Preparando, sem envio real…";
  try {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (session !== notificationSession) return;
    const data = await notificationResponse(response);
    if (!data || session !== notificationSession) return;
    nt("message").textContent = path.endsWith("/gerar") ? `${data.geradas} gerada(s), ${data.atualizadas} atualizada(s), ${data.canceladas} cancelada(s). Nenhum envio realizado.`
      : path.endsWith("/reconciliar") ? `${data.expiradas} reserva(s) movida(s) para incerto, ${data.aplicados} evento(s) reconciliado(s). Nenhum reenvio.` : data.mensagem ?? "Notificação cancelada. Nenhum envio realizado.";
    await loadNotificacoes(notificationPage);
  } catch (error) { if (session === notificationSession) nt("message").textContent = `${error.message} Atualize a consulta para conferir o estado.`; }
  finally {
    if (session === notificationSession) {
      notificationBusy = false; nt("gerar").disabled = nt("reconciliar").disabled = false;
      for (const button of nt("lista").querySelectorAll("button")) button.disabled = false;
    }
  }
}
nt("gerar").addEventListener("click", () => writeNotificacao("/api/notificacoes/gerar"));
nt("reconciliar").addEventListener("click", () => writeNotificacao("/api/notificacoes/reconciliar"));
nt("filtros").addEventListener("submit", event => { event.preventDefault(); loadNotificacoes(1); });
nt("anterior").addEventListener("click", () => loadNotificacoes(notificationPage - 1));
nt("proxima").addEventListener("click", () => loadNotificacoes(notificationPage + 1));
