#!/usr/bin/env bash
set -euo pipefail

download() {
  local url="$1"
  local kind="$2"
  local browser="${3:-}"
  local args=()
  local base_args=(--extractor-args "youtube:player_client=android")
  local outtmpl="${download_dir}/%(title)s.%(ext)s"

  if [[ "$kind" == "video" ]]; then
    args=(-f "bv*+ba/b" --merge-output-format mp4 -o "$outtmpl" "$url")
  else
    args=(-x --audio-format mp3 --audio-quality 0 -o "$outtmpl" "$url")
  fi

  if [[ -n "$browser" ]]; then
    args=(--cookies-from-browser "$browser" "${args[@]}")
  fi

  yt-dlp "${base_args[@]}" "${args[@]}"
}

download_dir="${HOME}/Desktop"
mkdir -p "$download_dir"

read -r -p "Pega la URL: " url
if [[ -z "$url" ]]; then
  echo "URL vacia. Saliendo."
  read -r -p "Enter para salir"
  exit 1
fi

echo "Elige tipo de descarga:"
select option in "Video (MP4)" "Audio (MP3)"; do
  case "$REPLY" in
    1) kind="video"; break ;;
    2) kind="audio"; break ;;
    *) echo "Opcion invalida." ;;
  esac
done

echo "Descargando..."
set +e
output="$(download "$url" "$kind" 2>&1)"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "Listo. El archivo se ha descargado en el escritorio."
  read -r -p "Enter para salir"
  exit 0
fi

if echo "$output" | grep -qiE "sign in to confirm|cookies"; then
  read -r -p "El sitio requiere cookies. Escribe navegador (chrome/firefox/edge) o Enter para chrome: " browser
  if [[ -z "$browser" ]]; then
    browser="chrome"
  fi

  echo "Reintentando con cookies de $browser..."
  download "$url" "$kind" "$browser"
  echo "Listo. El archivo se ha descargado en el escritorio."
  read -r -p "Enter para salir"
  exit 0
fi

echo "$output"
read -r -p "Enter para salir"
exit "$status"
