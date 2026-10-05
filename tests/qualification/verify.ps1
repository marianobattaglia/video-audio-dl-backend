param([string]$DockerPath = '')
$ErrorActionPreference = 'Stop'
if (-not $DockerPath) {
    $command = Get-Command docker -ErrorAction SilentlyContinue
    if ($command) { $DockerPath = $command.Source }
    else { $DockerPath = Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe' }
}
if (-not (Test-Path -LiteralPath $DockerPath)) { throw 'Docker Desktop debe estar instalado y en ejecución.' }
Push-Location (Join-Path $PSScriptRoot '../..')
try {
    & $DockerPath build -t video-audio-dl-backend:local-qualification .
    if ($LASTEXITCODE -ne 0) { throw 'Falló la construcción de la imagen de prueba.' }
    & $DockerPath compose -p video-audio-dl-qualification -f tests/qualification/compose.yaml up --abort-on-container-exit --exit-code-from verification
    $suiteExit = $LASTEXITCODE
    $ErrorActionPreference = 'Continue'
    $lines = & $DockerPath logs video-audio-dl-qualification-verification-1 2>&1
    $ErrorActionPreference = 'Stop'
    $summaryLine = $lines | Where-Object { "$_" -like '{"summary":*' } | Select-Object -Last 1
    if (-not $summaryLine -or $suiteExit -ne 0) { throw 'La suite no terminó correctamente; revisar los resultados anteriores.' }
    $suite = "$summaryLine" | ConvertFrom-Json
    $startup = & (Join-Path $PSScriptRoot 'verify-startup.ps1') -DockerPath $DockerPath
    $restart = & (Join-Path $PSScriptRoot 'restart-container.ps1') -DockerPath $DockerPath
    $imageId = & $DockerPath image inspect --format '{{.Id}}' video-audio-dl-backend:local-qualification
    $repositoryRoot = (Get-Location).Path.Replace('\', '/')
    $revision = git -c "safe.directory=$repositoryRoot" rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo registrar la revisión de origen.' }
    $report = [ordered]@{
        recordedAt = (Get-Date).ToUniversalTime().ToString('o')
        imageId = $imageId
        sourceRevision = $revision
        scope = 'Local Docker; synthetic media; no cookies; no Render deployment qualification'
        suite = $suite
        additional = @($startup, $restart)
    }
    $destination = Join-Path $PSScriptRoot 'results-latest.json'
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $destination -Encoding UTF8
    Write-Host "Resultados: $destination"
} finally {
    & $DockerPath compose -p video-audio-dl-qualification -f tests/qualification/compose.yaml down --volumes --remove-orphans
    Pop-Location
}
