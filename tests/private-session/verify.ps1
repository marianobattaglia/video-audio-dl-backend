param([string]$DockerPath = '')
$ErrorActionPreference = 'Stop'
if (-not $DockerPath) {
    $command = Get-Command docker -ErrorAction SilentlyContinue
    if ($command) { $DockerPath = $command.Source }
    else { $DockerPath = Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe' }
}
Push-Location (Join-Path $PSScriptRoot '../..')
try {
    & $DockerPath build -t video-audio-dl-backend:private-session -t video-audio-dl-backend:local-qualification .
    if ($LASTEXITCODE -ne 0) { throw 'Falló la construcción.' }
    $reports = @{}
    foreach ($case in @(@('private-session', 'video-audio-dl-private-session-tests'), @('qualification', 'video-audio-dl-qualification'))) {
        & $DockerPath compose -p $case[1] -f "tests/$($case[0])/compose.yaml" up --abort-on-container-exit --exit-code-from verification
        if ($LASTEXITCODE -ne 0) { throw "Falló la suite $($case[0])." }
        $ErrorActionPreference = 'Continue'
        $lines = & $DockerPath logs "$($case[1])-verification-1" 2>&1
        $ErrorActionPreference = 'Stop'
        $line = $lines | Where-Object { "$_" -like '{"summary":*' } | Select-Object -Last 1
        if (-not $line) { throw 'Suite incompleta.' }
        $reports[$case[0]] = "$line" | ConvertFrom-Json
    }
    $audit = & node tests/private-session/audit-build.cjs $DockerPath
    if ($LASTEXITCODE -ne 0) { throw 'Falló la auditoría de construcción.' }
    $reports['buildAudit'] = "$audit" | ConvertFrom-Json
    $reports['imageId'] = & $DockerPath image inspect --format '{{.Id}}' video-audio-dl-backend:private-session
    $reports['scope'] = 'Local, synthetic only; no deployment, real cookies, real YouTube or browser automation in this script'
    $reports | ConvertTo-Json -Depth 15 | Set-Content (Join-Path $PSScriptRoot 'results-latest.json') -Encoding UTF8
    Write-Host 'Verificación local completa. El recorrido de navegador se documenta por separado.'
} finally {
    & $DockerPath compose -p video-audio-dl-private-session-tests -f tests/private-session/compose.yaml --profile browser down --volumes --remove-orphans
    & $DockerPath compose -p video-audio-dl-qualification -f tests/qualification/compose.yaml down --volumes --remove-orphans
    Pop-Location
}
