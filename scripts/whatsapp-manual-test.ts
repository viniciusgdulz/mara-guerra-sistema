import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { criarProvedorMeta, ErroWhatsAppMeta, type ProvedorMeta } from "../src/integrations/whatsapp-meta";

export const CONFIRMACAO_TESTE = "AUTORIZO UM ENVIO DE TESTE";
export type ConfigTeste = {
  accessToken: string; testPhoneNumberId: string; graphApiVersion: string;
  authorizedRecipient: string; metaTestNumberConfirmed: boolean;
  personalRecipientVerifiedAndConsented: boolean;
};
type Dependencias = {
  interativo: boolean;
  confirmar: () => Promise<string>;
  reservar: () => Promise<void>;
  registrar: (resultado: Record<string, unknown>) => Promise<void>;
  criar: typeof criarProvedorMeta;
};
export function validarConfigTeste(valor: unknown): ConfigTeste {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) throw new Error("Configuração de teste inválida.");
  const c = valor as ConfigTeste;
  if (typeof c.accessToken !== "string" || !c.accessToken || c.accessToken.startsWith("SUBSTITUIR") || /\s/.test(c.accessToken)
    || typeof c.testPhoneNumberId !== "string" || !/^\d{1,30}$/.test(c.testPhoneNumberId)
    || typeof c.graphApiVersion !== "string" || !/^v[1-9]\d*\.\d+$/.test(c.graphApiVersion)
    || typeof c.authorizedRecipient !== "string" || !/^[1-9]\d{7,14}$/.test(c.authorizedRecipient)) {
    throw new Error("Preencha accessToken, testPhoneNumberId, graphApiVersion e authorizedRecipient no arquivo local de teste.");
  }
  if (c.metaTestNumberConfirmed !== true || c.personalRecipientVerifiedAndConsented !== true) {
    throw new Error("Confirme no painel o remetente de teste da Meta e seu destinatário pessoal verificado e autorizado antes de marcar as duas confirmações como true.");
  }
  return { ...c };
}

// Não importa app, repositórios ou conexão SQL. Não é chamado por rotas ou tarefas.
export async function executarTesteManual(args: readonly string[], valor: unknown, deps: Dependencias) {
  const verificar = args.length === 0 || (args.length === 1 && args[0] === "--check");
  const enviar = args.length === 2 && args[0] === "--send" && args[1] === "--authorize-one-test";
  if (!verificar && !enviar) throw new Error("Use --check ou, após autorização, --send --authorize-one-test.");
  const c = validarConfigTeste(valor);
  // Construir o cliente valida a configuração e não faz requisições.
  const provedor: ProvedorMeta = deps.criar({ token: c.accessToken, phoneNumberId: c.testPhoneNumberId,
    graphApiVersion: c.graphApiVersion, timeoutMs: 10000 });
  if (verificar) return { modo: "verificacao", destinatario: `***${c.authorizedRecipient.slice(-4)}`,
    template: "hello_world", idioma: "en_US", chamadasExternas: 0 };
  if (!deps.interativo || await deps.confirmar() !== CONFIRMACAO_TESTE) throw new Error("Envio não autorizado. Nenhuma chamada realizada.");
  // Reserva exclusiva em disco antes de qualquer HTTP, inclusive entre processos.
  // Nunca liberar automaticamente: timeout ou falha local podem esconder um aceite.
  await deps.reservar();
  try {
    const resposta = await provedor.enviarTemplate({ destinatario: c.authorizedRecipient, nome: "hello_world", idioma: "en_US" });
    await deps.registrar({ estado: "aceita", messageId: resposta.messageId });
    return { modo: "envio_manual", estado: "aceita", messageId: resposta.messageId,
      aviso: "Aceitação não confirma entrega. Confira seu WhatsApp. Não repetir automaticamente." };
  } catch (erro) {
    const meta = erro instanceof ErroWhatsAppMeta ? erro : null;
    // Se a gravação após o aceite falhar, a reserva continua existindo.
    try { await deps.registrar({ estado: "falha_ou_incerto", categoria: meta?.categoria ?? "persistencia_local",
      codigoMeta: meta?.codigoMeta, resultadoIncerto: meta?.resultadoIncerto ?? true }); } catch { /* preservar reserva */ }
    throw new Error(meta ? `${meta.message}${meta.codigoMeta === undefined ? "" : ` Código: ${meta.codigoMeta}.`} Não repetir automaticamente.`
      : "Resultado não confirmado. A reserva local foi preservada. Não repetir automaticamente.");
  }
}

async function main() {
  const pasta = resolve(import.meta.dir, "../.local/whatsapp-manual");
  try {
    let config: unknown;
    try { config = await Bun.file(resolve(pasta, "config.json")).json(); }
    catch { throw new Error("Crie .local/whatsapp-manual/config.json a partir de whatsapp-test.config.example.json. Não use o .env de produção."); }
    const reserva = resolve(pasta, "attempt.json");
    const resultado = await executarTesteManual(Bun.argv.slice(2), config, {
      criar: criarProvedorMeta,
      interativo: process.stdin.isTTY === true && process.stdout.isTTY === true,
      confirmar: async () => {
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        try { return await terminal.question(`Um envio de hello_world/en_US ao destinatário pessoal configurado. Digite ${CONFIRMACAO_TESTE}: `); }
        finally { terminal.close(); }
      },
      reservar: async () => {
        await mkdir(pasta, { recursive: true });
        let arquivo;
        try { arquivo = await open(reserva, "wx", 0o600); }
        catch { throw new Error("Reserva local já existe ou não pôde ser criada. Nenhum envio realizado. Revise a tentativa anterior; não remova a reserva para repetir sem nova autorização."); }
        try { await arquivo.writeFile(JSON.stringify({ estado: "reservado", instante: new Date().toISOString() })); }
        finally { await arquivo.close(); }
      },
      registrar: async resultado => { await Bun.write(reserva, JSON.stringify({ ...resultado, instante: new Date().toISOString() }, null, 2)); },
    });
    console.info(JSON.stringify(resultado, null, 2));
  } catch (erro) {
    // Somente mensagens locais fixas/erros sanitizados; nunca JSON, token ou stack.
    console.error(erro instanceof Error ? erro.message : "Teste manual interrompido.");
    process.exitCode = 1;
  }
}
if (import.meta.main) await main();
