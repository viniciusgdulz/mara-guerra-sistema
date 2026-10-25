import { SQL } from "bun";

export function createConnection(): SQL {
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error("Configure DATABASE_URL com uma URL PostgreSQL válida.");
  }

  return new SQL(databaseUrl);
}
