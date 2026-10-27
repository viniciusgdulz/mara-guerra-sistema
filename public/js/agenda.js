const ag = id => document.getElementById(`agenda-${id}`);
const agendaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const agendaParts = value => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return { data: `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`, hora: `${parts.hour}:${parts.minute}` };
};
let agendaUser = null;
let agendaSession = 0;
let agendaLoaded = false;
let agendaVersion = 0;
let agendaReturnVersion = 0;
let agendaPage = 1;
let agendaReturnPage = 1;
let agendaEditing = null;
let agendaSource = null;
let agendaBusy = false;
const agendaPickers = { paciente: { page: 1, search: "", version: 0 }, procedimento: { page: 1, search: "", version: 0 } };
const agendaStatus = { pendente: "Agendado", confirmado: "Agendado (confirmado)", realizado: "Concluído", cancelado: "Cancelado", nao_compareceu: "Não compareceu" };
function setupAgenda(usuario) {
  const changed = agendaUser?.id !== usuario?.id || agendaUser?.perfil !== usuario?.perfil;
  agendaUser = usuario;
  ag("retornos-area").hidden = usuario?.perfil !== "administrador";
  if (!usuario || changed) {
    agendaSession++; agendaVersion++; agendaReturnVersion++;
    agendaLoaded = false; agendaBusy = false; agendaEditing = agendaSource = null;
    ag("form").reset(); ag("filtros").reset(); ag("retornos-filtros").reset();
    ag("dia").value = agendaToday();
    ag("retornos-inicio").value = ag("retornos-fim").value = agendaToday();
    for (const id of ["lista", "retornos-lista"]) ag(id).replaceChildren();
    for (const id of ["message", "lista-message", "retornos-message", "pagina", "retornos-pagina", "vinculo"]) ag(id).textContent = "";
    for (const kind of ["paciente", "procedimento"]) {
      agendaPickers[kind].version++; agendaPickers[kind].page = 1; agendaPickers[kind].search = "";
      ag(`${kind}-pesquisa`).reset(); resetAgendaSelect(kind);
      ag(`${kind}-message`).textContent = "";
      ag(`${kind}-anterior`).disabled = ag(`${kind}-proxima`).disabled = true;
    }
    ag("anterior").disabled = ag("proxima").disabled = ag("retornos-anterior").disabled = ag("retornos-proxima").disabled = true;
    ag("salvar").disabled = false;
  }
}
function openAgenda() {
  if (agendaUser && !agendaLoaded) { agendaLoaded = true; loadAgenda(1); }
}
async function agendaResponse(response) {
  if (response.status === 401) {
    showUser(null); document.getElementById("login-message").textContent = "Sua sessão expirou. Entre novamente."; return null;
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Não foi possível concluir a operação.");
  return data;
}
function resetAgendaSelect(kind) {
  const option = document.createElement("option"); option.value = ""; option.textContent = `Selecione um ${kind}`;
  ag(kind).replaceChildren(option);
}
async function loadAgendaPicker(kind, page, selected = "") {
  const state = agendaPickers[kind]; const version = ++state.version; const session = agendaSession;
  resetAgendaSelect(kind); ag(`${kind}-message`).textContent = "Carregando…";
  ag(`${kind}-anterior`).disabled = ag(`${kind}-proxima`).disabled = true;
  try {
    const params = new URLSearchParams({ nome: state.search, pagina: String(page) });
    const endpoint = kind === "paciente" ? "/api/pacientes" : "/api/agenda/procedimentos";
    const response = await fetch(`${endpoint}?${params}`, { cache: "no-store" });
    if (session !== agendaSession || version !== state.version) return;
    const data = await agendaResponse(response);
    if (!data || session !== agendaSession || version !== state.version) return;
    const rows = data[kind === "paciente" ? "pacientes" : "procedimentos"];
    for (const p of rows) {
      const option = document.createElement("option"); option.value = p.id;
      option.textContent = kind === "paciente" ? `${p.nome} — ${p.telefone}` : p.nome;
      ag(kind).append(option);
    }
    if (rows.some(r => r.id === selected)) ag(kind).value = selected;
    state.page = page; ag(`${kind}-anterior`).disabled = page === 1; ag(`${kind}-proxima`).disabled = !data.temMais;
    ag(`${kind}-message`).textContent = rows.length ? `Página ${page}: ${rows.length} opção(ões).` : "Nenhum resultado encontrado.";
  } catch (error) { if (session === agendaSession && version === state.version) ag(`${kind}-message`).textContent = error.message; }
}
function openAgendaEditor(booking = null, source = null) {
  if (!agendaUser || agendaBusy || (source && agendaUser.perfil !== "administrador")) return;
  agendaEditing = booking; agendaSource = source; ag("form").reset();
  ag("message").textContent = "";
  ag("editor-title").textContent = source ? "Agendar retorno sugerido" : booking ? "Reagendar" : "Novo agendamento";
  ag("selecao-paciente").hidden = Boolean(booking || source);
  ag("selecao-procedimento").hidden = Boolean(source);
  ag("vinculo").textContent = booking ? `Paciente: ${booking.paciente_nome}. Selecione um procedimento ativo e o novo horário.`
    : source ? `Paciente: ${source.paciente_nome}. Procedimento: ${source.procedimento_nome}. Confirme data e horário para criar o agendamento.` : "Selecione um paciente e um procedimento ativo.";
  const parts = booking ? agendaParts(booking.data_hora) : null;
  ag("data").value = source?.data_retorno_sugerida ?? parts?.data ?? ag("dia").value;
  ag("hora").value = parts?.hora ?? "";
  for (const kind of ["paciente", "procedimento"]) {
    agendaPickers[kind].version++; agendaPickers[kind].search = ""; ag(`${kind}-pesquisa`).reset();
  }
  if (!booking && !source) loadAgendaPicker("paciente", 1);
  if (!source) loadAgendaPicker("procedimento", 1, booking?.procedimento_id ?? "");
  showEditor("agenda", true, false);
  ag(booking || source ? "data" : "paciente").focus();
}
function agendaButton(label, action) {
  const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = agendaBusy;
  button.addEventListener("click", action); return button;
}
async function loadAgenda(page) {
  if (!agendaUser) return;
  const version = ++agendaVersion; const session = agendaSession;
  ag("lista").replaceChildren(); ag("lista-message").textContent = "Carregando agenda…";
  ag("anterior").disabled = ag("proxima").disabled = true;
  try {
    const params = new URLSearchParams({ data: ag("dia").value, nome: ag("busca").value.trim(), pagina: String(page) });
    const response = await fetch(`/api/agenda?${params}`, { cache: "no-store" });
    if (session !== agendaSession || version !== agendaVersion) return;
    const data = await agendaResponse(response);
    if (!data || session !== agendaSession || version !== agendaVersion) return;
    for (const a of data.agendamentos) {
      const row = document.createElement("tr");
      for (const value of [agendaParts(a.data_hora).hora, a.paciente_nome, a.paciente_telefone, a.procedimento_nome ?? "Não informado", agendaStatus[a.status] ?? a.status]) {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      }
      const actions = document.createElement("td");
      if (["pendente", "confirmado"].includes(a.status)) {
        actions.append(agendaButton("Reagendar", () => openAgendaEditor(a)));
        actions.append(agendaButton("Cancelar", () => agendaChangeStatus(a, "cancelado")));
        if (agendaUser.perfil === "administrador") actions.append(agendaButton("Concluir", () => agendaChangeStatus(a, "realizado")));
      }
      row.append(actions); ag("lista").append(row);
    }
    agendaPage = page; ag("pagina").textContent = `Página ${page}`;
    ag("anterior").disabled = page === 1; ag("proxima").disabled = !data.temMais;
    ag("lista-message").textContent = data.agendamentos.length ? `${data.agendamentos.length} agendamento(s) nesta página.` : "Nenhum agendamento encontrado para este dia e pesquisa.";
  } catch (error) { if (session === agendaSession && version === agendaVersion) ag("lista-message").textContent = error.message; }
}
function setAgendaBusy(busy) {
  agendaBusy = busy; ag("salvar").disabled = busy;
  for (const root of ["lista", "retornos-lista"]) for (const button of ag(root).querySelectorAll("button")) button.disabled = busy;
}
async function writeAgenda(path, method, dados, success, editor = false) {
  if (agendaBusy || !agendaUser) return;
  const session = agendaSession;
  setAgendaBusy(true); ag("message").textContent = "Salvando…";
  try {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(dados) });
    if (session !== agendaSession) return;
    const data = await agendaResponse(response);
    if (!data || session !== agendaSession) return;
    ag("message").textContent = success;
    if (editor) {
      ag("dia").value = agendaParts(data.agendamento.data_hora).data;
      ag("busca").value = ""; ag("form").reset();
      showEditor("agenda", false, activeScreen === "agenda");
      agendaEditing = agendaSource = null;
    }
    await loadAgenda(editor ? 1 : agendaPage);
  } catch (error) { if (session === agendaSession) ag("message").textContent = `${error.message} Consulte a agenda antes de repetir o envio.`; }
  finally { if (session === agendaSession) setAgendaBusy(false); }
}
function agendaChangeStatus(a, status) {
  if (!agendaBusy && confirm(`${status === "cancelado" ? "Cancelar" : "Concluir"} o agendamento de ${a.paciente_nome}?`)) {
    writeAgenda(`/api/agenda/${encodeURIComponent(a.id)}/status`, "PATCH", { status }, status === "cancelado" ? "Agendamento cancelado com sucesso." : "Agendamento concluído com sucesso.");
  }
}
async function loadAgendaReturns(page) {
  if (agendaUser?.perfil !== "administrador") return;
  const session = agendaSession; const version = ++agendaReturnVersion;
  ag("retornos-lista").replaceChildren(); ag("retornos-message").textContent = "Carregando retornos…";
  ag("retornos-anterior").disabled = ag("retornos-proxima").disabled = true;
  try {
    const params = new URLSearchParams({ inicio: ag("retornos-inicio").value, fim: ag("retornos-fim").value, pagina: String(page) });
    const response = await fetch(`/api/agenda/retornos?${params}`, { cache: "no-store" });
    if (session !== agendaSession || version !== agendaReturnVersion) return;
    const data = await agendaResponse(response);
    if (!data || session !== agendaSession || version !== agendaReturnVersion) return;
    for (const r of data.retornos) {
      const row = document.createElement("tr");
      for (const value of [r.data_retorno_sugerida.split("-").reverse().join("/"), r.paciente_nome, `${r.procedimento_nome}${r.procedimento_ativo ? "" : " (inativo)"}`]) {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      }
      const actions = document.createElement("td");
      if (r.procedimento_ativo) actions.append(agendaButton("Agendar retorno", () => openAgendaEditor(null, r)));
      else actions.textContent = "Procedimento inativo: crie um novo agendamento com outro procedimento ativo.";
      row.append(actions); ag("retornos-lista").append(row);
    }
    agendaReturnPage = page; ag("retornos-pagina").textContent = `Página ${page}`;
    ag("retornos-anterior").disabled = page === 1; ag("retornos-proxima").disabled = !data.temMais;
    ag("retornos-message").textContent = data.retornos.length ? `${data.retornos.length} sugestão(ões). Confira a agenda antes de criar novos retornos.` : "Nenhum retorno sugerido no período.";
  } catch (error) { if (session === agendaSession && version === agendaReturnVersion) ag("retornos-message").textContent = error.message; }
}
for (const kind of ["paciente", "procedimento"]) {
  ag(`${kind}-pesquisa`).addEventListener("submit", event => { event.preventDefault(); agendaPickers[kind].search = ag(`${kind}-busca`).value.trim(); loadAgendaPicker(kind, 1); });
  ag(`${kind}-anterior`).addEventListener("click", () => loadAgendaPicker(kind, agendaPickers[kind].page - 1));
  ag(`${kind}-proxima`).addEventListener("click", () => loadAgendaPicker(kind, agendaPickers[kind].page + 1));
}
document.getElementById("novo-agendamento").addEventListener("click", () => openAgendaEditor());
ag("cancelar-edicao").addEventListener("click", () => { ag("form").reset(); showEditor("agenda", false); });
ag("form").addEventListener("submit", event => {
  event.preventDefault();
  const dados = { data: ag("data").value, hora: ag("hora").value };
  if (agendaSource) writeAgenda(`/api/agenda/retornos/${encodeURIComponent(agendaSource.sugestao_id)}/agendar`, "POST", dados, "Retorno agendado com sucesso.", true);
  else {
    dados.procedimento_id = ag("procedimento").value;
    if (!agendaEditing) dados.paciente_id = ag("paciente").value;
    writeAgenda(agendaEditing ? `/api/agenda/${encodeURIComponent(agendaEditing.id)}` : "/api/agenda", agendaEditing ? "PUT" : "POST", dados, agendaEditing ? "Agendamento reagendado com sucesso." : "Agendamento criado com sucesso.", true);
  }
});
ag("filtros").addEventListener("submit", event => { event.preventDefault(); loadAgenda(1); });
function agendaMoveDay(delta) {
  const date = new Date(`${ag("dia").value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) { ag("lista-message").textContent = "Selecione uma data válida."; return; }
  date.setUTCDate(date.getUTCDate() + delta);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return;
  ag("dia").value = date.toISOString().slice(0, 10); loadAgenda(1);
}
ag("dia-anterior").addEventListener("click", () => agendaMoveDay(-1));
ag("dia-proximo").addEventListener("click", () => agendaMoveDay(1));
ag("hoje").addEventListener("click", () => { ag("dia").value = agendaToday(); loadAgenda(1); });
ag("anterior").addEventListener("click", () => loadAgenda(agendaPage - 1));
ag("proxima").addEventListener("click", () => loadAgenda(agendaPage + 1));
ag("retornos-filtros").addEventListener("submit", event => { event.preventDefault(); loadAgendaReturns(1); });
ag("retornos-anterior").addEventListener("click", () => loadAgendaReturns(agendaReturnPage - 1));
ag("retornos-proxima").addEventListener("click", () => loadAgendaReturns(agendaReturnPage + 1));
