# Conectar y publicar los dos proyectos

## Estado

Ambos repositorios están publicados en GitHub bajo `marianobattaglia`. El frontend está en `https://video-audio-dl.vercel.app` y el backend en `https://video-audio-dl-backend.onrender.com`. El backend adaptado responde a `/healthz` con `status: "ok"` y `authRequired: false`. El usuario confirmó el rechazo antibot de YouTube para `bzhObFFhXiw`, que funcionaba localmente. Autorizó un ajuste de compatibilidad con nightly/EJS/Node; está implementado para el próximo deploy. El recorrido completo sigue pendiente. Ver [HOST-QUALIFICATION.md](HOST-QUALIFICATION.md).

Los proyectos son carpetas hermanas: `video-audio-dl-frontend/` y `video-audio-dl-backend/`. Cada una tiene su propio `.git`, README y configuración. Publicá cada raíz en un remoto distinto con el mismo nombre que su proyecto. La carpeta contenedora conserva OpenSpec y no es un repositorio Git. Podés mantener ambas copias de trabajo en ubicaciones distintas.

## Configuración por entorno

| Entorno | Frontend: `API_BASE_URL` | Backend: `FRONTEND_ORIGINS` |
| --- | --- | --- |
| Local | `http://localhost:3000` mediante `npm run dev` | `http://localhost:5173` |
| Producción | `https://video-audio-dl-backend.onrender.com` | `https://video-audio-dl.vercel.app` |
| Preview | Origen HTTPS de una API de pruebas | Origen exacto de ese preview o dominio estable de pruebas |

La fila de producción registra los dominios actuales; la de preview es un ejemplo. No incluyas rutas ni barras finales. En el backend, separá varios orígenes con comas. Si cambiás un dominio, ajustá ambos lados. No uses wildcards para previews.

## Diagnóstico de descargas de YouTube

El cliente consulta el sitio de origen desde Render, cuya IP es distinta de la conexión local. Que un enlace funcione localmente no confirma que YouTube permita la descarga desde el host. La revisión que falló forzaba el cliente Android, no incorporaba `yt-dlp-ejs` y desactivaba runtimes JavaScript. El usuario aportó el diagnóstico original: el trabajo de audio termina con `exitCode: 1`, `reason: "source_bot_check"` y `ERROR: [youtube] bzhObFFhXiw: Sign in to confirm you’re not a bot`. También aparece la advertencia de título ausente en las respuestas del reproductor. Está confirmada la verificación antibot; el log no demuestra que falte JavaScript ni que instalarlo elimine el bloqueo.

Sin sesión configurada, el backend registra los fallos con `event`, identificador, `exitCode`, `reason` y diagnósticos acotados/redactados, que no se envían al navegador. Con `YOUTUBE_COOKIES_FILE` configurado se eliminan los diagnósticos libres de logs y se conservan únicamente campos permitidos; también se usan nombres de descarga generados por UUID. El mensaje visible distingue una verificación antibot de un pedido explícito de inicio de sesión.

Después de cada revisión: publicar el backend, usar **Manual Deploy → Deploy latest commit**, repetir una vez la descarga y buscar `download_failed` en los logs de Render si falla. Registrar el error y las advertencias antes de modificar clientes, dependencias o hosting. Los diagnósticos y mensajes no eliminan bloqueos del sitio de origen.

### Ajuste de compatibilidad aprobado e implementado

1. La imagen usa la nightly oficial yt-dlp `2026.9.27.232945.dev0`, fijada por URL y SHA-256. PyPI publica `2026.8.19` como última estable consultada; la nightly incorpora cambios posteriores.
2. Se incorpora `yt-dlp-ejs` `0.8.0`, requerido exactamente por esa versión de yt-dlp, con URL y SHA-256. La construcción comprueba versiones, compatibilidad y assets del solver. Las descargas de componentes en tiempo de ejecución y los plugins externos siguen desactivados.
3. Solo se habilita `node:/usr/local/bin/node`, después de borrar los runtimes predeterminados. Sus procesos heredan seccomp y las restricciones de permisos de yt-dlp; el proxy conserva la validación de destinos. El arranque exige Node disponible bajo seccomp y EJS compatible local.
4. Se retiró `youtube:player_client=android`; yt-dlp selecciona sus clientes predeterminados.
5. Pendiente: registrar el resultado del mismo enlace desde Render. Si persiste la verificación antibot, la actualización no habrá resuelto el bloqueo de origen; evaluar por separado una salida de red aceptada por YouTube o una sesión autenticada, con sus costes y límites.

Este ajuste apunta a compatibilidad completa, no promete desbloquear una IP ni añade cookies de usuario. Se actualizó la decisión de OpenSpec con la aprobación del usuario. Su publicación y recorrido en Render siguen pendientes.

La imagen local `video-audio-dl-backend:youtube-ejs` se construyó correctamente: comprobó SHA-256 de ambos wheels, versiones compatibles y assets locales de EJS. No se ejecutaron pruebas automatizadas ni descargas para este ajuste.

El usuario volvió a intentar el mismo enlace después de las instrucciones de despliegue y aportó, el 5 de octubre de 2026, `HTTP Error 429: Too Many Requests` al obtener la página, seguido por la verificación antibot. El rechazo persiste; no hay transferencia exitosa confirmada. Cambiar dependencias no ha demostrado resolverlo. No se capturó en ese registro el commit o las versiones del despliegue.

En esa etapa se evaluaron esperar, probar otra región e incorporar una sesión autenticada. Otra región también puede ser rechazada y no garantiza descargas. Las cookies todavía no estaban implementadas entonces; la sección de sesión privada describe la implementación posterior. Un proveedor de PO tokens no desbloquea por sí solo una IP ya bloqueada según los problemas conocidos de yt-dlp. No se creó un servicio adicional.

#### Resultado de la prueba en otra región

El usuario indicó que el servicio original está en Oregon y siguió la prueba propuesta en Virginia. Reportó de nuevo 429 al obtener la página y rechazo antibot para `bzhObFFhXiw`. Durante esa prueba, la lectura de la configuración pública de Vercel confirmó que el frontend apuntaba al servicio alternativo; la región se registra según el relato del usuario. La prueba de otra región no consiguió una descarga. El usuario decidió volver al backend original `https://video-audio-dl-backend.onrender.com`, registrado en la tabla de producción. Para aplicar ese destino al frontend alojado, actualizar `API_BASE_URL` en Vercel y generar un nuevo despliegue.

#### Sesión privada opcional, implementada localmente

El cambio `private-youtube-cookie-session` incorpora una sesión opcional de una cuenta dedicada, con provisión fuera de Git. Está implementado localmente con datos ficticios; publicación, calificación y una prueba real siguen pendientes. Las cookies pueden caducar o causar restricciones de la cuenta y no garantizan resolver el bloqueo. No se solicitó ni utilizó contenido real.

La [guía de sesión privada](PRIVATE-SESSION.md) detalla los controles implementados, confianza necesaria en el proveedor, MFA, clave aleatoria, cuenta dedicada, Render Secret Files, rotación, revocación y rollback protegido. Publicar ambos proyectos con autorización y calificar primero sin cookies, con acceso protegido, antes de provisionar una sesión real exclusivamente en el panel de Render. Nunca subirla a GitHub, Vercel ni al chat. Seccomp, proxy y TLS siguen siendo obligatorios.

Referencias: [429 y cookies](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#http-error-429-too-many-requests-or-402-payment-required), [cuentas y cookies de YouTube](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies), [archivos secretos de Render](https://render.com/docs/configure-environment-variables#secret-files).

Para publicarlo: hacé commit/push desde el repositorio del backend y en Render elegí **Manual Deploy → Deploy latest commit**. Conservá las variables actuales y Docker Command vacío. Buscá **“YouTube compatibility ready: local EJS, protected Node runtime, default clients”** y después repetí el enlace. Si falla, copiá la línea `download_failed` con las advertencias. El frontend no requiere cambios ni redeploy para este ajuste.

Referencias: [verificación antibot e IP bloqueada](https://github.com/yt-dlp/yt-dlp/issues/3766), [clientes de YouTube](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube), [EJS y runtimes admitidos](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

`AUTH_REQUIRED=false` deja acceso abierto por defecto. Para exigir clave más adelante, usá `AUTH_REQUIRED=true` y configurá `ACCESS_CREDENTIAL` exclusivamente en el runtime del backend; la interfaz la pedirá al conocer ese modo en `/healthz`. La clave no es necesaria y se ignora con la función apagada. `API_BASE_URL` es público y se incorpora a la construcción estática del frontend. Nunca publiques `.env` ni pongas la clave en Vercel.

## Orden de publicación

Para el cambio de sesión privada seguir el orden de [PRIVATE-SESSION.md](PRIVATE-SESSION.md): **primero acceso protegido sin cookies y calificación con datos ficticios**; después, con autorización específica, Secret File real exclusivamente en Render. El orden general siguiente describe el despliegue base sin sesión. No habilitar acceso abierto con una sesión configurada.

1. Creá dos repositorios remotos vacíos y publicá cada proyecto desde su raíz siguiendo sus respectivos READMEs.
2. Publicá la adaptación del backend y desplegá el último commit en Render. Conservá Docker y el comando del Dockerfile. Confirmá seccomp y el inicio del proxy interno; el contenedor abortará si no puede instalar la protección. Completá las comprobaciones de DNS, redirecciones, aislamiento, recursos y limpieza.
3. Configurá el backend con `AUTH_REQUIRED=false`, el origen del frontend y `/healthz`. Solo configurá una clave si activás el control de acceso. Conservá el puerto proporcionado por el host y el entrypoint del Dockerfile.
4. Importá exclusivamente el repositorio del frontend en Vercel, preset Other, Node 22+, `npm run build`, salida `dist`, `API_BASE_URL` apuntando a la API HTTPS validada.
5. Confirmá el dominio final del frontend y actualizá la lista exacta de orígenes en el backend.
6. Completá el recorrido de abajo antes de declarar listo el despliegue. Registrá limitaciones reales en este documento y ajustá los límites según la medición.

Los despliegues usan sus propias conexiones Git y no necesitan acceder a archivos del otro proyecto. El frontend no utiliza Docker; el backend no utiliza Vercel para procesar medios.

## Versiones y reversión

- Un cambio visual del frontend se publica y revierte desde Vercel sin reiniciar el backend.
- Un cambio compatible de API se publica y revierte desde el host del backend sin construir el frontend.
- Un cambio de origen de API requiere reconstruir el frontend. Rotar la clave requiere actualizar el backend e ingresarla de nuevo en la interfaz.
- La interfaz usa `/healthz`, `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/ticket` y entrega por permiso temporal. Una versión integrada anterior que espera `downloadUrl` permanente no es compatible con este contrato. Conservá versiones compatibles al revertir; coordiná cambios de contrato.
- Una reversión o publicación del backend puede perder trabajos y archivos temporales. La interfaz debe informar esa interrupción; no restaurará archivos con el rollback.

## Recorrido de validación pendiente

Este listado todavía no se ejecutó en los despliegues. No sustituye la validación del host ni afirma que una descarga real haya funcionado.

1. Abrir el frontend; comprobar que sus recursos cargan desde Vercel y las peticiones de API van al origen configurado.
2. Con `AUTH_REQUIRED=false`, comprobar que el campo está oculto y se puede descargar sin enviar clave. Después activar `AUTH_REQUIRED=true`, configurar una clave y reiniciar: comprobar que aparece el campo, una clave inválida es rechazada y la correcta permite continuar. Repetir rechazos hasta observar el límite y su vencimiento. Activarlo sin una clave válida debe impedir el inicio de la API.
3. Verificar preflight y operaciones desde un origen permitido; comprobar ausencia de permiso CORS y rechazo desde otro origen.
4. Preparar un video pequeño, observar avance y cancelar; comprobar que se detiene y limpia archivos.
5. Preparar un video y un audio pequeños completos; obtener un permiso (con clave únicamente si está activada), descargar con nombre/tipo correctos y sin buffering del archivo completo en JavaScript.
6. Comprobar que un permiso usado o vencido no funciona y que la clave compartida nunca aparece en la URL ni en assets.
7. Dejar dormir el backend; iniciar un intento desde el formulario. Después de un segundo debe verse **“El servicio se está preparando. Volvé a intentarlo en unos minutos.”** El enlace, formato y clave permanecen.
8. Repetir clics durante la espera: debe haber una sola petición de salud pendiente, sin trabajos nuevos. La petición no envía clave y no hay keep-alives programados.
9. Esperar la respuesta de salud: la interfaz indica disponibilidad y exige un nuevo clic para crear el trabajo. Si la respuesta original fue inmediata, crea una sola descarga desde ese intento.
10. Simular error de red, página HTML de inicio o respuesta inválida: aparece **“No pudimos conectar con el servicio. Intentá nuevamente en unos minutos.”** Con una respuesta sin completar, el máximo es dos minutos desde que se envía la petición.
11. Salir de la página o reiniciar el formulario: no deben quedar peticiones ni indicadores bloqueados.
12. Perder la respuesta de creación: no debe repetirse automáticamente el POST ni aparecer otro trabajo por despertar la API.
13. Reiniciar el backend durante un trabajo y después de preparar un archivo: se informa que el trabajo o archivo ya no está disponible y se permite una nueva descarga. Una salud correcta no debe restaurar el progreso antiguo.
14. Comprobar las cuotas de tamaño, tiempo y presupuesto temporal con la instancia seleccionada y registrar uso de RAM/CPU y el resultado para ambos formatos.

## Comprobaciones realizadas durante la implementación

### Verificación local sin cookies (5 de octubre de 2026)

Se ejecutó una suite de 33 casos sobre la imagen actual con medios sintéticos, red Docker interna, 512 MiB de RAM y 0,1 CPU: todos pasaron. Cubre aislamiento, proxy/DNS/TLS, video/audio, entrega, cancelación, cuotas, limpieza y reinicio de la API; cinco casos ejercitan el cliente con DOM simulado. También pasaron dos comprobaciones adicionales de reinicio real del contenedor y rechazo de arranque sin seccomp: **35 casos aprobados**. Pico del contenedor de la suite final: 94,96 MiB, frente a 128,08 MiB en una ejecución previa. No usa cookies personales, secretos de usuario ni servicios desplegados.

Para reproducir desde la raíz del backend:

```powershell
powershell -ExecutionPolicy Bypass -File tests/qualification/verify.ps1
```

Requiere Docker Desktop y el frontend hermano para los casos de cliente. El script incluye además rechazo del arranque sin seccomp y reinicio explícito del contenedor, guarda resultados JSON y elimina sus recursos temporales. Ver [alcance de las pruebas](tests/qualification/README.md) y [evidencia de calificación](HOST-QUALIFICATION.md).

La evidencia local no completa la calificación de Render ni demuestra que YouTube acepte su IP. Los límites de producción y el recorrido con un navegador desplegado todavía requieren verificación.

### Evidencia de etapas anteriores

- Construcción de `video-audio-dl-frontend/` desde su propia raíz con un origen HTTPS de ejemplo; genera el sitio y `config.js` sin leer archivos del backend.
- Revisión de sintaxis de la API, del cliente y de los scripts de construcción/desarrollo.
- Revisión estática de separación de rutas, configuración pública frente a claves privadas, CORS, autorizaciones, permisos y estados de conexión.
- Repositorios independientes publicados por el usuario en GitHub; frontend en Vercel según su confirmación.
- Primer backend en Render: imagen construida; arranque rechazado por el firewall según el log aportado.

La imagen original se construyó localmente tras corregir TMPDIR. La nueva imagen de proxy y aislamiento también se construyó: C compilado con advertencias tratadas como errores, checksum y versión de yt-dlp, soporte AES y revisión de sintaxis Python. En esa etapa todavía no se habían ejecutado pruebas automatizadas ni descargas con esa implementación; la sección fechada anterior incorpora la verificación local posterior. Las tareas de medición en el host y despliegue permanecen abiertas en OpenSpec.
