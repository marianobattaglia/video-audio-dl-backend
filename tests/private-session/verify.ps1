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
    $reports['suiteImageId'] = & $DockerPath image inspect --format '{{.Id}}' video-audio-dl-backend:private-session
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo registrar la imagen de las suites.' }
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
    $playlistOutput = & $DockerPath compose -p video-audio-dl-private-session-tests -f tests/private-session/compose.yaml run --rm --entrypoint node verification --require /private-tests/bootstrap.cjs /private-tests/playlist-run.cjs
    $playlistOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'Falló la suite de playlists.' }
    $reports['playlists'] = ($playlistOutput | Where-Object { "$_" -like '{"summary":*' } | Select-Object -Last 1) | ConvertFrom-Json
    $modeOutput = & $DockerPath compose -p video-audio-dl-private-session-tests -f tests/private-session/compose.yaml run --rm --entrypoint node verification --require /private-tests/bootstrap.cjs /private-tests/playlist-modes.cjs
    $modeOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'Falló la suite de modos de playlists.' }
    $reports['playlistModes'] = ($modeOutput | Where-Object { "$_" -like '{"summary":*' } | Select-Object -Last 1) | ConvertFrom-Json
    foreach ($script in @('tests/playlists/unit.cjs', 'tests/playlists/frontend.cjs', 'tests/playlists/directory.cjs', 'tests/playlists/development.cjs')) {
        $output = & node $script
        if ($LASTEXITCODE -ne 0) { throw "Falló $script." }
        $reports[$script] = ($output -join "`n") | ConvertFrom-Json
    }
    $playlistTests = (Resolve-Path tests/playlists).Path
    & $DockerPath run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint /usr/local/bin/download-sandbox -v "${playlistTests}:/playlist-tests:ro" video-audio-dl-backend:private-session /usr/bin/python3 -I /playlist-tests/single-policy.py
    if ($LASTEXITCODE -ne 0) { throw 'Falló la guardia real de medio único.' }
    $reports['singleMediaPolicy'] = @{ status = 'pass'; scope = 'Pinned yt-dlp, real seccomp, deferred multi-media result rejected before iteration' }
    $archivePolicy = & $DockerPath run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000 --entrypoint /usr/local/bin/download-sandbox -v "${playlistTests}:/playlist-tests:ro" video-audio-dl-backend:private-session /usr/bin/python3 -I /playlist-tests/archive-policy.py
    if ($LASTEXITCODE -ne 0) { throw 'Falló el worker ZIP protegido.' }
    $reports['archivePolicy'] = "$archivePolicy" | ConvertFrom-Json
    $reports['startupRestriction'] = & (Join-Path $PSScriptRoot '../qualification/verify-startup.ps1') -DockerPath $DockerPath
    $reports['containerRestart'] = & (Join-Path $PSScriptRoot '../qualification/restart-container.ps1') -DockerPath $DockerPath
    $audit = & node tests/private-session/audit-build.cjs $DockerPath
    if ($LASTEXITCODE -ne 0) { throw 'Falló la auditoría de construcción.' }
    $reports['buildAudit'] = "$audit" | ConvertFrom-Json
    $reports['imageId'] = & $DockerPath image inspect --format '{{.Id}}' video-audio-dl-backend:private-session
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo registrar la imagen auditada.' }
    $reports['recordedAt'] = (Get-Date).ToUniversalTime().ToString('o')
    $repositoryRoot = (Get-Location).Path.Replace('\', '/')
    $reports['sourceRevision'] = git -c "safe.directory=$repositoryRoot" rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo registrar la revisión de origen.' }
    $reports['worktreeDirty'] = [bool](git -c "safe.directory=$repositoryRoot" status --porcelain)
    $reports['sourceHashes'] = @{}
    foreach ($file in @('server.js', 'playlist-store.js', 'playlist-preview.js', 'playlist-links.js', 'guarded-downloader.py', 'single_media_policy.py', 'automatic-delivery.js', 'playlist-archive.js', 'archive-output.js', 'archive-worker.py', '../video-audio-dl-frontend/public/app.js', '../video-audio-dl-frontend/public/playlist-controller.js', '../video-audio-dl-frontend/public/playlist-links.js', '../video-audio-dl-frontend/public/directory-saver.js', '../video-audio-dl-frontend/scripts/dev.mjs')) {
        $reports['sourceHashes'][$file] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $reports['scope'] = 'Local, synthetic only; no deployment, real cookies, real YouTube or browser automation in this script'
    $reports | ConvertTo-Json -Depth 15 | Set-Content (Join-Path $PSScriptRoot 'results-latest.json') -Encoding UTF8
    Write-Host 'Verificación local completa. El recorrido de navegador se documenta por separado.'
} finally {
    & $DockerPath compose -p video-audio-dl-private-session-tests -f tests/private-session/compose.yaml --profile browser down --volumes --remove-orphans
    & $DockerPath compose -p video-audio-dl-qualification -f tests/qualification/compose.yaml down --volumes --remove-orphans
    Pop-Location
}
