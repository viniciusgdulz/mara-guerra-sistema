import type { Perfil } from "./services/usuarios.service";
import type { UsuarioAutenticado } from "./services/auth.service";
import { hashToken } from "./services/auth.service";

export function temPerfil(usuario: UsuarioAutenticado, permitidos: readonly Perfil[]): boolean {
  return permitidos.includes(usuario.perfil);
}

export function lerToken(request: Request, producao: boolean): string | null {
  const nome = producao ? "__Host-sessao" : "sessao";
  const token = request.headers.get("cookie")?.split(";")
    .map(parte => parte.trim()).find(parte => parte.startsWith(`${nome}=`))?.slice(nome.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export function cookieSessao(token: string, producao: boolean, limpar = false): string {
  return `${producao ? "__Host-sessao" : "sessao"}=${limpar ? "" : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${limpar ? 0 : 28800}${producao ? "; Secure" : ""}`;
}

export function origemPermitida(request: Request, origem: string | undefined, producao: boolean): boolean {
  if (producao && (!origem || !origem.startsWith("https://"))) return false;
  return request.headers.get("origin") === (origem ?? new URL(request.url).origin);
}

// Limites por conta e global, adequados ao servidor único desta etapa.
export function criarLimitador() {
  const contas = new Map<string, { inicio: number; tentativas: number }>();
  let janela = Date.now();
  let total = 0;
  return (email: string): boolean => {
    const agora = Date.now();
    if (agora - janela >= 60000) { janela = agora; total = 0; }
    if (++total > 60) return false;
    for (const [chave, conta] of contas) {
      if (agora - conta.inicio >= 15 * 60000) contas.delete(chave);
    }
    const chave = hashToken(email);
    const conta = contas.get(chave) ?? { inicio: agora, tentativas: 0 };
    if (!contas.has(chave) && contas.size >= 10000) return false;
    contas.set(chave, conta);
    return ++conta.tentativas <= 5;
  };
}
