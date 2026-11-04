param(
  [ValidateSet('start', 'stop', 'status')][string]$Action = 'status',
  [string]$Bin = 'C:\Program Files\PostgreSQL\18\bin'
)
$ErrorActionPreference = 'Stop'
$metaWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$metaRoot = [IO.Path]::GetFullPath((Join-Path $metaWorkspace '.local\meta-pg-stage4'))
if (!$metaRoot.StartsWith($metaWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Diretorio de teste fora do workspace.' }
$metaStateFile = Join-Path $metaRoot 'connection.json'
foreach ($metaExe in @('initdb.exe', 'pg_ctl.exe', 'createdb.exe', 'psql.exe')) {
  if (!(Test-Path -LiteralPath (Join-Path $Bin $metaExe))) { throw 'Binarios PostgreSQL locais nao encontrados. Nenhum programa sera instalado.' }
}
if ($Action -ne 'start' -or (Test-Path -LiteralPath $metaStateFile)) {
  if (!(Test-Path -LiteralPath $metaStateFile)) { Write-Output 'Nenhuma instancia de teste criada.'; exit 0 }
  $metaState = Get-Content -Raw -LiteralPath $metaStateFile | ConvertFrom-Json
  $metaData = [IO.Path]::GetFullPath($metaState.dataDirectory)
  if (!$metaData.StartsWith($metaRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cluster fora do diretorio de teste.' }
  if ($Action -eq 'start') {
    & (Join-Path $Bin 'pg_ctl.exe') -D $metaData status | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Output 'Instancia isolada ja esta em execucao.'; exit 0 }
    if ($metaState.host -ne '127.0.0.1' -or $metaState.username -ne 'mara_meta_stage4' -or $metaState.port -lt 1024 -or $metaState.port -gt 65535) { throw 'Configuracao local invalida.' }
    & (Join-Path $Bin 'pg_ctl.exe') -D $metaData -l (Join-Path ([IO.Path]::GetDirectoryName($metaData)) 'postgres.log') -o "-h 127.0.0.1 -p $($metaState.port) -c max_connections=30" -w start
  }
  elseif ($Action -eq 'stop') { & (Join-Path $Bin 'pg_ctl.exe') -D $metaData -m fast -w stop }
  else { & (Join-Path $Bin 'pg_ctl.exe') -D $metaData status }
  exit $LASTEXITCODE
}
if (Test-Path -LiteralPath $metaStateFile) { throw 'Ja existe um registro local. Confira/pare a instancia anterior antes de preparar outra; nenhum dado foi removido.' }
New-Item -ItemType Directory -Path $metaRoot -Force | Out-Null
$metaRun = Join-Path $metaRoot ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $metaRun | Out-Null
$metaData = Join-Path $metaRun 'data'
$metaListener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$metaListener.Start(); $metaPort = $metaListener.LocalEndpoint.Port; $metaListener.Stop()
$metaPassword = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$metaPasswordFile = Join-Path $metaRun 'init-password.txt'
[IO.File]::WriteAllText($metaPasswordFile, $metaPassword, (New-Object Text.UTF8Encoding($false)))
& (Join-Path $Bin 'initdb.exe') -D $metaData -U mara_meta_stage4 --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$metaPasswordFile
if ($LASTEXITCODE -ne 0) { throw 'Falha no initdb isolado.' }
Remove-Item -LiteralPath $metaPasswordFile
& (Join-Path $Bin 'pg_ctl.exe') -D $metaData -l (Join-Path $metaRun 'postgres.log') -o "-h 127.0.0.1 -p $metaPort -c max_connections=30" -w start
if ($LASTEXITCODE -ne 0) { throw 'Falha ao iniciar instancia isolada.' }
$metaDatabase = 'mara_meta_stage4_' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$metaOldPassword = $env:PGPASSWORD
try {
  $env:PGPASSWORD = $metaPassword
  & (Join-Path $Bin 'createdb.exe') -h 127.0.0.1 -p $metaPort -U mara_meta_stage4 $metaDatabase
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar banco exclusivo.' }
} finally { $env:PGPASSWORD = $metaOldPassword }
$metaState = @{ host = '127.0.0.1'; port = $metaPort; database = $metaDatabase; username = 'mara_meta_stage4'; password = $metaPassword; dataDirectory = $metaData; binDirectory = $Bin }
[IO.File]::WriteAllText($metaStateFile, ($metaState | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Output "Instancia isolada pronta: PostgreSQL local, porta $metaPort, banco $metaDatabase. Credenciais apenas no arquivo local ignorado."
