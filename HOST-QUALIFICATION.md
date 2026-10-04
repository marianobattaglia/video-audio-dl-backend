# Validación del host de backend

## Evidencia y estado

El usuario publicó ambos repositorios en GitHub y confirmó el frontend funcionando en Vercel. El primer despliegue del backend en Render construyó y publicó la imagen, pero al arrancar registró:

```text
Cannot enforce outbound destination restrictions. This host must support IPv4/IPv6 firewall rules and NET_ADMIN; public deployment is not qualified. The API will not start.
Exited with status 1
```

El resultado rechaza el mecanismo anterior en esta instancia. El usuario autorizó sustituirlo por un proxy interno y un aislamiento seccomp sin privilegios.

La nueva imagen se construyó localmente: C compilado con advertencias tratadas como errores, checksum y versión del wheel oficial de yt-dlp comprobados, soporte AES presente y sintaxis Python revisada. **Su arranque y sus descargas en Render todavía están pendientes.** No se ejecutaron pruebas automatizadas ni descargas con esta implementación. La tarea 3.2 permanece abierta.

## Protección implementada

1. La API valida una URL inicial HTTP/HTTPS pública, en 80/443, sin credenciales.
2. Antes de escuchar, comprueba que seccomp puede instalarse con no_new_privs y que las herramientas se ejecutan bajo el filtro.
3. Cada descargador instala el filtro antes de yt-dlp. Solo permite sockets Unix; bloquea sockets de Internet y otros dominios de sockets, io_uring, ptrace, acceso a memoria de otros procesos y obtención de sus descriptores. Comprueba la arquitectura y rechaza ABI alternativos.
4. Cierra previamente los descriptores heredados, salvo stdin/stdout/stderr. El filtro se hereda por fork/exec, incluyendo FFmpeg y FFprobe; no hay una opción para omitirlo.
5. El adaptador dirige el proxy HTTP de yt-dlp por un socket Unix privado con permiso aleatorio por trabajo. No se expone ningún puerto TCP de proxy. Plugins, JavaScript y componentes remotos están desactivados.
6. El proxy comprueba todas las IP de cada nuevo destino y rechaza IP privadas, reservadas, mapeadas o respuestas mixtas. Conecta a una IP literal comprobada sin segunda resolución y comprueba la dirección efectiva.
7. HTTP usa puerto 80 y HTTPS usa CONNECT a 443. Las redirecciones y segmentos requieren nuevas comprobaciones. TLS sigue verificándose en yt-dlp contra el sitio original, sin interceptar certificados.
8. Se limita la espera DNS/conexión y se revoca el permiso y sus conexiones al finalizar, cancelar, superar los límites o apagar la API.

La seguridad no depende exclusivamente de validar la URL inicial ni de que cada extractor respete voluntariamente el proxy: los sockets directos del descargador y de sus hijos quedan bloqueados por el filtro.

## Compatibilidad

El descargador nativo transfiere HTTP/HTTPS y FFmpeg une, convierte y remuxea archivos locales. Las rutas que necesitan descarga directa de FFmpeg, otros protocolos, plugins o runtimes externos se rechazan. No se promete compatibilidad con todos los sitios o transmisiones en vivo. Los lanzadores originales de terminal permanecen separados de la API.

## Comprobaciones pendientes en el nuevo despliegue

Registrar host/plan, commit, fecha, resultado y registros sin claves ni permisos. Usar destinos controlados para redirecciones/DNS, sin consultar servicios privados reales.

| Comprobación | Resultado esperado | Estado |
| --- | --- | --- |
| Construcción de la imagen adaptada | Compilación, checksum, versión y dependencias correctos | Local completada; Render pendiente |
| Usuario y capacidades | API como node, sin NET_ADMIN ni permisos extra | Configuración presente; ejecución pendiente |
| Arranque protegido | Seccomp y herramientas disponibles; proxy listo antes de escuchar | Pendiente |
| Inicio sin seccomp | API no escucha; error de aislamiento | Pendiente |
| Sockets directos y heredados | IPv4, IPv6, UDP y vías alternativas rechazadas | Pendiente |
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
