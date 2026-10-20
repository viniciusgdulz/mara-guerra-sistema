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
