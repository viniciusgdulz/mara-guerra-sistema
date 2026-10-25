import { createInterface } from "node:readline/promises";
import type { SQL } from "bun";
import { createConnection } from "../src/db/connection";
import { cadastrarUsuario } from "../src/services/usuarios.service";

export async function criarPrimeiroAdmin(db: SQL, nome: string, email: string, senha: string) {
  let etapa = "transacao";
  try {
    return await db.begin(async tx => {
      // Serializa execuções concorrentes e impede reutilização como cadastro geral.
      await tx`LOCK TABLE usuarios IN SHARE ROW EXCLUSIVE MODE`;
      const rows = await tx`SELECT id FROM usuarios WHERE perfil = 'administrador' LIMIT 1`;
      if (rows.length) throw new Error("Já existe um administrador. Operação cancelada.");
      etapa = "cadastro";
      const usuario = await cadastrarUsuario(tx, { nome, email, senha, perfil: "administrador" });
      etapa = "transacao"; // Inclui a confirmação (COMMIT) realizada por db.begin().
      return usuario;
    });
  } catch (error) {
    const mensagem = error instanceof Error ? error.message : "";
    // Somente mensagens conhecidas da aplicação podem ser apresentadas.
    const permitidas = [
      "Já existe um administrador. Operação cancelada.",
      "Nome deve conter de 1 a 150 caracteres.",
      "E-mail inválido.",
      "Senha deve conter de 15 a 128 caracteres e não pode conter apenas espaços.",
      "E-mail já cadastrado.",
    ];
    if (permitidas.includes(mensagem)) throw new Error(mensagem);
    throw new Error(etapa === "cadastro"
      ? "Falha no cadastro do administrador. Nenhum detalhe interno foi exibido."
      : "Falha na transação do administrador. Verifique o estado do banco antes de tentar novamente.");
  }
}

export function lerSenha(mensagem: string, input = process.stdin, output = process.stdout): Promise<string> {
  return new Promise((resolve, reject) => {
    const anterior = input.isRaw;
    let terminou = false;
    let senha = "";
    function terminar(erro?: string) {
      if (terminou) return;
      terminou = true;
      input.off("data", receber);
      input.off("error", falhou);
      input.off("end", falhou);
      try {
        input.setRawMode(anterior);
        input.pause();
        output.write("\n");
      } catch { erro = "Falha na leitura interativa do terminal."; }
      if (erro) reject(new Error(erro));
      else resolve(senha);
    }
    function falhou() { terminar("Falha na leitura interativa do terminal."); }
    function receber(texto: string) {
      for (const caractere of texto) {
        if (caractere === "\u0003" || caractere === "\u0004") {
          terminar("Operação cancelada no terminal."); return;
        }
        if (caractere === "\r" || caractere === "\n") {
          terminar(); return;
        }
        if (caractere === "\u007f" || caractere === "\b") senha = senha.slice(0, -1);
        else if (caractere >= " " && senha.length < 129) senha += caractere;
      }
    }
    try {
      output.write(mensagem);
      input.setRawMode(true);
      input.setEncoding("utf8");
      input.on("data", receber);
      input.on("error", falhou);
      input.on("end", falhou);
      input.resume();
    } catch { falhou(); }
  });
}

type DadosAdmin = { nome: string; email: string; senha: string; confirmacao: string };

export async function executarCadastro(
  lerDados: () => Promise<DadosAdmin>,
  conectar: () => SQL,
  informar: (mensagem: string) => void,
  informarErro: (mensagem: string) => void,
): Promise<boolean> {
  let db: SQL | undefined;
  let sucesso = false;
  try {
    let dados: DadosAdmin;
    try { dados = await lerDados(); }
    catch (error) {
      informarErro(error instanceof Error && error.message === "Operação cancelada no terminal."
        ? "Operação cancelada no terminal." : "Falha na leitura interativa do terminal.");
      return false;
    }
    if (dados.senha !== dados.confirmacao) {
      informarErro("A senha e a confirmação são diferentes. Administrador não criado.");
      return false;
    }
    try {
      db = conectar();
      await db.connect();
    } catch {
      informarErro("Falha na conexão. Confira DATABASE_URL no .env e o acesso ao PostgreSQL.");
      return false;
    }
    try { await criarPrimeiroAdmin(db, dados.nome, dados.email, dados.senha); }
    catch (error) {
      // criarPrimeiroAdmin já converte todas as falhas em mensagens seguras.
      informarErro((error as Error).message);
      return false;
    }
    sucesso = true;
    informar("Primeiro administrador criado com sucesso.");
    return true;
  } finally {
    if (db) {
      try { await db.close(); }
      catch {
        informarErro(sucesso
          ? "Administrador criado, mas houve falha ao encerrar a conexão. Não repita o cadastro."
          : "Falha ao encerrar a conexão. Verifique o estado do banco antes de tentar novamente.");
      }
    }
  }
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length !== 2) {
    console.error("Execute localmente em um terminal interativo, sem argumentos.");
    process.exitCode = 1;
    return;
  }
  const sucesso = await executarCadastro(async () => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let nome: string;
    let email: string;
    try {
      nome = await terminal.question("Nome: ");
      email = await terminal.question("E-mail: ");
    } finally { terminal.close(); }
    const senha = await lerSenha("Senha (oculta): ");
    const confirmacao = await lerSenha("Repita a senha (oculta): ");
    return { nome, email, senha, confirmacao };
  }, createConnection, mensagem => console.info(mensagem), mensagem => console.error(mensagem));
  if (!sucesso) process.exitCode = 1;
}

if (import.meta.main) await main();
