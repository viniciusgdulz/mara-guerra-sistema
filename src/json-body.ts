import { ErroAtendimento } from "./services/atendimentos.service";
export async function lerJsonLimitado(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new ErroAtendimento("Envie os dados em JSON.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new ErroAtendimento("Envie um corpo JSON.");
  const chunks: Uint8Array[] = [];
  let tamanho = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    tamanho += value.length;
    if (tamanho > 4096) { await reader.cancel(); throw new ErroAtendimento("Dados muito grandes.", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new ErroAtendimento("JSON inválido."); }
}
