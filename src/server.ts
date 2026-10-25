import { closeConnection, handleRequest } from "./app";

if (Bun.env.NODE_ENV === "production") {
  const origin = Bun.env.APP_ORIGIN;
  if (!origin || !origin.startsWith("https://") || new URL(origin).origin !== origin) {
    throw new Error("Configure APP_ORIGIN com a origem HTTPS da aplicação, sem barra final.");
  }
}

const port = Number(Bun.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT deve ser um número inteiro entre 1 e 65535.");
}

const server = Bun.serve({
  hostname: Bun.env.HOST ?? "127.0.0.1",
  port,
  fetch: handleRequest,
});
console.info(`Mara Guerra — servidor disponível em ${server.url}`);

let encerrando = false;
async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  await server.stop();
  await closeConnection();
}
process.on("SIGINT", encerrar);
process.on("SIGTERM", encerrar);
