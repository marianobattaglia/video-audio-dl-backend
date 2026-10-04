$ErrorActionPreference = "Stop"
$downloadDir = [Environment]::GetFolderPath("Desktop")

function Pause-Exit {
  param([int]$Code = 0)
  Read-Host "Enter para salir"
  exit $Code
}

function Invoke-Download {
  param(
    [string]$Url,
    [string]$Kind,
    [string]$Browser = ""
  )

  $baseArgs = @("--extractor-args", "youtube:player_client=android")
  $outputTemplate = Join-Path $downloadDir "%(title)s.%(ext)s"
  if ($Kind -eq "video") {
    $args = @(
      "-f", "bv*+ba/b",
      "--merge-output-format", "mp4",
      "-o", $outputTemplate,
      $Url
    )
  } else {
    $args = @(
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "-o", $outputTemplate,
      $Url
    )
  }

  if ($Browser) {
    $args = @("--cookies-from-browser", $Browser) + $args
  }

  $args = $baseArgs + $args

  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = & yt-dlp @args 2>&1
  $ErrorActionPreference = $prev
  $exitCode = $LASTEXITCODE
  return [PSCustomObject]@{
    ExitCode = $exitCode
    Output   = $output
  }
}

try {
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null

  $url = Read-Host "Pega la URL"
  if (-not $url) {
    Write-Host "URL vacia. Saliendo."
    Pause-Exit 1
  }

  $choices = @(
    New-Object System.Management.Automation.Host.ChoiceDescription "&Video", "Descargar video (MP4)"
    New-Object System.Management.Automation.Host.ChoiceDescription "&Audio", "Descargar audio (MP3)"
  )
  $selection = $Host.UI.PromptForChoice("Tipo de descarga", "Elige una opcion:", $choices, 0)
  $kind = if ($selection -eq 0) { "video" } else { "audio" }

  Write-Host "Descargando..."
  $result = Invoke-Download -Url $url -Kind $kind
  if ($result.ExitCode -eq 0) {
    Write-Host "Listo. El archivo se ha descargado en el escritorio."
    Pause-Exit 0
  }

  $needsCookies = $result.Output -match "Sign in to confirm" -or $result.Output -match "cookies"
  if (-not $needsCookies) {
    Write-Host $result.Output
    Pause-Exit $result.ExitCode
  }

  $browser = Read-Host "El sitio requiere cookies. Escribe navegador (chrome/firefox/edge) o Enter para chrome"
  if (-not $browser) {
    $browser = "chrome"
  }

  Write-Host "Reintentando con cookies de $browser..."
  $retry = Invoke-Download -Url $url -Kind $kind -Browser $browser
  if ($retry.ExitCode -eq 0) {
    Write-Host "Listo. El archivo se ha descargado en el escritorio."
    Pause-Exit 0
  }

  Write-Host $retry.Output
  Pause-Exit $retry.ExitCode
} catch {
  Write-Host "Error inesperado:"
  Write-Host $_
  Pause-Exit 1
}
