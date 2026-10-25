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

PostgreSQL no Neon é acessado pelo cliente SQL nativo do Bun em `src/db/connection.ts`.
Os arquivos SQL versionados são revisados e executados separadamente; o servidor não aplica migrações automaticamente.

A autenticação utiliza Argon2id nativo via `Bun.password`, selecionando explicitamente o algoritmo `argon2id`, sem biblioteca de hash adicional.

Não há cadastro de pacientes, integração com WhatsApp nem dados reais de pacientes.

## Autenticação e execução local

As tabelas de autenticação estão definidas em `sql/002_create_auth_tables.sql`.
O servidor não executa SQL de criação nem cadastra usuários ao iniciar.
Configure `DATABASE_URL` no `.env` da raiz, mantenha esse arquivo fora do Git e execute:

```powershell
bun run dev
```

Abra http://127.0.0.1:3000. A página permite entrar, consultar nome/perfil e sair.
Para testar o login bem-sucedido é necessária uma conta previamente criada de forma autorizada.
Nenhuma conta é fornecida por padrão. Sem conta, é possível revisar a tela e suas mensagens;
os testes automatizados verificam o fluxo completo com SQL simulado, sem acessar o Neon.

O comando abaixo é uma operação separada que **grava no banco configurado**.
Execute-o somente quando autorizar a criação real do primeiro administrador:

```powershell
bun run admin:create
```

O script exige um terminal interativo, solicita nome/e-mail e senha com confirmação oculta,
não aceita argumentos e recusa a criação se já houver administrador, inclusive inativo.
Usa o serviço de cadastro existente e uma transação com bloqueio contra execuções concorrentes.
Não há cadastro público. Não coloque senhas em comandos, arquivos ou logs.

### Rotas e proteção

- `POST /api/auth/login`: verifica senha e usuário ativo e cria a sessão.
- `POST /api/auth/logout`: remove a sessão e limpa o cookie.
- `GET /api/auth/me`: verifica a sessão e retorna somente id, nome, e-mail e perfil.
- `/api/admin` e seus subcaminhos: exigem sessão e perfil administrador;
  retornam 404 após autorização, pois ainda não existem funcionalidades administrativas.
- `/api/health` e os arquivos públicos do login continuam acessíveis sem sessão.

Controllers futuros devem verificar sessão e `temPerfil()` antes de consultar dados de negócio.
`temPerfil(usuario, ["administrador"])` permite somente administradores;
`temPerfil(usuario, ["administrador", "funcionario"])` permite os dois perfis.
O catálogo atual não disponibiliza nenhuma rota de pacientes ou histórico clínico.

Senhas usam Argon2id. Tokens aleatórios de 32 bytes ficam somente no cookie HttpOnly,
SameSite=Strict; o banco armazena seu SHA-256. Não se usa localStorage.
O servidor verifica usuário ativo, expiração absoluta de 8 horas e inatividade de 30 minutos
ao validar a sessão. A sessão não é renovada por consultas periódicas da interface.
Logout exclui a sessão; um novo login substitui a sessão enviada pelo mesmo navegador.
Sessões expiradas não autorizam acesso, mesmo que seus registros ainda existam no banco.

Login e logout exigem o cabeçalho Origin correspondente à aplicação; login exige JSON,
com limite de 4 KiB. Há limite de 5 tentativas por e-mail em 15 minutos e 60 tentativas
globais por minuto. O limitador fica em memória, reinicia com o processo e é adequado
a uma instância; antes de usar várias instâncias, será necessário compartilhar esses limites.

### Produção

Configure `NODE_ENV=production` e `APP_ORIGIN` com a origem HTTPS pública exata,
por exemplo `https://clinica.example`, sem barra final. Use HTTPS no acesso público
(diretamente ou no proxy da hospedagem). A origem é configurada explicitamente;
o servidor não confia em cabeçalhos encaminhados para decidir a origem autorizada.
Em produção o cookie usa `Secure` e o prefixo `__Host-`, sem atributo Domain.
Em desenvolvimento HTTP local, o cookie não usa Secure. Não use esse modo em produção.

Os testes de autenticação e primeiro administrador usam clientes SQL simulados e hashes
locais do Bun. Eles não criam contas nem sessões no Neon. Execute `bun test` e
`bun run typecheck` para verificar o projeto.

Referências oficiais: [servidor HTTP do Bun](https://bun.sh/docs/runtime/http/server) e [Bun.password](https://bun.sh/reference/bun/password).
