const screens = {
  inicio: { area: "inicio-area", title: "home-title" },
  agenda: { area: "agenda-area", title: "agenda-title", editor: "agenda-editor", list: "agenda-consulta", button: "novo-agendamento", input: "agenda-paciente" },
  pacientes: { area: "pacientes-area", title: "pacientes-title", editor: "paciente-editor", list: "pacientes-consulta", button: "novo-paciente", input: "paciente-nome" },
  procedimentos: { area: "procedimentos-area", title: "procedimentos-title", editor: "procedimento-editor", list: "procedimentos-consulta", button: "novo-procedimento", input: "procedimento-nome" },
  atendimentos: { area: "atendimentos-area", title: "atendimentos-title", editor: "atendimento-editor", list: "atendimentos-consulta", button: "novo-atendimento", input: "atendimento-procedimento" },
};
let navigationUser = null;
let activeScreen = "inicio";
const navElement = id => document.getElementById(id);

function showEditor(screen, open, focus = true) {
  const config = screens[screen];
  if (!config?.editor) return;
  if (open && (!navigationUser || (!["pacientes", "agenda"].includes(screen) && navigationUser.perfil !== "administrador"))) return;
  navElement(config.editor).hidden = !open;
  navElement(config.list).hidden = open;
  const allowed = ["pacientes", "agenda"].includes(screen) || navigationUser?.perfil === "administrador";
  navElement(config.button).hidden = open || !allowed;
  navElement(config.button).setAttribute("aria-expanded", String(open));
  if (focus && activeScreen === screen) navElement(open ? config.input : config.title).focus();
}
function showScreen(screen, focus = true) {
  if (!navigationUser || !screens[screen] || (screen === "atendimentos" && navigationUser.perfil !== "administrador")) return;
  activeScreen = screen;
  for (const [name, config] of Object.entries(screens)) {
    navElement(config.area).hidden = name !== screen;
    const button = navElement(`nav-${name}`);
    if (name === screen) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
    showEditor(name, false, false);
  }
  if (focus) navElement(screens[screen].title).focus();
  if (screen === "agenda") openAgenda();
}
function setupNavigation(usuario) {
  const changed = navigationUser?.id !== usuario?.id || navigationUser?.perfil !== usuario?.perfil;
  navigationUser = usuario;
  const admin = usuario?.perfil === "administrador";
  navElement("nav-atendimentos").hidden = !admin;
  navElement("atalho-atendimento").hidden = !admin;
  navElement("novo-procedimento").hidden = !admin || !navElement("procedimento-editor").hidden;
  if (!usuario) {
    activeScreen = "inicio";
    for (const [name, config] of Object.entries(screens)) {
      navElement(config.area).hidden = true;
      showEditor(name, false, false);
      navElement(`nav-${name}`).removeAttribute("aria-current");
    }
  } else if (changed) showScreen("inicio", false);
}
for (const name of Object.keys(screens)) navElement(`nav-${name}`).addEventListener("click", () => showScreen(name));
navElement("novo-paciente").addEventListener("click", () => {
  navElement("paciente-message").textContent = "";
  showEditor("pacientes", true);
});
navElement("cancelar-paciente").addEventListener("click", () => {
  navElement("paciente-form").reset();
  navElement("paciente-message").textContent = "Cadastro cancelado.";
  showEditor("pacientes", false);
});
navElement("novo-procedimento").addEventListener("click", () => {
  resetProcedureEditor();
  navElement("procedimento-message").textContent = "";
  showEditor("procedimentos", true);
});
navElement("novo-atendimento").addEventListener("click", () => showEditor("atendimentos", true));
navElement("cancelar-atendimento").addEventListener("click", () => showEditor("atendimentos", false));
navElement("atalho-novo-paciente").addEventListener("click", () => {
  showScreen("pacientes", false);
  navElement("paciente-message").textContent = "";
  showEditor("pacientes", true);
});
navElement("atalho-consultar-pacientes").addEventListener("click", () => showScreen("pacientes"));
navElement("atalho-atendimento").addEventListener("click", () => {
  showScreen("atendimentos", false);
  showEditor("atendimentos", true);
});
