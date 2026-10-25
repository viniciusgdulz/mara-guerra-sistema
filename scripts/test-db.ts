import { createConnection } from "../src/db/connection";

async function testDatabase(): Promise<void> {
  const db = createConnection();
  try {
    const rows = await db`SELECT 1 AS resultado`;
    if (rows[0]?.resultado !== 1) {
      throw new Error("Resultado inesperado na consulta de teste.");
    }
  } finally {
    await db.close();
  }
}

try {
  await testDatabase();
  console.info("Conexão com PostgreSQL realizada com sucesso. Resultado: 1.");
} catch {
  console.error("Não foi possível testar a conexão. Verifique DATABASE_URL e o acesso ao PostgreSQL.");
  process.exitCode = 1;
}
