import { handleRequest } from "./app";

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
