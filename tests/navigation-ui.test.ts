import { expect, mock, test } from "bun:test";
import { createContext, runInContext } from "node:vm";

const html = await Bun.file(new URL("../public/index.html", import.meta.url)).text();
const scripts = await Promise.all(["navigation", "agenda", "procedimentos", "atendimentos", "app"].map(name => Bun.file(new URL(`../public/js/${name}.js`, import.meta.url)).text()));
type Evento = { preventDefault(): void };
class Elemento {
  value = ""; textContent = ""; hidden = false; disabled = false; checked = false; focused = false;
  children: Elemento[] = [];
  attributes = new Map<string, string>();
  events = new Map<string, Array<(event: Evento) => unknown>>();
  fields: Elemento[] = [];
  constructor(public tag = "div") {}
  replaceChildren(...children: Elemento[]) { this.children = children; this.value = ""; }
  append(...children: Elemento[]) { this.children.push(...children); }
  reset() { for (const field of this.fields) { field.value = ""; field.checked = false; } }
  addEventListener(event: string, callback: (event: Evento) => unknown) { this.events.set(event, [...this.events.get(event) ?? [], callback]); }
  async fire(event = "click") { if (this.disabled && event === "click") return; for (const fn of this.events.get(event) ?? []) await fn({ preventDefault() {} }); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  focus() { this.focused = true; }
  querySelectorAll(tag: string): Elemento[] { return this.children.flatMap(c => [...(c.tag === tag ? [c] : []), ...c.querySelectorAll(tag)]); }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function interfaceSimulada(perfil = "administrador") {
  const elements = new Map<string, Elemento>();
  for (const match of html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Elemento(match[1]);
    element.hidden = /\bhidden\b/.test(match[2]!); element.disabled = /\bdisabled\b/.test(match[2]!);
    for (const attribute of match[2]!.matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1]!, attribute[2]!);
    elements.set(match[3]!, element);
  }
  const get = (id: string) => {
    const element = elements.get(id);
    if (!element) throw new Error(`Elemento ausente no HTML: ${id}`);
    return element;
  };
  for (const form of html.matchAll(/<form[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    get(form[1]!).fields = [...form[2]!.matchAll(/<(?:input|select|textarea)[^>]*id="([^"]+)"/g)].map(m => get(m[1]!));
  }
  const paciente = { id: "paciente-teste", nome: "Paciente Teste", telefone: "00000000" };
  const procedimento = { id: "procedimento-teste", nome: "Procedimento Teste", descricao: null, intervalo_retorno_dias: 30, ativo: true };
  let fail = false;
  const fetch = mock(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      if (fail) return Response.json({ error: "Dados inválidos para teste." }, { status: 400 });
      if (path === "/api/pacientes") return Response.json({ paciente }, { status: 201 });
      if (path.startsWith("/api/agenda")) return Response.json({ agendamento: { id: "agenda-teste", data_hora: "2024-01-02T13:00:00Z" } });
      if (path.startsWith("/api/procedimentos")) return Response.json({ procedimento });
      if (path.startsWith("/api/atendimentos")) return Response.json({ atendimento: { data_retorno_sugerida: "2024-02-01" } });
      return new Response(null, { status: 204 });
    }
    if (path === "/api/health") return Response.json({ status: "ok" });
    if (path === "/api/auth/me") return Response.json({ usuario: { id: "usuario", nome: "Equipe Teste", perfil } });
    if (path.startsWith("/api/pacientes")) return Response.json({ pacientes: [paciente], temMais: false });
    if (path.startsWith("/api/agenda/procedimentos")) return Response.json({ procedimentos: [procedimento], temMais: false });
    if (path.startsWith("/api/agenda/retornos")) return Response.json({ retornos: [{ sugestao_id: "sugestao-teste", paciente_id: paciente.id, procedimento_id: procedimento.id, paciente_nome: paciente.nome, procedimento_nome: procedimento.nome, procedimento_ativo: true, data_retorno_sugerida: "2024-01-02" }], temMais: false });
    if (path.startsWith("/api/agenda")) return Response.json({ agendamentos: [{ id: "agenda-teste", paciente_id: paciente.id, procedimento_id: procedimento.id, paciente_nome: paciente.nome, paciente_telefone: paciente.telefone, procedimento_nome: procedimento.nome, data_hora: "2024-01-02T13:00:00Z", status: "pendente" }], temMais: false });
    if (path.startsWith("/api/procedimentos") || path.startsWith("/api/atendimentos/procedimentos")) return Response.json({ procedimentos: [procedimento], temMais: false });
    return Response.json({ atendimentos: [], temMais: false });
  });
  const context = createContext({ document: { getElementById: get, createElement: (tag: string) => new Elemento(tag) }, window: { addEventListener() {} }, fetch, URLSearchParams, Date,
    FormData: class { constructor(public form: Elemento) {} *[Symbol.iterator]() { for (const field of this.form.fields) { const name = field.attributes.get("name"); if (name) yield [name, field.value]; } } },
    confirm: () => true, prompt: () => null });
  for (const script of scripts) runInContext(script, context);
  await settle();
  return { get, fetch, run: (code: string) => runInContext(code, context), fail: () => { fail = true; } };
}
function telaVisivel(ui: Awaited<ReturnType<typeof interfaceSimulada>>, selected: string) {
  for (const name of ["inicio", "agenda", "pacientes", "procedimentos", "atendimentos"]) expect(ui.get(`${name}-area`).hidden).toBe(name !== selected);
  expect(ui.get(`nav-${selected}`).attributes.get("aria-current")).toBe("page");
}

test("login abre somente Início e navegação não faz novas requisições", async () => {
  const ui = await interfaceSimulada();
  telaVisivel(ui, "inicio"); expect(ui.get("user-name").textContent).toBe("Equipe Teste");
  const calls = ui.fetch.mock.calls.length;
  for (const name of ["pacientes", "procedimentos", "atendimentos", "inicio"]) {
    await ui.get(`nav-${name}`).fire(); telaVisivel(ui, name);
    expect(ui.get(name === "inicio" ? "home-title" : `${name}-title`).focused).toBe(true);
  }
  expect(ui.fetch.mock.calls).toHaveLength(calls);
});
test("pacientes abre consulta; atalho e botão abrem cadastro, cancelar limpa e volta", async () => {
  const ui = await interfaceSimulada();
  await ui.get("atalho-consultar-pacientes").fire();
  telaVisivel(ui, "pacientes"); expect(ui.get("paciente-editor").hidden).toBe(true);
  await ui.get("novo-paciente").fire();
  expect(ui.get("paciente-editor").hidden).toBe(false); expect(ui.get("pacientes-consulta").hidden).toBe(true);
  ui.get("paciente-nome").value = "Rascunho";
  await ui.get("cancelar-paciente").fire();
  expect(ui.get("paciente-nome").value).toBe(""); expect(ui.get("pacientes-consulta").hidden).toBe(false);
  await ui.get("nav-inicio").fire(); await ui.get("atalho-novo-paciente").fire();
  telaVisivel(ui, "pacientes"); expect(ui.get("paciente-editor").hidden).toBe(false);
});
test("cadastro de paciente retorna à listagem atualizada e preserva confirmação", async () => {
  const ui = await interfaceSimulada();
  await ui.get("atalho-novo-paciente").fire();
  ui.get("paciente-nome").value = "Teste"; ui.get("paciente-telefone").value = "00000000";
  await ui.get("paciente-form").fire("submit");
  expect(ui.get("paciente-editor").hidden).toBe(true); expect(ui.get("pacientes-consulta").hidden).toBe(false);
  expect(ui.get("paciente-message").textContent).toContain("sucesso"); expect(ui.get("pacientes-lista").children).toHaveLength(1);
});
test("erro de cadastro mantém formulário e mensagem visíveis", async () => {
  const ui = await interfaceSimulada(); ui.fail();
  await ui.get("atalho-novo-paciente").fire(); await ui.get("paciente-form").fire("submit");
  expect(ui.get("paciente-editor").hidden).toBe(false); expect(ui.get("paciente-message").textContent).toContain("inválidos");
});
test("procedimentos inicia em consulta e editor cancela ou salva voltando ao catálogo", async () => {
  const ui = await interfaceSimulada();
  await ui.get("nav-procedimentos").fire(); expect(ui.get("procedimento-editor").hidden).toBe(true);
  await ui.get("novo-procedimento").fire(); expect(ui.get("procedimento-editor").hidden).toBe(false);
  await ui.get("cancelar-procedimento").fire(); expect(ui.get("procedimento-editor").hidden).toBe(true);
  const edit = ui.get("procedimentos-lista").children[0]!.children[4]!.children[0]!;
  await edit.fire(); expect(ui.get("procedimento-nome").value).toBe("Procedimento Teste");
  expect(ui.get("procedimentos-consulta").hidden).toBe(true);
  await ui.get("procedimento-form").fire("submit");
  expect(ui.get("procedimento-editor").hidden).toBe(true); expect(ui.get("procedimento-message").textContent).toContain("atualizado");
});
test("atendimentos abre consulta; voltar preserva paciente e histórico, sucesso fecha registro", async () => {
  const ui = await interfaceSimulada();
  await ui.get("nav-atendimentos").fire(); expect(ui.get("atendimento-editor").hidden).toBe(true);
  ui.get("atendimento-paciente").value = "paciente-teste"; await ui.get("atendimento-paciente").fire("change"); await settle();
  await ui.get("novo-atendimento").fire(); expect(ui.get("atendimentos-consulta").hidden).toBe(true);
  await ui.get("cancelar-atendimento").fire(); expect(ui.get("atendimentos-consulta").hidden).toBe(false);
  expect(ui.get("atendimento-paciente").value).toBe("paciente-teste");
  await ui.get("novo-atendimento").fire(); ui.get("atendimento-procedimento").value = "procedimento-teste"; ui.get("atendimento-data").value = "2024-01-02";
  await ui.get("atendimento-form").fire("submit");
  await settle();
  expect(ui.get("atendimento-editor").hidden).toBe(true); expect(ui.get("atendimento-message").textContent).toContain("sucesso"); telaVisivel(ui, "atendimentos");
});
test("funcionário só consulta procedimentos e não abre Atendimentos nem por chamada direta", async () => {
  const ui = await interfaceSimulada("funcionario");
  expect(ui.get("nav-atendimentos").hidden).toBe(true); expect(ui.get("atalho-atendimento").hidden).toBe(true);
  ui.run('showScreen("atendimentos"); showEditor("atendimentos", true)'); telaVisivel(ui, "inicio");
  await ui.get("nav-procedimentos").fire(); expect(ui.get("novo-procedimento").hidden).toBe(true);
  ui.run('showEditor("procedimentos", true)'); expect(ui.get("procedimento-editor").hidden).toBe(true);
  expect(ui.get("procedimentos-lista").children[0]!.children).toHaveLength(4);
});
test("revalidação de sessão mantém tela e editor sem exibir atendimentos", async () => {
  const ui = await interfaceSimulada(); await ui.get("nav-procedimentos").fire(); await ui.get("novo-procedimento").fire();
  await ui.run("loadUser()"); telaVisivel(ui, "procedimentos"); expect(ui.get("procedimento-editor").hidden).toBe(false);
});
test("trocar tela fecha editores, logout limpa navegação e novo login abre Início", async () => {
  const ui = await interfaceSimulada(); await ui.get("atalho-novo-paciente").fire(); await ui.get("nav-procedimentos").fire();
  expect(ui.get("paciente-editor").hidden).toBe(true);
  await ui.get("sair").fire(); expect(ui.get("home-area").hidden).toBe(true); expect(ui.get("atendimentos-area").hidden).toBe(true);
  await ui.run("loadUser()"); telaVisivel(ui, "inicio"); expect(ui.get("paciente-editor").hidden).toBe(true);
});

test("Agenda carrega sob demanda, navega por dia e funcionário cria sem consultar retornos", async () => {
  const ui = await interfaceSimulada("funcionario");
  expect(ui.fetch.mock.calls.some(([url]) => url.startsWith("/api/agenda"))).toBe(false);
  await ui.get("nav-agenda").fire(); await settle(); telaVisivel(ui, "agenda");
  expect(ui.get("agenda-retornos-area").hidden).toBe(true);
  const dia = ui.get("agenda-dia").value;
  await ui.get("agenda-dia-proximo").fire(); await settle(); expect(ui.get("agenda-dia").value).not.toBe(dia);
  await ui.get("agenda-dia-anterior").fire(); await settle(); expect(ui.get("agenda-dia").value).toBe(dia);
  await ui.get("novo-agendamento").fire(); await settle();
  expect(ui.get("agenda-editor").hidden).toBe(false); expect(ui.get("agenda-consulta").hidden).toBe(true);
  ui.get("agenda-paciente").value = "paciente-teste"; ui.get("agenda-procedimento").value = "procedimento-teste";
  ui.get("agenda-data").value = "2024-01-02"; ui.get("agenda-hora").value = "10:00";
  await ui.get("agenda-form").fire("submit"); await settle();
  expect(ui.get("agenda-editor").hidden).toBe(true); expect(ui.get("agenda-message").textContent).toContain("sucesso");
  expect(ui.fetch.mock.calls.some(([url]) => url.startsWith("/api/agenda/retornos"))).toBe(false);
  expect(ui.get("agenda-lista").children[0]!.children[5]!.children).toHaveLength(2);
});
test("retorno exige consulta e envio explícito do administrador", async () => {
  const ui = await interfaceSimulada(); await ui.get("nav-agenda").fire(); await settle();
  expect(ui.get("agenda-retornos-area").hidden).toBe(false);
  await ui.get("agenda-retornos-filtros").fire("submit"); await settle();
  const antes = ui.fetch.mock.calls.filter(([, init]) => init?.method === "POST").length;
  await ui.get("agenda-retornos-lista").children[0]!.children[3]!.children[0]!.fire();
  expect(ui.get("agenda-editor").hidden).toBe(false); expect(ui.get("agenda-data").value).toBe("2024-01-02");
  expect(ui.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(antes);
  ui.get("agenda-hora").value = "10:00"; await ui.get("agenda-form").fire("submit"); await settle();
  expect(ui.fetch.mock.calls.some(([url, init]) => url === "/api/agenda/retornos/sugestao-teste/agendar" && init?.method === "POST")).toBe(true);
  expect(ui.get("agenda-editor").hidden).toBe(true);
});
test("Agenda mantém formulário no erro e cancelamento da edição não grava", async () => {
  const ui = await interfaceSimulada(); await ui.get("nav-agenda").fire(); await settle();
  await ui.get("novo-agendamento").fire(); await settle(); ui.fail();
  await ui.get("agenda-form").fire("submit"); await settle();
  expect(ui.get("agenda-editor").hidden).toBe(false); expect(ui.get("agenda-message").textContent).toContain("inválidos");
  const calls = ui.fetch.mock.calls.length; await ui.get("agenda-cancelar-edicao").fire();
  expect(ui.get("agenda-editor").hidden).toBe(true); expect(ui.fetch.mock.calls).toHaveLength(calls);
});

test("retorno atrasado é descartado ao mudar de administrador para funcionário", async () => {
  const ui = await interfaceSimulada();
  ui.run('fetch = () => new Promise(resolve => { globalThis.resolverRetorno = resolve; }); loadAgendaReturns(1);');
  ui.run('setupAgenda({ id: "outro-usuario", perfil: "funcionario" });');
  ui.run('resolverRetorno({ status: 200, ok: true, json: async () => ({ retornos: [{ sugestao_id: "interno", paciente_nome: "Paciente Teste", procedimento_nome: "Teste", procedimento_ativo: true, data_retorno_sugerida: "2024-01-02" }], temMais: false }) });');
  await settle();
  expect(ui.get("agenda-retornos-area").hidden).toBe(true);
  expect(ui.get("agenda-retornos-lista").children).toHaveLength(0);
});
