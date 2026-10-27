const appt = id => document.getElementById(`atendimento-${id}`);
let apptUser = null;
let apptSession = 0;
let apptHistoryVersion = 0;
let apptHistoryPage = 1;
let apptBusy = false;
const apptPickers = {
  paciente: { page: 1, search: "", version: 0, rows: new Map() },
  procedimento: { page: 1, search: "", version: 0, rows: new Map() },
};
const apptDateLabel = value => value ? value.split("-").reverse().join("/") : "Não informado";

function clearApptHistory() {
  apptHistoryVersion++;
  apptHistoryPage = 1;
  appt("historico").replaceChildren();
  appt("historico-pagina").textContent = "";
  appt("historico-message").textContent = "Selecione um paciente para consultar.";
  appt("historico-title").textContent = "Histórico do paciente";
  appt("historico-anterior").disabled = appt("historico-proxima").disabled = true;
  appt("atualizar").disabled = appt("salvar").disabled = !appt("paciente").value;
}
function setupAppointments(usuario) {
  const admin = usuario?.perfil === "administrador" ? usuario : null;
  const changed = apptUser?.id !== admin?.id;
  apptUser = admin;
  if (!admin) document.getElementById("atendimentos-area").hidden = true;
  if (!admin || changed) {
    apptSession++;
    apptBusy = false;
    for (const kind of ["paciente", "procedimento"]) {
      const state = apptPickers[kind];
      state.version++;
      state.page = 1; state.search = ""; state.rows.clear();
      appt(`${kind}-pesquisa`).reset();
      resetApptSelect(kind);
      appt(`${kind}-message`).textContent = "";
      appt(`${kind}-anterior`).disabled = appt(`${kind}-proxima`).disabled = true;
    }
    appt("form").reset();
    appt("retorno").disabled = true;
    appt("message").textContent = appt("previsao").textContent = "";
    clearApptHistory();
    if (admin) { loadApptPicker("paciente", 1); loadApptPicker("procedimento", 1); }
  }
}
function resetApptSelect(kind) {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = kind === "paciente" ? "Selecione um paciente" : "Selecione um procedimento ativo";
  appt(kind).replaceChildren(option);
}
async function apptResponse(response) {
  if (response.status === 401) {
    showUser(null);
    document.getElementById("login-message").textContent = "Sua sessão expirou. Entre novamente.";
    return null;
  }
  const data = await response.json();
  if (response.status === 403) setupAppointments(null);
  if (!response.ok) throw new Error(data.error ?? "Não foi possível concluir a operação.");
  return data;
}
async function loadApptPicker(kind, page) {
  const state = apptPickers[kind];
  const version = ++state.version;
  const session = apptSession;
  resetApptSelect(kind);
  state.rows.clear();
  if (kind === "paciente") clearApptHistory(); else previewApptReturn();
  appt(`${kind}-anterior`).disabled = appt(`${kind}-proxima`).disabled = true;
  appt(`${kind}-message`).textContent = "Carregando…";
  try {
    const params = new URLSearchParams({ nome: state.search, pagina: String(page) });
    const endpoint = kind === "paciente" ? "/api/pacientes" : "/api/atendimentos/procedimentos";
    const response = await fetch(`${endpoint}?${params}`, { cache: "no-store" });
    if (session !== apptSession || version !== state.version || !apptUser) return;
    const data = await apptResponse(response);
    if (!data || session !== apptSession || version !== state.version) return;
    const rows = kind === "paciente" ? data.pacientes : data.procedimentos;
    for (const row of rows) {
      state.rows.set(row.id, row);
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = kind === "paciente" ? `${row.nome} — ${row.telefone}` : row.nome;
      appt(kind).append(option);
    }
    state.page = page;
    appt(`${kind}-anterior`).disabled = page === 1;
    appt(`${kind}-proxima`).disabled = !data.temMais;
    appt(`${kind}-message`).textContent = rows.length ? `Página ${page}: ${rows.length} opção(ões).` : "Nenhum resultado encontrado.";
  } catch (error) {
    if (session === apptSession && version === state.version) appt(`${kind}-message`).textContent = error.message;
  }
}
function previewApptReturn() {
  const p = apptPickers.procedimento.rows.get(appt("procedimento").value);
  const date = appt("data").value;
  appt("retorno").disabled = !appt("retorno-manual").checked;
  appt("retorno").min = date;
  if (!p || !date) { appt("previsao").textContent = "Selecione o procedimento e a data para calcular o retorno."; return; }
  if (p.intervalo_retorno_dias === null) { appt("previsao").textContent = "Procedimento sem intervalo de retorno configurado."; return; }
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + p.intervalo_retorno_dias);
  appt("previsao").textContent = Number.isFinite(value.getTime()) && value.getUTCFullYear() <= 9999
    ? `Retorno automático previsto: ${apptDateLabel(value.toISOString().slice(0, 10))}. O servidor confirma o cálculo ao salvar.`
    : "Intervalo fora do limite de data. Ajuste o retorno manualmente.";
}
async function loadApptHistory(page) {
  const patient = appt("paciente").value;
  if (!patient || !apptUser) return;
  const version = ++apptHistoryVersion;
  const session = apptSession;
  appt("historico").replaceChildren();
  appt("historico-anterior").disabled = appt("historico-proxima").disabled = true;
  appt("historico-message").textContent = "Carregando histórico…";
  appt("historico-title").textContent = `Histórico de ${apptPickers.paciente.rows.get(patient)?.nome ?? "paciente selecionado"}`;
  try {
    const params = new URLSearchParams({ paciente_id: patient, pagina: String(page) });
    const response = await fetch(`/api/atendimentos?${params}`, { cache: "no-store" });
    if (session !== apptSession || version !== apptHistoryVersion) return;
    const data = await apptResponse(response);
    if (!data || session !== apptSession || version !== apptHistoryVersion) return;
    for (const a of data.atendimentos) {
      const row = document.createElement("tr");
      for (const value of [apptDateLabel(a.data_atendimento), `${a.procedimento_nome}${a.procedimento_ativo ? "" : " (inativo)"}`, apptDateLabel(a.data_retorno_sugerida)]) {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      }
      const actions = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button"; button.textContent = "Ajustar retorno"; button.disabled = apptBusy;
      button.addEventListener("click", () => adjustApptReturn(a, patient));
      actions.append(button); row.append(actions); appt("historico").append(row);
    }
    apptHistoryPage = page;
    appt("historico-pagina").textContent = `Página ${page}`;
    appt("historico-anterior").disabled = page === 1;
    appt("historico-proxima").disabled = !data.temMais;
    appt("historico-message").textContent = data.atendimentos.length ? `${data.atendimentos.length} atendimento(s) nesta página.` : "Nenhum atendimento registrado para este paciente.";
  } catch (error) {
    if (session === apptSession && version === apptHistoryVersion) appt("historico-message").textContent = error.message;
  }
}
function setApptBusy(value) {
  apptBusy = value;
  appt("salvar").disabled = value || !appt("paciente").value;
  for (const button of appt("historico").querySelectorAll("button")) button.disabled = value;
}
async function saveAppt(method, path, dados, patient, success) {
  const session = apptSession;
  setApptBusy(true);
  appt("message").textContent = "Salvando atendimento…";
  try {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(dados) });
    if (session !== apptSession) return;
    const data = await apptResponse(response);
    if (!data || session !== apptSession || patient !== appt("paciente").value) return;
    appt("message").textContent = `${success} Retorno: ${apptDateLabel(data.atendimento.data_retorno_sugerida)}.`;
    if (method === "POST") {
      appt("form").reset(); appt("retorno").disabled = true; previewApptReturn();
      showEditor("atendimentos", false, activeScreen === "atendimentos");
    }
    await loadApptHistory(1);
  } catch (error) {
    if (session === apptSession && patient === appt("paciente").value) appt("message").textContent = `${error.message} Atualize o histórico antes de repetir o envio.`;
  } finally { if (session === apptSession) setApptBusy(false); }
}
function adjustApptReturn(a, patient) {
  if (apptBusy || !apptUser) return;
  const value = prompt("Nova data sugerida de retorno (AAAA-MM-DD). Deixe vazio para remover a sugestão.", a.data_retorno_sugerida ?? "");
  if (value === null) return;
  saveAppt("PATCH", `/api/atendimentos/${encodeURIComponent(a.id)}/retorno`, { data_retorno_sugerida: value.trim() || null }, patient, "Retorno atualizado com sucesso.");
}
for (const kind of ["paciente", "procedimento"]) {
  appt(`${kind}-pesquisa`).addEventListener("submit", event => {
    event.preventDefault(); apptPickers[kind].search = appt(`${kind}-busca`).value.trim(); loadApptPicker(kind, 1);
  });
  appt(`${kind}-anterior`).addEventListener("click", () => loadApptPicker(kind, apptPickers[kind].page - 1));
  appt(`${kind}-proxima`).addEventListener("click", () => loadApptPicker(kind, apptPickers[kind].page + 1));
}
appt("paciente").addEventListener("change", () => {
  clearApptHistory(); setApptBusy(apptBusy); appt("message").textContent = "";
  if (appt("paciente").value) loadApptHistory(1);
});
for (const id of ["procedimento", "data", "retorno-manual"]) appt(id).addEventListener("change", previewApptReturn);
appt("form").addEventListener("submit", event => {
  event.preventDefault();
  if (apptBusy || !apptUser || !appt("paciente").value) return;
  const dados = { paciente_id: appt("paciente").value, procedimento_id: appt("procedimento").value, data_atendimento: appt("data").value };
  if (appt("retorno-manual").checked) dados.data_retorno_sugerida = appt("retorno").value || null;
  saveAppt("POST", "/api/atendimentos", dados, dados.paciente_id, "Atendimento registrado com sucesso.");
});
appt("atualizar").addEventListener("click", () => loadApptHistory(1));
appt("historico-anterior").addEventListener("click", () => loadApptHistory(apptHistoryPage - 1));
appt("historico-proxima").addEventListener("click", () => loadApptHistory(apptHistoryPage + 1));
