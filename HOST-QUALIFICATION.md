# Validación del host de backend

## Evidencia y estado

El usuario publicó ambos repositorios en GitHub y confirmó el frontend funcionando en Vercel. El primer despliegue del backend en Render construyó y publicó la imagen, pero al arrancar registró:

```text
Cannot enforce outbound destination restrictions. This host must support IPv4/IPv6 firewall rules and NET_ADMIN; public deployment is not qualified. The API will not start.
Exited with status 1
```

El resultado rechaza el mecanismo anterior en esta instancia. El usuario autorizó sustituirlo por un proxy interno y un aislamiento seccomp sin privilegios.

La nueva imagen se construyó localmente: C compilado con advertencias tratadas como errores, checksum y versión del wheel oficial de yt-dlp comprobados, soporte AES presente y sintaxis Python revisada. El usuario aportó luego logs de construcción correcta en Render y confirmó ambos despliegues. La consulta pública a `https://video-audio-dl-backend.onrender.com/healthz` devolvió `{"status":"ok","activeDownloads":0,"authRequired":false}`. Esto confirma disponibilidad de la API; no completa la validación de todas las restricciones ni confirma una transferencia.

El enlace de YouTube `bzhObFFhXiw`, previamente funcional en local según el usuario, falla en Render. Tras desplegar el registro acotado de fallos, el usuario aportó `exitCode: 1`, `reason: "source_bot_check"` y `ERROR: [youtube] bzhObFFhXiw: Sign in to confirm you’re not a bot`, además de una advertencia de metadatos incompletos. Se confirma rechazo antibot durante la extracción. No se confirmó una transferencia, ni que cambiar dependencias pueda resolver el rechazo. No se ejecutaron pruebas automatizadas ni se repitieron descargas desde el agente. La tarea 3.2 permanece abierta.

El usuario autorizó el ajuste de compatibilidad con nightly/EJS/Node. Se construyó localmente `video-audio-dl-backend:youtube-ejs` con yt-dlp `2026.9.27.232945.dev0` y EJS `0.8.0`: ambos SHA-256 correctos, versiones compatibles, assets del solver y parsing Python comprobados durante la construcción. La nueva revisión todavía no se publicó ni ejecutó en Render desde el agente, y no se ejecutaron descargas ni pruebas automatizadas. La construcción completa la preparación de la imagen, no la validación de ejecución del solver bajo el aislamiento.

El 5 de octubre de 2026, tras las instrucciones de despliegue del ajuste, el usuario aportó un nuevo fallo del mismo enlace: `HTTP Error 429: Too Many Requests` al obtener la página y luego `Sign in to confirm you’re not a bot`, con `exitCode: 1` y `reason: source_bot_check`. Persiste el bloqueo de origen. El registro no identifica la IP efectiva, la versión desplegada ni demuestra ejecución del solver; no se marca una transferencia o validación EJS como completada. La FAQ de yt-dlp asocia 429 con bloqueo de IP por exceso de uso; Render documenta rangos de salida compartidos por región. No atribuir el exceso de uso exclusivamente a este usuario. Ver [FAQ de yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#http-error-429-too-many-requests-or-402-payment-required) y [IPs de salida de Render](https://render.com/docs/outbound-ip-addresses).

El usuario identificó Oregon como región original y reportó que la prueba propuesta en Virginia falla también con HTTP 429 y source_bot_check. Durante esa prueba se leyó la configuración pública de Vercel y se confirmó que apuntaba al servicio alternativo; la región se conoce por el relato del usuario, no por una consulta al panel de Render. Luego el usuario decidió volver a `https://video-audio-dl-backend.onrender.com`: las referencias del proyecto se actualizaron y queda aplicar ese valor a `API_BASE_URL` en Vercel y desplegar de nuevo el frontend. No se confirmó transferencia ni ejecución del solver. En esa etapa la alternativa de cookies todavía estaba propuesta y no autorizada; no se habían añadido sesiones, proxies externos ni pruebas desde el agente.

## Verificación local sin cookies — 5 de octubre de 2026

El usuario autorizó verificar localmente el backend antes de implementar la sesión privada de YouTube. Los párrafos anteriores registran las etapas previas: la falta de pruebas automatizadas indicada allí queda reemplazada por esta evidencia local. La propuesta de cookies ya está preparada en OpenSpec como `private-youtube-cookie-session`; no está implementada y estas pruebas no usan cookies.

Se construyó la imagen `video-audio-dl-backend:local-qualification` desde la revisión de código `9f0cfd7200e11e35dcdf339d53606488381181e6`. Identificador final registrado por Docker: `sha256:796495781e966029a465f0d39cbc6651f1ca8ca749ac6299137bd3c1f94a7fbd`; configuración de la imagen: `sha256:442850371a983fa4c190a854fda73e9c2f96e2399b365ce43c9206f72fdf9a48`. Se añadieron pruebas y documentación; no se cambió el código de la API ni del descargador.

La suite principal pasó **33/33 casos**. Incluye cinco pruebas del cliente real con DOM/peticiones/temporizadores simulados, no un navegador. Ver resultados fechados y reproducción en [tests/qualification/README.md](tests/qualification/README.md).

| Área | Evidencia local |
| --- | --- |
| Arranque y recursos | API UID 1000, capacidades efectivas en cero, no_new_privs, proxy protegido y dependencias disponibles; límites cgroup de 512 MiB y 0,1 CPU comprobados |
| Aislamiento heredado | IPv4/IPv6, TCP/UDP y netlink rechazados; hijo Python y Node bloqueados; descriptores heredados cerrados; FFmpeg y FFprobe no pueden abrir HTTP directo |
| Destinos y DNS | URL privada, metadatos, loopback, IPv6 mapeada, esquemas/puertos y DNS mixto rechazados; DNS pinning y discrepancia de peer comprobados con DNS/transporte inyectados |
| Proxy | Socket privado, petición sin autorización rechazada; revocar permiso cierra un túnel activo e impide reutilizarlo |
| Transferencia y TLS | Video HTTP, audio HTTPS y redirección permitida completados; duración de salida comprobada con FFprobe; certificado de hostname incorrecto rechazado; redirección privada fallida y limpiada |
| Entrega | Tickets de un solo uso, eliminación después de entregar y expiración del archivo sin entrega |
| Cuotas y limpieza | Concurrencia rechazada, cancelación y reintento, salida excesiva, presupuesto temporal insuficiente y tiempo máximo de 30 segundos; archivos eliminados al fallar/cancelar |
| Reinicio de API | Trabajos en curso y completos perdidos, archivos antiguos eliminados y nueva descarga posible |
| Acceso y CORS | Modo abierto sin credencial; origen no permitido rechazado; modo protegido probado con clave ficticia, independiente de CORS |
| EJS | Assets locales parseados por Node bajo seccomp y permisos; no se resolvió un desafío real de YouTube |
| Interfaz simulada | Trabajo/archivo perdido informa interrupción y permite reintentar; despertar comparte una solicitud, exige reintento manual y termina por timeout o HTML inválido |

Las transferencias usaron un MP4 sintético de **3 segundos, 320×180, 186.790 bytes**, y un certificado efímero de prueba. El rango `11.250.237.0/24` solo existe dentro de una red Docker **interna sin salida a Internet**: permite ejercitar el proxy con IP clasificada como pública sin enviar tráfico a sus titulares reales. No acredita transferencia pública desde Render.

En la ejecución final reproducible, el pico del contenedor completo de la suite fue **99.569.664 bytes (94,96 MiB)**; CPU acumulada **8,66 segundos**, con throttling esperado por el límite de 0,1 CPU. Incluye el verificador y sus procesos. Los contadores OOM y OOM kill fueron cero. Una ejecución previa de la misma imagen registró 128,08 MiB; no se extrapola ese consumo a descargas grandes. Las cuotas de aplicación se redujeron a salida 1 MiB, temporales 3 MiB, tiempo 30 segundos y retención 60 segundos para ejercitar errores; no son los valores de producción ni una medición de medios grandes. Ver [resultados fechados](tests/qualification/results-2026-10-05.json).

La primera ejecución encontró dos aserciones de prueba que esperaban error de socket, pero el destino por nombre era bloqueado antes en DNS. Se ajustaron las pruebas para usar una IP literal; la segunda ejecución confirmó el bloqueo de sockets. No fue necesario modificar la protección de producción.

Dos comprobaciones adicionales pasaron: **(1)** impedir seccomp produce salida 1 antes de habilitar la API, en un contenedor sin red; **(2)** reiniciar un contenedor real pierde trabajos completos/en curso, limpia tmpfs y permite descargar de nuevo. En la segunda también se comprobó ticket vencido, rechazo y limpieza de un MP4 válido sobredimensionado y mensaje explícito de cuota de tamaño para salida creciente. Se inspeccionaron `unless-stopped`, RAM 512 MiB y 0,1 CPU; no se simuló una caída del daemon Docker ni un reinicio de Render. Total: **35 casos aprobados** (33 de suite + 2 adicionales).

**Pendiente:** la calificación completa de Render, la ejecución real del solver, los recursos de medios representativos y el recorrido en navegador desplegado siguen abiertos en tareas 3.2, 3.3, 3.4 y 4.4. No se desplegó ni se publicó nada durante esta verificación.

## Protección implementada

1. La API valida una URL inicial HTTP/HTTPS pública, en 80/443, sin credenciales.
2. Antes de escuchar, comprueba que seccomp puede instalarse con no_new_privs y que las herramientas se ejecutan bajo el filtro.
3. Cada descargador instala el filtro antes de yt-dlp. Solo permite sockets Unix; bloquea sockets de Internet y otros dominios de sockets, io_uring, ptrace, acceso a memoria de otros procesos y obtención de sus descriptores. Comprueba la arquitectura y rechaza ABI alternativos.
4. Cierra previamente los descriptores heredados, salvo stdin/stdout/stderr. El filtro se hereda por fork/exec, incluyendo FFmpeg y FFprobe; no hay una opción para omitirlo.
5. El adaptador dirige el proxy HTTP de yt-dlp por un socket Unix privado con permiso aleatorio por trabajo. No se expone ningún puerto TCP de proxy. Plugins externos y componentes remotos están desactivados. El ajuste aprobado instala EJS compatible local y habilita solo Node, que hereda seccomp y las restricciones de permisos del proveedor oficial de yt-dlp. La API exige Node y EJS al iniciar; no hay descarga de solver remoto ni cliente Android forzado.
6. El proxy comprueba todas las IP de cada nuevo destino y rechaza IP privadas, reservadas, mapeadas o respuestas mixtas. Conecta a una IP literal comprobada sin segunda resolución y comprueba la dirección efectiva.
7. HTTP usa puerto 80 y HTTPS usa CONNECT a 443. Las redirecciones y segmentos requieren nuevas comprobaciones. TLS sigue verificándose en yt-dlp contra el sitio original, sin interceptar certificados.
8. Se limita la espera DNS/conexión y se revoca el permiso y sus conexiones al finalizar, cancelar, superar los límites o apagar la API.

La seguridad no depende exclusivamente de validar la URL inicial ni de que cada extractor respete voluntariamente el proxy: los sockets directos del descargador y de sus hijos quedan bloqueados por el filtro.

## Compatibilidad

El descargador nativo transfiere HTTP/HTTPS y FFmpeg une, convierte y remuxea archivos locales. EJS ejecuta el solver local con Node bajo el filtro heredado. Las rutas que necesitan descarga directa de FFmpeg, otros protocolos, plugins o runtimes distintos de Node se rechazan. No se promete compatibilidad con todos los sitios o transmisiones en vivo ni desbloquear la IP del host. Los lanzadores originales de terminal permanecen separados de la API.

## Comprobaciones pendientes en el nuevo despliegue

Registrar host/plan, commit, fecha, resultado y registros sin claves ni permisos. Usar destinos controlados para redirecciones/DNS, sin consultar servicios privados reales.

| Comprobación | Resultado esperado | Estado |
| --- | --- | --- |
| Construcción de la imagen adaptada | Compilación, checksum, versión y dependencias correctos | Local completada; construcción Render confirmada por logs del usuario |
| Usuario y capacidades | API como node, sin NET_ADMIN ni permisos extra | Configuración presente; ejecución pendiente |
| Arranque protegido | Seccomp y herramientas disponibles; proxy listo antes de escuchar | API disponible por salud; registro de inicio y commit pendientes |
| Inicio sin seccomp | API no escucha; error de aislamiento | Pendiente |
| Sockets directos y heredados | IPv4, IPv6, UDP y vías alternativas rechazadas | Pendiente |
| EJS y Node | Assets locales compatibles; solver ejecuta bajo seccomp sin sockets de Internet ni componentes remotos | Implementación presente; ejecución pendiente |
| URL privada, loopback o metadatos | Rechazo antes de conectar | Pendiente |
| Dominio privado, reservado, mapeado o mixto | Rechazo antes de conectar | Pendiente |
| Redirección pública a privada | Rechazo por proxy o filtro | Pendiente |
| Cambio DNS entre validación/conexión | Conecta solo a la IP literal comprobada | Pendiente |
| Puertos/esquemas no permitidos | Rechazo | Pendiente |
| HTTP y HTTPS públicos | Transferencia correcta; TLS verificado | Pendiente |
| Proxy sin permiso o con permiso revocado | Solicitudes rechazadas y conexiones cerradas | Pendiente |
| FFmpeg | Conversión local correcta; entrada de red bloqueada | Pendiente |
| Video y audio pequeños | Procesamiento y entrega dentro de recursos | Pendiente |
| Tamaño, tiempo y espacio temporal | Error y limpieza al exceder límites | Pendiente |
| Cancelación y reinicio | Cierra conexiones/procesos; permite reintento | Pendiente |

Los límites de 64 MB por trabajo, 192 MB temporales, 600 segundos y una descarga simultánea requieren medición en el host.

## Siguiente despliegue

1. Publicar los cambios del backend en GitHub.
2. En Render: **Manual Deploy → Deploy latest commit**, con Docker Command vacío.
3. Conservar HOST=0.0.0.0, el PORT del host, AUTH_REQUIRED=false, FRONTEND_ORIGINS exacto y /healthz.
4. Revisar **“Downloader network sandbox and checked internal proxy ready”** y el mensaje de inicio de la API.
5. Registrar las comprobaciones pendientes y conectar el origen real a API_BASE_URL en Vercel.
6. Si seccomp también se rechaza, mantener el fallo de arranque y evaluar otro host. Si aparece el error antiguo de firewall, comprobar el commit desplegado.

Referencias: [Docker en Render](https://render.com/docs/docker), [servicios y puerto](https://render.com/docs/web-services), [plan gratuito](https://render.com/docs/free), [seccomp del kernel Linux](https://docs.kernel.org/userspace-api/seccomp_filter.html), [yt-dlp](https://github.com/yt-dlp/yt-dlp).
