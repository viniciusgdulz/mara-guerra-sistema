const procedureForm = document.getElementById("procedimento-form");
const procedureMessage = document.getElementById("procedimento-message");
const procedureListMessage = document.getElementById("procedimentos-lista-message");
const procedureList = document.getElementById("procedimentos-lista");
const procedureSave = document.getElementById("salvar-procedimento");
const procedureCancel = document.getElementById("cancelar-procedimento");
const procedurePrevious = document.getElementById("procedimentos-anterior");
const procedureNext = document.getElementById("procedimentos-proxima");
let procedureUser = null;
let procedureSession = 0;
let procedureVersion = 0;
let procedurePage = 1;
let procedureSearch = "";
let procedureEditing = null;
let procedureBusy = false;

function resetProcedureEditor() {
  procedureEditing = null;
  procedureForm.reset();
  document.getElementById("procedimento-form-title").textContent = "Novo procedimento";
  procedureSave.textContent = "Cadastrar procedimento";
  procedureCancel.hidden = true;
}

function setupProcedures(usuario) {
  const changed = procedureUser?.id !== usuario?.id || procedureUser?.perfil !== usuario?.perfil;
  procedureUser = usuario;
  const admin = usuario?.perfil === "administrador";
  document.getElementById("procedimento-editor").hidden = !admin;
  document.getElementById("procedimentos-actions").hidden = !admin;
  document.getElementById("procedimentos-access").textContent = admin ? "Gerencie procedimentos ativos e inativos. A inativação preserva os registros existentes." : "Catálogo de procedimentos ativos para consulta.";
  if (!usuario || changed) {
    procedureSession++;
    procedureVersion++;
    resetProcedureEditor();
    procedureList.replaceChildren();
    procedureMessage.textContent = procedureListMessage.textContent = "";
    document.getElementById("procedimentos-pesquisa").reset();
    document.getElementById("procedimentos-pagina").textContent = "";
    procedureSearch = "";
    procedurePage = 1;
    procedurePrevious.disabled = procedureNext.disabled = true;
    procedureBusy = false;
    procedureSave.disabled = procedureCancel.disabled = false;
    if (usuario) loadProcedures(1);
  }
}

async function procedureResponse(response) {
  if (response.status === 401) {
    showUser(null);
    document.getElementById("login-message").textContent = "Sua sessão expirou. Entre novamente.";
    return null;
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Não foi possível concluir a operação.");
  return data;
}

function procedureButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = procedureBusy;
  button.addEventListener("click", action);
  return button;
}

function setProcedureBusy(busy) {
  procedureBusy = busy;
  procedureSave.disabled = procedureCancel.disabled = busy;
  for (const button of procedureList.querySelectorAll("button")) button.disabled = busy;
}

async function loadProcedures(page) {
  const version = ++procedureVersion;
  procedurePrevious.disabled = procedureNext.disabled = true;
  procedureList.replaceChildren();
  procedureListMessage.textContent = "Carregando procedimentos…";
  try {
    const params = new URLSearchParams({ nome: procedureSearch, pagina: String(page) });
    const response = await fetch(`/api/procedimentos?${params}`, { cache: "no-store" });
    if (version !== procedureVersion || !procedureUser) return;
    const data = await procedureResponse(response);
    if (!data || version !== procedureVersion || !procedureUser) return;
    for (const p of data.procedimentos) {
      const row = document.createElement("tr");
      for (const value of [p.nome, p.descricao ?? "—", p.intervalo_retorno_dias === null ? "Não informado" : `${p.intervalo_retorno_dias} dia(s)`, p.ativo ? "Ativo" : "Inativo"]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      if (procedureUser.perfil === "administrador") {
        const actions = document.createElement("td");
        actions.className = "procedure-actions";
        actions.append(procedureButton("Editar", () => {
          if (procedureBusy) return;
          procedureEditing = p.id;
          document.getElementById("procedimento-form-title").textContent = `Editar procedimento${p.ativo ? "" : " inativo"}`;
          document.getElementById("procedimento-nome").value = p.nome;
          document.getElementById("procedimento-descricao").value = p.descricao ?? "";
          document.getElementById("procedimento-intervalo").value = p.intervalo_retorno_dias ?? "";
          procedureSave.textContent = "Salvar alterações";
          procedureCancel.hidden = false;
          procedureMessage.textContent = "";
          document.getElementById("procedimento-nome").focus();
        }));
        if (p.ativo) actions.append(procedureButton("Inativar", () => deactivateProcedure(p)));
        row.append(actions);
      }
      procedureList.append(row);
    }
    procedurePage = page;
    document.getElementById("procedimentos-pagina").textContent = `Página ${page}`;
    procedurePrevious.disabled = page === 1;
    procedureNext.disabled = !data.temMais;
    procedureListMessage.textContent = data.procedimentos.length ? `${data.procedimentos.length} procedimento(s) nesta página.` : "Nenhum procedimento encontrado.";
  } catch (error) {
    if (version === procedureVersion) procedureListMessage.textContent = error.message || "Não foi possível conectar ao servidor.";
  }
}

async function deactivateProcedure(p) {
  if (procedureBusy || !confirm(`Inativar o procedimento “${p.nome}”? Ele deixará de aparecer para funcionários.`)) return;
  const session = procedureSession;
  setProcedureBusy(true);
  procedureMessage.textContent = "Inativando procedimento…";
  try {
    const response = await fetch(`/api/procedimentos/${encodeURIComponent(p.id)}/inativar`, { method: "POST" });
    if (session !== procedureSession) return;
    const data = await procedureResponse(response);
    if (!data || session !== procedureSession) return;
    if (procedureEditing === p.id) resetProcedureEditor();
    procedureMessage.textContent = "Procedimento inativado com sucesso.";
    await loadProcedures(procedurePage);
  } catch (error) {
    if (session === procedureSession) procedureMessage.textContent = `${error.message} Atualize o catálogo para conferir o status antes de tentar novamente.`;
  } finally { if (session === procedureSession) setProcedureBusy(false); }
}

procedureForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (procedureBusy || procedureUser?.perfil !== "administrador") return;
  const session = procedureSession;
  const id = procedureEditing;
  const interval = document.getElementById("procedimento-intervalo").value;
  const dados = { nome: document.getElementById("procedimento-nome").value,
    descricao: document.getElementById("procedimento-descricao").value,
    intervalo_retorno_dias: interval === "" ? null : Number(interval) };
  setProcedureBusy(true);
  procedureMessage.textContent = "Salvando procedimento…";
  try {
    const response = await fetch(id ? `/api/procedimentos/${encodeURIComponent(id)}` : "/api/procedimentos", {
      method: id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dados),
    });
    if (session !== procedureSession) return;
    const data = await procedureResponse(response);
    if (!data || session !== procedureSession) return;
    resetProcedureEditor();
    procedureMessage.textContent = id ? "Procedimento atualizado com sucesso." : "Procedimento cadastrado com sucesso.";
    if (!id) {
      procedureSearch = "";
      document.getElementById("procedimentos-busca").value = "";
    }
    await loadProcedures(id ? procedurePage : 1);
  } catch (error) {
    if (session === procedureSession) procedureMessage.textContent = `${error.message} Consulte o catálogo antes de repetir o envio.`;
  } finally { if (session === procedureSession) setProcedureBusy(false); }
});
procedureCancel.addEventListener("click", () => { resetProcedureEditor(); procedureMessage.textContent = "Edição cancelada."; });
document.getElementById("procedimentos-pesquisa").addEventListener("submit", event => {
  event.preventDefault();
  procedureSearch = document.getElementById("procedimentos-busca").value.trim();
  loadProcedures(1);
});
procedurePrevious.addEventListener("click", () => loadProcedures(procedurePage - 1));
procedureNext.addEventListener("click", () => loadProcedures(procedurePage + 1));
