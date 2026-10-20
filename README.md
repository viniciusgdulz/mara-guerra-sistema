# Sistema Mara Guerra Estética Avançada

Projeto de extensão universitária. Monólito simples com backend TypeScript e frontend HTML, CSS e JavaScript puro, servidos pelo mesmo processo HTTP.

## Execução local

Requisito: **Bun 1.3.14**, indicado em `.bun-version`, `packageManager` e `engines`.

```powershell
bun --version
bun install
Copy-Item .env.example .env
bun run dev
```

Abra http://127.0.0.1:3000. O Bun carrega `.env` automaticamente. A cópia é opcional se os valores padrão forem suficientes; `HOST` e `PORT` configuram o endereço local.

Para iniciar sem observar alterações, use `bun start`.

## Arquivos

- `src/app.ts`: rotas HTTP e lista explícita dos arquivos públicos permitidos.
- `src/server.ts`: validação de porta e inicialização com `Bun.serve()`.
- `public/index.html`: página inicial em português.
- `public/css/styles.css`: estilos responsivos.
- `public/js/app.js`: consulta ao status do servidor.
- `tests/server.test.ts`: testes HTTP com o executor nativo do Bun e porta temporária.
- `package.json`: scripts e dependências apenas de desenvolvimento.
- `bun.lock`: versões resolvidas das dependências.
- `tsconfig.json`: TypeScript estrito, sem emissão de arquivos.
- `.gitignore`: exclui dependências, segredos locais e arquivos gerados.
- `.env.example`: configuração local e exemplo comentado para PostgreSQL futuro.
- `.bun-version`: versão esperada do runtime.

Novos arquivos públicos devem ser registrados em `src/app.ts`.

## Rotas e verificações

- `GET /` e `GET /index.html`: página inicial.
- `GET /css/styles.css` e `GET /js/app.js`: arquivos estáticos.
- `GET /api/health`: `{"status":"ok","message":"Servidor funcionando"}`.

As rotas também aceitam `HEAD`. Caminhos desconhecidos retornam 404 e métodos não suportados retornam 405.

```powershell
bun test
bun run typecheck
```

Os testes verificam saúde, HTML, CSS, JavaScript, respostas 404/405 e HEAD através de um servidor HTTP real.

## Futuras implementações

PostgreSQL será o banco de dados futuro. `DATABASE_URL` está apenas documentada com valores fictícios, sem conexão, driver, tabelas ou migrações nesta etapa.

A autenticação futura utilizará Argon2id nativo via `Bun.password`, selecionando explicitamente o algoritmo `argon2id`. Nenhuma autenticação ou biblioteca de hash foi adicionada.

Não há cadastro de pacientes, integração com WhatsApp nem dados reais de pacientes.

Referências oficiais: [servidor HTTP do Bun](https://bun.sh/docs/runtime/http/server) e [Bun.password](https://bun.sh/reference/bun/password).
