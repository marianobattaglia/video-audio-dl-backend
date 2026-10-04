# video-audio-dl-backend

API independiente para descargar video MP4 o audio MP3 desde URLs públicas. El contenedor incluye `yt-dlp` y `ffmpeg`. La interfaz web vive en **otro repositorio Git** y se despliega como sitio estático en Vercel; este servicio no sirve HTML, CSS ni JavaScript.

## Dos proyectos

Esta carpeta, `video-audio-dl-backend/`, es la raíz del backend y tiene su propio `.git`. El frontend vive en la carpeta hermana `video-audio-dl-frontend/`, con su propio Git, README y construcción. Ambos proyectos funcionan desde sus propias raíces y pueden trasladarse o clonarse en ubicaciones distintas sin necesitar un checkout compartido. La planificación OpenSpec se conserva en la carpeta contenedora.

Los proyectos se llaman `video-audio-dl-backend` y `video-audio-dl-frontend`. Creá dos repositorios vacíos con esos nombres en tu proveedor Git, dentro de tu cuenta u organización. Desde **esta** raíz:

```sh
git status
git add .
git commit -m "Create standalone backend"
git remote add origin https://github.com/TU_USUARIO/video-audio-dl-backend.git
git push -u origin main
```

Revisá los archivos antes de publicar. `.env` no debe aparecer en el commit del backend. Repetí el proceso desde la raíz de `video-audio-dl-frontend/` según su README; no agregues el frontend como submódulo ni como carpeta del repositorio del backend.

## Desarrollo local con Docker

Requisitos: Docker Engine con contenedores Linux y Docker Compose v2. El runtime debe permitir filtros seccomp sin privilegios (`no_new_privs`). No se necesita NET_ADMIN, root ni modificar el firewall del host. El contenedor falla al iniciar si no puede instalar el aislamiento del descargador.

1. Copiá `.env.example` a `.env`.
2. Dejá `AUTH_REQUIRED=false` para acceso abierto. No necesitás definir una clave. Para habilitarla más adelante, usá `AUTH_REQUIRED=true` y configurá `ACCESS_CREDENTIAL` con una clave aleatoria de al menos 24 caracteres, sin espacios. Podés generar una desde Node:

   ```sh
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

3. Dejá `FRONTEND_ORIGINS=http://localhost:5173` para el desarrollo local.
4. Iniciá el backend:

   ```sh
   docker compose up --build -d
   ```

5. Iniciá `npm run dev` **desde el repositorio del frontend** y abrí `http://localhost:5173`. Con acceso abierto no se muestra ni se pide clave; con la función activada, el campo aparece al intentar preparar una descarga.

`http://localhost:3000/healthz` devuelve JSON de salud sin exigir clave. La raíz `/` devuelve 404: el backend no sirve la interfaz. El puerto de Compose se publica solo en `127.0.0.1`. Para detenerlo, ejecutá `docker compose down` desde este repositorio.

El contenedor conserva las versiones fijadas en `Dockerfile`: `yt-dlp` 2026.08.19 y `ffmpeg` 7:5.1.9-0+deb12u1. Usa el wheel oficial con checksum SHA-256, Python y soporte AES. `TMPDIR=/tmp/yt-dlp` contiene el socket interno del proxy y no necesita permiso de ejecución.

La API requiere Linux, el ejecutable de aislamiento compilado y el adaptador de yt-dlp incluidos en esta imagen. En Windows y macOS, usá Docker también para desarrollo; instalar solo Node, yt-dlp y FFmpeg ya no alcanza para iniciar la API. Los lanzadores originales de terminal siguen disponibles y son independientes de la API.

### Protección de las conexiones

- La API y el proxy comparten la política de esquemas, puertos y direcciones públicas.
- Cada descargador se inicia bajo seccomp. El filtro bloquea sockets de Internet y se hereda por todos los hijos, incluidos FFmpeg y FFprobe. Antes de ejecutar se cierran los descriptores heredados salvo stdin/stdout/stderr.
- yt-dlp usa un socket Unix privado para comunicarse con un proxy HTTP interno. No hay un puerto TCP de proxy expuesto.
- Cada trabajo recibe un permiso aleatorio interno, distinto de la clave del usuario; se revoca y se cierran sus conexiones al terminar, cancelar o superar límites.
- El proxy comprueba todas las IP del dominio, rechaza direcciones privadas, reservadas, mapeadas o mixtas, conecta a una IP literal validada sin otra resolución y comprueba la dirección efectiva antes de reenviar.
- Las redirecciones y los segmentos vuelven a pasar por esta protección. HTTPS conserva la validación TLS del sitio, sin interceptar certificados.
- FFmpeg procesa archivos locales. Se rechazan transmisiones y formatos que requieran descargas directas de FFmpeg. Los plugins, componentes remotos y runtimes JavaScript de yt-dlp están desactivados.
- El DNS utiliza el resolver normal del host; no necesita excepciones de firewall para Docker DNS.

La API comprueba que puede instalar el filtro y ejecutar las herramientas antes de escuchar. El mensaje de inicio esperado es **“Downloader network sandbox and checked internal proxy ready”**.

## Configuración

Docker Compose carga `.env`; Node directo y el host leen variables del proceso. Los secretos nunca se incorporan a la imagen ni a assets del frontend.

| Variable | Valor inicial / función |
| --- | --- |
| `AUTH_REQUIRED` | `false` por defecto: acceso abierto. `true`: exige clave. Solo admite esos dos valores; requiere reiniciar el backend tras cambiarlo. |
| `ACCESS_CREDENTIAL` | Obligatoria solo con `AUTH_REQUIRED=true`; clave compartida de al menos 24 caracteres sin espacios. Se ignora en modo abierto. |
| `FRONTEND_ORIGINS` | Lista separada por comas de orígenes exactos, sin barra final, ruta ni wildcard. Sin valor, no se concede acceso cross-origin. |
| `HOST` | `0.0.0.0`; escucha en todas las interfaces del contenedor. |
| `PORT` | `3000` por defecto; en el host se utiliza el valor que suministre la plataforma. |
| `MAX_CONCURRENT_DOWNLOADS` | `1`; trabajos en ejecución y solicitudes de creación pendientes comparten este límite. |
| `MAX_DOWNLOAD_SECONDS` | `600`; tiempo máximo por trabajo. |
| `JOB_TTL_SECONDS` | `300`; expiración de trabajos terminados. La limpieza periódica corre cada 30 segundos. |
| `MAX_OUTPUT_MB` | `64`; límite por trabajo, incluidos los archivos intermedios observados. |
| `MAX_TEMP_MB` | `192`; presupuesto total de archivos temporales. Se reserva margen antes de iniciar otro trabajo. |
| `DOWNLOAD_TICKET_SECONDS` | `60`; vigencia del permiso de un solo uso, configurable entre 10 y 300 segundos. |
| `RATE_WINDOW_SECONDS` | `60`; ventana para límites de intentos. |
| `AUTH_FAILURE_LIMIT` | `10`; máximo de rechazos de clave por dirección de conexión durante la ventana. |
| `JOB_CREATE_LIMIT` | `5`; máximo de solicitudes autorizadas de creación por dirección de conexión durante la ventana. |
| `DOWNLOAD_TMP_DIR` | Carpeta exclusiva para archivos temporales; Docker usa `/tmp/downloads`. Se limpia al iniciar. |
| `YTDLP_PATH`, `FFMPEG_PATH` | Rutas de herramientas; en Docker `/usr/local/bin/yt-dlp` y `/usr/bin/ffmpeg`. |
| `DOWNLOAD_SANDBOX_PATH` | `/usr/local/bin/download-sandbox`; protección obligatoria, sin modo para omitirla. |
| `TMPDIR` | Docker usa `/tmp/yt-dlp`, para el socket y temporales auxiliares. |

Compose limita memoria a 512 MB y CPU a 0,1, monta hasta 256 MB de archivos de descarga temporales y 16 MB para el socket y temporales auxiliares. Los valores iniciales son conservadores, **no una capacidad medida ni garantizada de Render**. El muestreo de tamaño cada dos segundos puede exceder momentáneamente los límites y no sustituye las cuotas del host. Los límites y errores eliminan los archivos del trabajo; un reinicio limpia los restantes.

Se limita por la dirección del socket, sin confiar en cabeceras `X-Forwarded-For` de origen desconocido. Detrás de un proxy del host, varios usuarios pueden compartir un límite. Es aceptable para el uso personal previsto; ajustar valores requiere observar el despliegue real.

## Contrato HTTP

Con `AUTH_REQUIRED=true`, las operaciones de creación, estado, cancelación y emisión de permisos reciben `Authorization: Bearer CLAVE`. Con `false`, esas operaciones no exigen clave. Los límites de frecuencia y concurrencia, CORS, controles de destinos y permisos de archivo siguen activos en ambos modos. El backend rechaza orígenes de navegador no configurados y soporta preflight para `GET`, `POST`, `DELETE`, `Authorization` y `Content-Type`.

| Método y ruta | Autorización | Resultado |
| --- | --- | --- |
| `GET /healthz` | Sin clave; CORS para orígenes permitidos | `{status:"ok",activeDownloads:n,authRequired:false\|true}`; no crea trabajos ni expone la clave. |
| `POST /api/jobs` | Clave solo si está activada | JSON `{url,kind:"video"\|"audio"}`; 202 con el trabajo. |
| `GET /api/jobs/:id` | Clave solo si está activada | Estado, avance, mensaje, nombre y `canDownload`. |
| `DELETE /api/jobs/:id` | Clave solo si está activada | Cancelación y limpieza del trabajo. |
| `POST /api/jobs/:id/ticket` | Clave solo si está activada | Permiso temporal, URL relativa de archivo, vencimiento y nombre. |
| `GET /api/jobs/:id/file?ticket=...` | Permiso temporal de un solo uso | Archivo transmitido con `Content-Disposition` y tipo MP4/MP3. |

El permiso se consume antes de iniciar la entrega; se invalida al expirar, cancelar o eliminar el trabajo. No se requiere la clave compartida en la URL del archivo. No registres ni compartas URLs que contengan permisos. No hay reintento automático de creación si se pierde la respuesta, ni promesa de recuperar una entrega interrumpida. Un archivo entregado se elimina y no se vuelve a descargar con el mismo permiso.

## Candidato de despliegue: Render Free

**Compatibilidad pendiente.** `render.yaml` prepara un Web Service Docker gratuito, con despliegue automático desactivado, salud en `/healthz` y acceso abierto (`AUTH_REQUIRED=false`). El primer despliegue construyó correctamente la imagen pero falló en el firewall; el usuario autorizó la adaptación a un proxy interno y un filtro seccomp sin privilegios. Su nuevo arranque y las descargas en Render siguen pendientes.

Registrá el nuevo arranque y las comprobaciones pendientes en [HOST-QUALIFICATION.md](HOST-QUALIFICATION.md). Si Render rechaza seccomp, la API se detendrá antes de escuchar; no existe una alternativa automática sin protección.

Configuración desde Render, una vez acordada la evaluación:

1. Vinculá el repositorio **del backend** a un Web Service con runtime **Docker**, plan **Free**, Dockerfile `./Dockerfile` y contexto `.`. No uses el runtime Node nativo.
2. Conservá el `ENTRYPOINT` y `CMD` del Dockerfile. Render proporciona `PORT`; el servidor lo lee. No sobrescribas el comando para saltar el entrypoint.
3. Configurá `FRONTEND_ORIGINS` como variable de runtime. `AUTH_REQUIRED=false` permite acceso abierto; si decidís activarlo, configurá `AUTH_REQUIRED=true` y una `ACCESS_CREDENTIAL` privada. No declares la clave como `ARG` del Dockerfile.
4. Configurá `/healthz` como ruta de salud. El Dockerfile incluye también su health check; en Render prima el mecanismo de salud de la plataforma.
5. Revisá los registros de inicio. Si aparece **“Cannot install downloader network sandbox”**, el host no permite el aislamiento. Si aparece el error antiguo **“Cannot enforce outbound destination restrictions”**, revisá que se haya desplegado el commit nuevo.
6. Con validación completa, copiá el origen HTTPS del servicio a `API_BASE_URL` en Vercel. Configurá `FRONTEND_ORIGINS` con el origen exacto de la publicación del frontend y repetí la comprobación de conexión.

Render Free duerme después de 15 minutos sin tráfico entrante; despertar puede demorar alrededor de un minuto. Los archivos locales y trabajos en memoria pueden perderse al dormir, reiniciar o desplegar. Hay cuotas de horas, ancho de banda y construcción. No hay disco persistente en el plan gratuito. La aplicación está preparada para informar esperas e interrupciones, pero no puede asegurar disponibilidad continua ni que cualquier video quepa en los recursos gratuitos. [Límites del plan gratuito](https://render.com/docs/free).

El frontend inicia una petición de salud cuando el usuario intenta descargar, muestra el mensaje de preparación después de un segundo, espera hasta dos minutos y habilita un reintento manual al despertar. No mantiene el servicio encendido con llamadas programadas. Reiniciar el backend no recupera trabajos previos.

## Conectar, actualizar y revertir

Consultá [DEPLOYMENT.md](DEPLOYMENT.md) para el orden de configuración, dominios de producción/preview, versiones compatibles y recorrido pendiente de validación. Cada servicio usa su propio repositorio. Publicar o revertir uno no vuelve a construir el otro. Cambiar el origen del backend requiere reconstruir el frontend; cambiar su clave solo requiere ingresarla nuevamente.

## Descargas desde la terminal

Los lanzadores originales se conservan y guardan el archivo en el Escritorio; no requieren frontend, API ni clave compartida.

### Windows

Doble clic en `descargar_windows.bat` o:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\descargar_windows.ps1"
```

### macOS

Doble clic en `descargar_macos.command`. Los lanzadores necesitan `yt-dlp` en PATH y `ffmpeg` para audio MP3.

Referencias: [Docker en Render](https://render.com/docs/docker), [Blueprints de Render](https://render.com/docs/blueprint-spec), [servicios web y puerto](https://render.com/docs/web-services).
