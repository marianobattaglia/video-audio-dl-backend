# Sesión privada opcional de YouTube

Implementada y comprobada localmente con datos ficticios. La publicación, calificación en Render/Vercel y prueba con una sesión real siguen pendientes en `private-youtube-cookie-session` (5.3 y 5.4).

## Qué guarda cada componente

| Componente | Información |
| --- | --- |
| GitHub, contexto Docker e imagen | Código y ejemplos vacíos; ningún archivo de sesión real |
| Vercel y assets del frontend | Solo `API_BASE_URL`, público |
| Navegador | Clave de acceso ingresada por el operador, solo en memoria de la página; se borra al recargar, salir o confirmar modo abierto |
| Render Secret File | Archivo Netscape de la cuenta dedicada, configurado directamente por el operador |
| Backend durante cada trabajo | Copia normalizada privada distinta, directorio 0700 y archivo 0600; eliminada después de detener los procesos |

La página no lee cookies de YouTube, no las recibe como archivo ni las manda en requests. El API de creación acepta exclusivamente `kind` y `url`. Las cookies se envían por HTTPS desde yt-dlp al dominio correspondiente de YouTube, bajo validación TLS. La clave va en `Authorization`, nunca en URLs. Los tickets de descarga son permisos breves de un solo uso: tampoco deben compartirse.

## Límites de confianza

El backend, las herramientas autorizadas y el proveedor que ejecuta el servicio necesitan poder leer la sesión. Secret Files no hace los datos invisibles para Render ni protege frente a una cuenta del panel comprometida o un servidor comprometido. HTTPS protege el tránsito frente a una interceptación ordinaria; el navegador del operador y el servidor reciben la clave. Una extensión maliciosa, XSS o acceso local al equipo pueden comprometerla. No hay garantía absoluta de confidencialidad.

Usá una cuenta de YouTube dedicada, sin datos personales ni privilegios adicionales. Activá MFA en Google, Render, GitHub y Vercel; limitá colaboradores del servicio y protegé los equipos usados para exportar/subir la sesión. Nunca compartas cookies, claves, capturas de su contenido ni tickets por GitHub, Vercel, logs o este chat. Las cookies pueden caducar o provocar restricciones de la cuenta; usarlas no garantiza superar el bloqueo antibot o 429. Ver [documentación de yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies).

## Configuración y calificación antes de cookies reales

1. Publicar revisiones compatibles de ambos proyectos con autorización del operador. Mantener Docker Command vacío y el entrypoint, seccomp, proxy y validación TLS activos.
2. Comenzar **sin cookies**, con `YOUTUBE_COOKIES_FILE` vacío, `AUTH_REQUIRED=true` y `ACCESS_CREDENTIAL` no vacía. Puede escribirse a mano, sin mínimo de longitud ni restricción de espacios. Para una sesión real se recomienda una clave aleatoria; este comando es opcional. Pegarla exclusivamente en Environment del backend; nunca como Docker ARG, archivo rastreado ni variable del frontend:

   ```sh
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

3. Configurar `FRONTEND_ORIGINS=https://video-audio-dl.vercel.app` y `API_BASE_URL=https://video-audio-dl-backend.onrender.com`. Los orígenes no tienen rutas ni barra final. Reconstruir el frontend para incorporar su CSP y nueva gestión de clave.
4. Verificar salud, arranque protegido, rechazo de requests directas sin clave y con clave incorrecta, clave borrada al recargar, CSP efectiva y entrega/cancelación de medios controlados. Salud es pública, pero las operaciones deben exigir clave incluso sin Origin o con Origin falsificado. Verificar logs sin datos sensibles, tickets usados/vencidos y recursos/limpieza del host según [HOST-QUALIFICATION.md](HOST-QUALIFICATION.md).
5. Registrar commit, fecha y resultados sanitizados. No habilitar una sesión real hasta completar esa calificación. Las pruebas locales no la sustituyen.

## Provisionar únicamente en Render

Después de la calificación y autorización específica para una sesión real:

1. El operador exporta localmente un archivo Netscape de la cuenta dedicada conforme a las instrucciones de yt-dlp. Mantenerlo **fuera de ambas raíces Git y de cualquier carpeta de construcción**; guardar solo cookies de `youtube.com` y subdominios auténticos. No incluir `google.com`, `youtu.be` ni otros sitios. El límite es 64 KiB y deben conservarse dominio/host-only, path y expiración.
2. En el servicio de Render, abrir **Environment → Secret Files → Add Secret File**, nombre `youtube-cookies.txt`, y cargar su contenido directamente en ese panel. Render expone Secret Files en `/etc/secrets/<nombre>`; comprobar en ese host que el usuario `node` puede leerlo. [Secret Files de Render](https://render.com/docs/configure-environment-variables#secret-files).
3. Configurar en runtime `YOUTUBE_COOKIES_FILE=/etc/secrets/youtube-cookies.txt`, conservar `AUTH_REQUIRED=true` y la clave válida. Guardar y desplegar. Si la fuente es inválida, inaccesible, demasiado grande o está dentro de un árbol inseguro, el API falla antes de aceptar trabajos. No modificar permisos/código para omitir el rechazo.
4. Realizar una prueba pequeña de audio y video. Registrar solamente estado y razón permitida. Un rechazo de YouTube se documenta como tal: evitar reintentos insistentes y no debilitar las protecciones.

El original no se modifica. Cada trabajo HTTPS admitido de YouTube usa una copia bajo `TMPDIR/video-audio-dl-cookie-jars/<UUID>/session.txt`, separada de `/tmp/downloads`. El jar conserva límites de dominio/path/expiración y fuerza Secure, también para cookies nuevas. Otros sitios no reciben esa sesión. La limpieza espera la terminación de descendientes; un fallo de borrado bloquea nuevos trabajos con cookies. El arranque elimina copias huérfanas antes de escuchar. No se publican diagnósticos libres.

Por elección del operador, el nombre que ve el usuario autorizado se forma con el título del contenido y la extensión real `.mp3` o `.mp4`. Se recibe únicamente ese campo como JSON, se limita su longitud y se eliminan controles, caracteres de rutas y caracteres inválidos para nombres de archivo; el frontend lo muestra como texto. El título no se añade a logs ni se usa para la ubicación física del archivo. En modo de sesión, el archivo interno mantiene tipo/UUID; si falta un título válido, también se usa ese nombre como fallback para descargar. No se vuelca metadata completa ni información de la cuenta.

## Diagnosticar un rechazo de arranque sin divulgar secretos

Con sesión configurada, `startup_failed` registra únicamente etapa y códigos permitidos, sin contenido del archivo, rutas, clave ni stack. `fatal_failed` usa la misma lista permitida. Un código desconocido queda como `E_STARTUP_UNKNOWN`; no se imprimen diagnósticos libres.

| Código / etapa | Qué revisar |
| --- | --- |
| `E_COOKIE_UNAVAILABLE`, `ioCode=ENOENT` | Secret File creado y guardado, nombre exacto `youtube-cookies.txt` y variable `YOUTUBE_COOKIES_FILE=/etc/secrets/youtube-cookies.txt`. |
| `E_COOKIE_UNAVAILABLE`, `ioCode=EACCES` o `EPERM` | Permisos de lectura del usuario de la aplicación en Render; no hacer público el archivo. |
| `E_COOKIE_FORMAT` | Netscape, cabecera admitida, filas completas separadas por tabulaciones, solo dominios auténticos de YouTube y máximo 64 KiB. JSON, archivo vacío o cookies de otros dominios se rechazan. |
| `E_COOKIE_LOCATION` | Fuente externa al repositorio, medios y árbol de copias privadas. |
| `E_COOKIE_CHANGED` | Archivo modificado durante la lectura; terminar la actualización y volver a desplegar. |
| `E_PRIVATE_DIRECTORY` | Ubicación y permisos de temporales; no se permiten árboles solapados o con alias. |
| `E_STARTUP_UNKNOWN` en `tool_validation` | Disponibilidad de herramientas y aislamiento obligatorio del host. |

Para compartir un fallo, copiar únicamente ese registro estructurado; nunca el contenido de Secret Files ni los valores privados del panel. Los códigos ayudan a identificar una causa, pero no acreditan por sí solos la calificación del host.

## Diagnosticar descargas con sesión activa

Los logs siguen activos en modo privado. `download_failed` conserva `jobId`, `kind`, `exitCode` y `reason`, y agrega únicamente metadatos permitidos:

- `cookieSessionUsed`: indica que el trabajo fue configurado con una copia de sesión; no confirma que YouTube la haya aceptado.
- `issues`: lista acotada de etiquetas fijas detectadas en la salida, como `http_403`, `http_429`, `cookie_session_invalid`, `po_token_required`, `javascript_challenge_failed`, `format_unavailable`, `proxy_rejected`, `network_policy_blocked`, `network_timeout`, `tls_failed`, `disk_full` y `postprocessing_failed`.
- `exception`: clase Python de una lista fija, si se detecta una excepción; no incluye su mensaje ni stack.
- `signal`: señal de terminación de una lista fija, si el proceso terminó por señal. `SIGKILL` por sí sola no confirma falta de memoria.

Los motivos públicos distinguen errores conocidos de acceso HTTP, formato, región, TLS, espera, conversión y fallos internos. Si no se reconoce el error, queda `download_failed`; las etiquetas son indicios y no una explicación garantizada de la causa. También se registran fallos de lanzamiento, tiempo/tamaño y salida de medios inválida.

Nunca habilitar stderr/stdout crudos para depurar con cookies reales. No se publica texto capturado, títulos, URLs, cookies, cabeceras, rutas privadas ni mensajes de excepciones. Para continuar un diagnóstico, compartir solamente el registro estructurado del trabajo que falló.

El launcher conserva Python `-I -B`. La política de cookies se carga por la ruta fija `/app/private_cookie_policy.py` con `importlib`, porque el modo aislado excluye el directorio del script de la búsqueda de módulos. No se añade el directorio del trabajo ni se usa `PYTHONPATH` para resolver ese módulo.

## Prueba local opcional

Usar un archivo externo ficticio o una sesión explícitamente autorizada; las pruebas automatizadas ya generan fixtures sin datos personales. Para montar una fuente local, crear **fuera del repo** un override de Compose como este ejemplo y reemplazar solamente la ruta ficticia por una ruta absoluta externa:

```yaml
services:
  video-audio-dl:
    environment:
      AUTH_REQUIRED: "true"
      YOUTUBE_COOKIES_FILE: /run/private-session/youtube-cookies.txt
    volumes:
      - type: bind
        source: C:/ruta-externa-ficticia/youtube-cookies.txt
        target: /run/private-session/youtube-cookies.txt
        read_only: true
```

Definir `ACCESS_CREDENTIAL` de runtime y usar `docker compose -f compose.yaml -f RUTA_OVERRIDE_EXTERNO up --build -d`. El Compose normal no monta ninguna fuente. No colocarla en `/app`, `/tmp/downloads` ni en el árbol privado de copias. `.gitignore` y `.dockerignore` son una defensa adicional; un nombre arbitrario puede no coincidir con esas exclusiones y por eso la ubicación externa es obligatoria.

## Rotación, revocación y reversión

- Detener admisiones/trabajos antes de reemplazar la fuente o clave. Quitar temporalmente `YOUTUBE_COOKIES_FILE`, mantener acceso protegido y desplegar; después reemplazar Secret File y, si corresponde, `ACCESS_CREDENTIAL`. Volver a configurar la ruta y desplegar. Ingresar la clave nueva tras recargar el frontend.
- Para retirar la función: detener trabajos, vaciar `YOUTUBE_COOKIES_FILE`, borrar Secret File y desplegar **manteniendo `AUTH_REQUIRED=true`**. Verificar salud, limpieza y rechazo anónimo antes de considerar cualquier cambio del acceso.
- Quitar el archivo del proveedor no revoca una sesión de Google. Revocar/cerrar esa sesión desde la cuenta dedicada y retirar las exportaciones locales; si hubo exposición, rotar también la clave y revisar accesos al panel.
- Para volver a una revisión anterior, retirar primero la ruta y Secret File, conservar el acceso protegido y usar versiones compatibles. Un rollback no restaura trabajos/archivos. No confiar cookies a una versión que no implemente este aislamiento.

La expiración de la sesión exige nueva provisión por el operador. La aplicación no captura credenciales del navegador ni renueva automáticamente la sesión original.
