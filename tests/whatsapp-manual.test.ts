import { describe, expect, mock, test } from "bun:test";
import { CONFIRMACAO_TESTE, executarTesteManual, validarConfigTeste } from "../scripts/whatsapp-manual-test";
import { ErroWhatsAppMeta } from "../src/integrations/whatsapp-meta";

const config = { accessToken: "token-ficticio-teste-manual", testPhoneNumberId: "123456789012345", graphApiVersion: "v23.0",
  authorizedRecipient: "5511999990000", metaTestNumberConfirmed: true, personalRecipientVerifiedAndConsented: true };
const enviar = ["--send", "--authorize-one-test"];
function fixture() {
  const enviarTemplate = mock(async () => ({ messageId: "wamid.manualmente_simulado", status: "aceita" as const }));
  return { enviarTemplate, deps: { interativo: true, confirmar: mock(async () => CONFIRMACAO_TESTE),
    reservar: mock(async () => {}), registrar: mock(async (_r: Record<string, unknown>) => {}),
    criar: mock(() => ({ modo: "real" as const, enviarTemplate })) } };
}
async function recusa(promise: Promise<unknown>) {
  const error = await promise.then(() => null, error => error);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}
describe("Teste manual Meta isolado e autorizado, somente com mocks", () => {
  test.each([{ args: [] }, { args: ["--check"] }])("verificação offline não reserva nem envia: %j", async ({ args }) => {
    const f = fixture(); const result = await executarTesteManual(args, config, f.deps);
    expect(result).toMatchObject({ modo: "verificacao", chamadasExternas: 0, destinatario: "***0000" });
    expect(JSON.stringify(result)).not.toContain(config.accessToken);
    expect(JSON.stringify(result)).not.toContain(config.authorizedRecipient);
    expect(f.deps.confirmar).not.toHaveBeenCalled(); expect(f.deps.reservar).not.toHaveBeenCalled(); expect(f.enviarTemplate).not.toHaveBeenCalled();
  });
  test.each([{ args: ["--send"] }, { args: ["--authorize-one-test"] }, { args: ["--check", "--send"] }, { args: [...enviar, "--force"] }])("recusa argumentos sem autorização inequívoca: %j", async ({ args }) => {
    const f = fixture(); await recusa(executarTesteManual(args, config, f.deps));
    expect(f.deps.criar).not.toHaveBeenCalled(); expect(f.enviarTemplate).not.toHaveBeenCalled();
  });
  test.each([{ ...config, metaTestNumberConfirmed: false }, { ...config, personalRecipientVerifiedAndConsented: false },
    { ...config, accessToken: "SUBSTITUIR_LOCALMENTE" }, { ...config, authorizedRecipient: "+5511999990000" }, { ...config, graphApiVersion: "../v1" },
    { ...config, testPhoneNumberId: "outro/messages" }, null])("recusa configuração inválida ou consentimento ausente %#", async c => {
    const f = fixture(); await recusa(executarTesteManual(enviar, c, f.deps)); expect(f.enviarTemplate).not.toHaveBeenCalled();
  });
  test("sem terminal ou confirmação exata nunca reserva ou envia", async () => {
    for (const interativo of [false, true]) {
      const f = fixture(); f.deps.interativo = interativo; f.deps.confirmar.mockResolvedValue("sim");
      await recusa(executarTesteManual(enviar, config, f.deps));
      expect(f.deps.reservar).not.toHaveBeenCalled(); expect(f.enviarTemplate).not.toHaveBeenCalled();
    }
  });
  test("reserva é obrigatória antes de uma única chamada com template fixo", async () => {
    const f = fixture(); f.enviarTemplate.mockImplementation(async () => {
      expect(f.deps.reservar).toHaveBeenCalledTimes(1);
      return { messageId: "wamid.manualmente_simulado", status: "aceita" };
    });
    const result = await executarTesteManual(enviar, { ...config, nome: "outro_template" }, f.deps);
    expect(result).toMatchObject({ estado: "aceita", messageId: "wamid.manualmente_simulado" });
    expect(f.enviarTemplate).toHaveBeenCalledTimes(1);
    expect(f.enviarTemplate).toHaveBeenCalledWith({ destinatario: config.authorizedRecipient, nome: "hello_world", idioma: "en_US" });
    expect(f.deps.registrar).toHaveBeenCalledWith({ estado: "aceita", messageId: "wamid.manualmente_simulado" });
  });
  test("reserva existente impede qualquer chamada externa", async () => {
    const f = fixture(); f.deps.reservar.mockRejectedValue(new Error("Reserva existente"));
    await recusa(executarTesteManual(enviar, config, f.deps)); expect(f.enviarTemplate).not.toHaveBeenCalled();
  });
  test("timeout e 130497 não fazem retry nem expõem credenciais", async () => {
    for (const erro of [new ErroWhatsAppMeta("timeout", "Tempo limite.", undefined, undefined, undefined, true),
      new ErroWhatsAppMeta("restricao_meta", "Restrição da Meta.", 400, 130497)]) {
      const f = fixture(); f.enviarTemplate.mockRejectedValue(erro);
      const resultado = await recusa(executarTesteManual(enviar, config, f.deps));
      expect(f.enviarTemplate).toHaveBeenCalledTimes(1); expect(f.deps.registrar).toHaveBeenCalledTimes(1);
      expect(resultado.message).toContain("Não repetir automaticamente");
      expect(JSON.stringify(f.deps.registrar.mock.calls)).not.toContain(config.accessToken);
    }
  });
  test("falha de persistência após aceite continua incerta e não repete envio", async () => {
    const f = fixture(); f.deps.registrar.mockRejectedValue(new Error(config.accessToken));
    const erro = await recusa(executarTesteManual(enviar, config, f.deps));
    expect(erro.message).not.toContain(config.accessToken); expect(f.enviarTemplate).toHaveBeenCalledTimes(1);
  });
  test("validação não usa variáveis de produção como fallback", () => {
    expect(() => validarConfigTeste({})).toThrow();
  });
});
