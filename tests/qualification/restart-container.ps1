param([Parameter(Mandatory = $true)][string]$DockerPath)
$ErrorActionPreference = 'Stop'
$container = 'video-audio-dl-qualification-restart'
Push-Location (Join-Path $PSScriptRoot '../..')
try {
    & $DockerPath compose -p video-audio-dl-qualification -f tests/qualification/compose.yaml up -d fixture | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar el servidor de medios sintéticos.' }
    # Refresh fixtures on a repeat run (media/certificates are entirely synthetic).
    & $DockerPath compose -p video-audio-dl-qualification -f tests/qualification/compose.yaml restart fixture | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo actualizar el servidor de medios sintéticos.' }
    & $DockerPath compose -p video-audio-dl-qualification -f tests/qualification/compose.yaml run -d --name $container --entrypoint node verification /app/server.js | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el contenedor de prueba de reinicio.' }
    & $DockerPath update --restart unless-stopped $container | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo configurar el reinicio del contenedor temporal.' }
    $prepared = & $DockerPath exec $container node /qualification/restart-client.cjs prepare
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron preparar los trabajos de prueba.' }
    $jobs = $prepared | ConvertFrom-Json
    & $DockerPath restart --timeout 3 $container | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo reiniciar el contenedor temporal.' }
    $confirmation = & $DockerPath exec $container node /qualification/restart-client.cjs confirm $jobs.complete $jobs.running
    if ($LASTEXITCODE -ne 0) { throw 'Falló la comprobación posterior al reinicio.' }
    $configuration = & $DockerPath inspect --format '{{json .HostConfig}}' $container | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo verificar la configuración de recursos.' }
    $result = $confirmation | ConvertFrom-Json
    $result | Add-Member restartPolicy $configuration.RestartPolicy.Name
    $result | Add-Member memoryLimitBytes $configuration.Memory
    $result | Add-Member nanoCpus $configuration.NanoCpus
    $result
} finally {
    & $DockerPath rm -f $container | Out-Host
    Pop-Location
}
