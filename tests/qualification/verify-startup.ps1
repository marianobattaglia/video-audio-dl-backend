param([Parameter(Mandatory = $true)][string]$DockerPath)
$ErrorActionPreference = 'Stop'
$container = 'video-audio-dl-qualification-no-seccomp'
$profile = Join-Path $PSScriptRoot 'deny-seccomp.json'
try {
    & $DockerPath create --name $container --network none --cap-drop ALL --security-opt no-new-privileges:true --security-opt "seccomp=$profile" -e AUTH_REQUIRED=false -e ACCESS_CREDENTIAL= video-audio-dl-backend:local-qualification | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear la prueba de arranque sin seccomp.' }
    & $DockerPath start $container | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar la prueba de arranque.' }
    $exitCode = & $DockerPath wait $container
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo obtener el resultado de la prueba.' }
    # Docker logs includes expected stderr; collect it without treating it as a PowerShell error.
    $ErrorActionPreference = 'Continue'
    $startupLogs = (& $DockerPath logs $container 2>&1 | Out-String)
    $ErrorActionPreference = 'Stop'
    if ([int]$exitCode -ne 1 -or $startupLogs -notmatch 'Cannot install downloader network sandbox' -or $startupLogs -match 'checked internal proxy ready|listening') {
        throw 'El resultado no confirma el rechazo del arranque cuando falta seccomp.'
    }
    [pscustomobject]@{ name = 'API refuses startup when seccomp installation is denied'; status = 'pass'; exitCode = [int]$exitCode; network = 'none' }
} finally {
    & $DockerPath rm -f $container | Out-Host
}
