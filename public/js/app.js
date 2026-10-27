async function checkServer() {
  const status = document.getElementById("server-status");
  if (!status) return;
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error("Falha ao consultar o servidor");
    const health = await response.json();
    if (health.status !== "ok") throw new Error("Status inesperado");
    status.textContent = "Servidor funcionando. Estrutura inicial pronta.";
  } catch {
    status.textContent = "Não foi possível verificar o servidor. Tente recarregar a página.";
  }
}
checkServer();

const loginArea = document.getElementById("login-area");
const homeArea = document.getElementById("home-area");
const form = document.getElementById("login-form");
const message = document.getElementById("login-message");
const password = document.getElementById("senha");

function showUser(usuario) {
  const entrando = homeArea.hidden && Boolean(usuario);
  loginArea.hidden = Boolean(usuario);
  homeArea.hidden = !usuario;
  document.getElementById("user-name").textContent = usuario?.nome ?? "";
  document.getElementById("user-role").textContent = usuario?.perfil === "administrador" ? "Administrador" : "Funcionário";
  password.value = "";
  setupProcedures(usuario);
  setupAppointments(usuario);
  setupAgenda(usuario);
  setupNavigation(usuario);
  if (!usuario) clearPatients();
  else if (entrando) loadPatients(1);
}

async function loadUser() {
  try {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    if (response.ok) showUser((await response.json()).usuario);
    else if (response.status === 401) {
      if (!homeArea.hidden) message.textContent = "Sua sessão expirou. Entre novamente.";
      showUser(null);
    } else message.textContent = "Não foi possível verificar sua sessão. Tente novamente.";
  } catch { message.textContent = "Não foi possível conectar ao servidor."; }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = document.getElementById("entrar");
  button.disabled = true;
  message.textContent = "Entrando…";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: document.getElementById("email").value, senha: password.value }),
    });
    const data = await response.json();
    if (response.ok) { showUser(data.usuario); message.textContent = ""; }
    else message.textContent = response.status === 401 ? "E-mail ou senha inválidos. Confira e tente novamente." : data.error ?? "Não foi possível entrar.";
  } catch { message.textContent = "Não foi possível conectar. Tente novamente."; }
  finally { password.value = ""; button.disabled = false; }
});

document.getElementById("sair").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error("Falha ao sair");
    showUser(null);
    message.textContent = "Você saiu da sua conta.";
  } catch { message.textContent = "Não foi possível sair. Tente novamente."; }
});
// Não consulta periodicamente: isso manteria a sessão ativa sem interação humana.
loadUser();
window.addEventListener("focus", loadUser);

const patientForm = document.getElementById("paciente-form");
const patientMessage = document.getElementById("paciente-message");
const listMessage = document.getElementById("lista-message");
const patientList = document.getElementById("pacientes-lista");
const previousPage = document.getElementById("pagina-anterior");
const nextPage = document.getElementById("pagina-proxima");
let currentPage = 1;
let currentSearch = "";
let listVersion = 0;
let sessionVersion = 0;

function clearPatients() {
  sessionVersion++;
  listVersion++;
  patientForm.reset();
  document.getElementById("pesquisa-form").reset();
  patientList.replaceChildren();
  patientMessage.textContent = "";
  listMessage.textContent = "";
  document.getElementById("pagina-atual").textContent = "";
  currentSearch = "";
  currentPage = 1;
  previousPage.disabled = nextPage.disabled = true;
}

function expiredSession(response) {
  if (response.status !== 401) return false;
  showUser(null);
  message.textContent = "Sua sessão expirou. Entre novamente.";
  return true;
}

async function loadPatients(page) {
  const version = ++listVersion;
  previousPage.disabled = nextPage.disabled = true;
  patientList.replaceChildren();
  listMessage.textContent = "Carregando pacientes…";
  try {
    const params = new URLSearchParams({ nome: currentSearch, pagina: String(page) });
    const response = await fetch(`/api/pacientes?${params}`, { cache: "no-store" });
    if (version !== listVersion || homeArea.hidden) return;
    if (expiredSession(response)) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Não foi possível listar os pacientes.");
    for (const paciente of data.pacientes) {
      const row = document.createElement("tr");
      const birth = paciente.data_nascimento ? paciente.data_nascimento.split("-").reverse().join("/") : "—";
      for (const value of [paciente.nome, paciente.telefone, paciente.email ?? "—", birth]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      patientList.append(row);
    }
    currentPage = page;
    document.getElementById("pagina-atual").textContent = `Página ${page}`;
    previousPage.disabled = page === 1;
    nextPage.disabled = !data.temMais;
    listMessage.textContent = data.pacientes.length ? `${data.pacientes.length} paciente(s) nesta página.` : "Nenhum paciente encontrado.";
  } catch (error) {
    if (version === listVersion) listMessage.textContent = error.message || "Não foi possível conectar ao servidor. Tente novamente.";
  }
}

patientForm.addEventListener("submit", async event => {
  event.preventDefault();
  const version = sessionVersion;
  const button = document.getElementById("cadastrar-paciente");
  button.disabled = true;
  patientMessage.textContent = "Cadastrando paciente…";
  try {
    const response = await fetch("/api/pacientes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(patientForm))),
    });
    if (version !== sessionVersion || homeArea.hidden) return;
    if (expiredSession(response)) return;
    const data = await response.json();
    if (!response.ok) { patientMessage.textContent = data.error ?? "Não foi possível cadastrar o paciente."; return; }
    patientForm.reset();
    showEditor("pacientes", false, activeScreen === "pacientes");
    patientMessage.textContent = "Paciente cadastrado com sucesso.";
    currentSearch = "";
    document.getElementById("pesquisa-nome").value = "";
    await loadPatients(1);
  } catch {
    if (version === sessionVersion) patientMessage.textContent = "Não foi possível confirmar o cadastro. Pesquise o paciente antes de tentar novamente.";
  } finally { button.disabled = false; }
});

document.getElementById("pesquisa-form").addEventListener("submit", event => {
  event.preventDefault();
  currentSearch = document.getElementById("pesquisa-nome").value.trim();
  loadPatients(1);
});
previousPage.addEventListener("click", () => loadPatients(currentPage - 1));
nextPage.addEventListener("click", () => loadPatients(currentPage + 1));
