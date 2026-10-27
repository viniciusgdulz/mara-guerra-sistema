import { expect, mock, test } from "bun:test";
import { createContext, runInContext } from "node:vm";

const script = await Bun.file(new URL("../public/js/atendimentos.js", import.meta.url)).text();
class Elemento {
  value = ""; textContent = ""; hidden = false; disabled = false; checked = false;
  children: Elemento[] = [];
  replaceChildren(...children: Elemento[]) { this.children = children; }
  append(...children: Elemento[]) { this.children.push(...children); }
  reset() {}
  addEventListener() {}
  querySelectorAll() { return []; }
}
function interfaceSimulada() {
  const elements = new Map<string, Elemento>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Elemento());
    return elements.get(id)!;
  };
  const pending: Array<(value: Response) => void> = [];
  const fetch = mock(() => new Promise<Response>(resolve => pending.push(resolve)));
  const context = createContext({ document: { getElementById: get, createElement: () => new Elemento() }, fetch, URLSearchParams, Date,
    showUser: () => runInContext("setupAppointments(null)", context) });
  runInContext(script, context);
  return { get, pending, fetch, run: (code: string) => runInContext(code, context) };
}
const concluir = () => new Promise(resolve => setTimeout(resolve, 0));

test("interface de funcionário não carrega nem mostra atendimentos", () => {
  const ui = interfaceSimulada();
  ui.run('setupAppointments({ id: "funcionario", perfil: "funcionario" })');
  expect(ui.get("atendimentos-area").hidden).toBe(true);
  expect(ui.fetch).not.toHaveBeenCalled();
});
test("logout descarta resposta clínica atrasada e limpa histórico", async () => {
  const ui = interfaceSimulada();
  ui.run('setupAppointments({ id: "admin", perfil: "administrador" })');
  ui.get("atendimento-paciente").value = "paciente-teste";
  ui.run("loadApptHistory(1)");
  expect(ui.pending).toHaveLength(3);
  ui.run("setupAppointments(null)");
  ui.pending[2]!(Response.json({ atendimentos: [{ id: "teste", procedimento_nome: "Informação clínica", data_atendimento: "2024-01-01", data_retorno_sugerida: null, procedimento_ativo: false }], temMais: false }));
  await concluir();
  expect(ui.get("atendimentos-area").hidden).toBe(true);
  expect(ui.get("atendimento-historico").children).toHaveLength(0);
});
test("mudança para funcionário descarta seleção pendente de administrador", async () => {
  const ui = interfaceSimulada();
  ui.run('setupAppointments({ id: "admin", perfil: "administrador" })');
  ui.run('setupAppointments({ id: "funcionario", perfil: "funcionario" })');
  ui.pending[0]!(Response.json({ pacientes: [{ id: "paciente", nome: "Teste", telefone: "00000000" }], temMais: false }));
  await concluir();
  expect(ui.get("atendimento-paciente").children).toHaveLength(1);
  expect(ui.get("atendimentos-area").hidden).toBe(true);
});
