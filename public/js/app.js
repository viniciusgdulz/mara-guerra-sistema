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
  loginArea.hidden = Boolean(usuario);
  homeArea.hidden = !usuario;
  document.getElementById("user-name").textContent = usuario?.nome ?? "";
  document.getElementById("user-role").textContent = usuario?.perfil === "administrador" ? "Administrador" : "Funcionário";
  password.value = "";
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
