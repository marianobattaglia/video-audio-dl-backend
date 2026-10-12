# Playlists de YouTube y YouTube Music

Una canción con parámetros `list` continúa por la descarga individual. Un enlace directo a una playlist fija usa vista previa y selección. Mixes dinámicos y canales no están admitidos.

## Límites y conservación

| Recurso | Límite |
| --- | --- |
| Vista previa | Páginas de 50 posiciones; una entrada de lookahead para detectar continuación, sin máximo fijo de páginas |
| Selección | No vacía, sin máximo fijo de canciones; posiciones distintas entre páginas de la misma lista, en orden; audio o video por tanda |
| Preparación | Una por tanda y concurrencia global configurada, compartida con previews e individuales |
| Medios sin consumir | Hasta dos por tanda, contando transferencias, espera de confirmación y append; los modos nuevos consumen uno antes del siguiente |
| ZIP | Comparte `MAX_TEMP_MB`; staging reserva la copia nueva además de la fuente y el ZIP anterior, sin tope de canciones |
| Plazos de ZIP | `MAX_ZIP_BATCH_SECONDS=3600` desde el primer medio, incluyendo pausas; `MAX_ARCHIVE_OPERATION_SECONDS=120` por operación |
| Retención del ZIP | `JOB_TTL_SECONDS` desde finalización; un parcial interrumpido queda acotado desde la interrupción; polling no extiende bytes |
| Guardado automático | Dos minutos por transferencia/escritura; confirmación después de cerrar el writable; salida retenida hasta ACK o TTL original |
| Consulta de metadata | 45 segundos; stdout 256 KiB; cliente 60 segundos |
| Previews | Tres consultas nuevas por dirección/ventana `RATE_WINDOW_SECONDS` (60 segundos por defecto); páginas ya leídas se sirven sin consumir cuota ni lanzar extractor |
| Registros de selección | Cinco creaciones por dirección por ventana |
| Snapshots | Hasta 20 en memoria; 10 minutos de inactividad; navegación renueva snapshot, no medios |
| Metadata retenida | Presupuesto global de 8 MiB para previews/tandas/historial; capacidad explícita sin truncar selecciones |
| JSON de selección | Hasta 256 KiB; otros inputs conservan 8 KiB |
| Tandas | Hasta 20 en memoria; inactividad 15 minutos; se conserva trabajo/entrega activos |
| Historial de idempotencia | Hasta 32 intentos por fila; cargar otra lista si se agota |
| Medios y permisos | Mismos `JOB_TTL_SECONDS`, tamaños y permisos de un solo uso que la descarga individual |

Previews y registros no consumen `JOB_CREATE_LIMIT`; cada intento nuevo de preparación sí. Repetir el mismo `attemptId` reutiliza el resultado sin lanzar otro proceso ni consumir esa cuota. Un rechazo queda asociado al intento, salvo el literal `E_MEDIA_ADMISSION_RATE`, que garantiza que no se llamó al creador de medios y permite reutilizar el mismo UUID después de `Retry-After`. Automático/ZIP esperan como máximo dos veces con un único timer cancelable; otros errores y resultados inciertos requieren continuación manual. La retención del archivo no se extiende al consultar una tanda.

## Contrato aditivo

Todas las rutas siguientes usan la autorización y CORS existentes. Si hay cookies, `AUTH_REQUIRED=true` es obligatorio. No aceptan cookies, rutas ni opciones de yt-dlp del cliente.

| Método y ruta | Entrada | Resultado |
| --- | --- | --- |
| `POST /api/playlists/preview` | `{url}` o `{previewId,pageToken}` | Página con identidades estables, posiciones absolutas, títulos/duración, vigencia y tokens anterior/siguiente |
| `POST /api/playlist-batches` | `{previewId,entryIds,kind,deliveryMode?}` | 201; selección/formato/modo inmutables, sin medios; manual por defecto |
| `GET /api/playlist-batches/:id` | — | Filas con estados, avances, razones seguras y trabajos individuales asociados |
| `POST /api/playlist-batches/:id/items/:entryId/start` | `{attemptId}` UUID | 202; inicio atómico o resultado del mismo intento |
| `DELETE /api/playlist-batches/:id` | — | Detiene activo/pendientes; conserva archivos listos hasta su vencimiento |
| `DELETE /api/playlist-batches/:id?discard=true` | — | Cancela y elimina archivos no entregados; una entrega abierta conserva su descriptor |

La preview anuncia `limits.deliveryModes=["manual","automatic","zip"]`; su ausencia significa solo Manual. `/healthz` conserva su contrato. Los individuales y Manual se entregan mediante `/api/jobs/:id/ticket` y `/api/jobs/:id/file`. Esas rutas rechazan medios de otros modos. El endpoint individual rechaza playlists completas; la guardia Python rechaza resultados `playlist` y `multi_video` antes de recorrerlos. No basta con `--no-playlist`.

### Transferencia automática y ZIP

Todas las rutas POST usan autorización y validación exacta de campos. Los GET de archivo usan tickets de un solo uso exclusivos de su tipo; los tres tipos no se intercambian.

| Método y sufijo bajo `/api/playlist-batches/:id` | Entrada | Resultado |
| --- | --- | --- |
| `POST /items/:entryId/transfer-ticket` | `{jobId}` | Ticket automático y `deliveryId` ligados al resultado actual |
| `GET /items/:entryId/file?ticket=...` | Ticket automático | Stream de medio validado; terminar HTTP no elimina la salida |
| `POST /items/:entryId/save-confirmation` | `{jobId,deliveryId}` | ACK idempotente; limpia solo esa salida; recibo conservado después del barrido del job |
| `POST /archive/append` | `{entryId,jobId,attemptId}` | Incorpora una posición validada; repetición devuelve el commit existente |
| `POST /archive/finalize` | `{allowPartial}` boolean | Sella paquete completo o parcial explícito; rechaza vacío/en escritura |
| `POST /archive/ticket` | `{}` | Ticket del ZIP finalizado y validado |
| `GET /archive/file?ticket=...` | Ticket de archivo | Descarga nativa `application/zip`, nombre y tamaño verificados |

El helper Python `archive-worker.py` usa `ZIP_STORED`, buffers de 64 KiB y sandbox sin red ni proxy. Recibe por stdin los bytes de descriptores validados, no rutas del cliente; crea staging exclusivo bajo el UUID de tanda, valida tipos, tamaños, miembros únicos y CRC antes de reemplazar el ZIP. El servidor conserva una identidad y hash para revalidar el paquete con `archive-output.js` antes de servirlo. `openMedia` sigue aceptando únicamente MP3/MP4.

Solo entran los medios seleccionados y `resultado.txt` generado con título/posición/estado permitido. No se recorren directorios ni se incluyen jars, source Secret File, headers, flags, stderr o credenciales. La fuente se elimina después del commit; si falla el worker o falta espacio, se conserva el ZIP anterior y el medio, y se pausa. Por el costo de staging, el ZIP máximo efectivo es menor que el espacio total. No se crean paquetes adicionales silenciosamente. Reiniciar/redeployar pierde todo y barre huérfanos antes de salud.

Solo se conserva metadata permitida. Las URLs de cada medio se construyen con IDs validados y el host de la playlist, conservando YouTube Music. No se envían headers, thumbnails, URLs arbitrarias del extractor ni salida cruda. La copia privada de cookies de cada preview se elimina antes de responder. Procesos y descendientes usan el sandbox y proxy existentes, sin excepciones de red.

## Uso y errores

El navegador controla la cola durante la sesión de página. Manual necesita un clic por archivo. Automático solicita una carpeta compatible desde un gesto real antes de salud/medios, crea nombres únicos sin sobrescribir y guarda por streaming: close, ACK y recién el siguiente medio. No usa Blob completo, clics simulados ni storage de permisos/rutas. Si el ACK se pierde, conserva el hecho local y repite solo la confirmación; si el backend perdió la tanda, informa que el archivo local sigue guardado y detiene la cola. ZIP agrega cada resultado antes del siguiente y ofrece un enlace nativo único al finalizar.

Un fallo específico de una canción permite avanzar; antibot, sesión inválida, autorización, red, escritura o archivo incierto pausa la tanda. Una creación de resultado incierto se comprueba antes de continuar y no se repite sola. Una posición duplicada del mismo video sigue siendo una selección independiente. **Pausar** permite terminar un consumo acotado y evita el siguiente; **Cancelar** lo interrumpe. **Finalizar ZIP parcial** exige una acción explícita cuando quedan pendientes por cancelación/capacidad/plazo: conserva el paquete validado, detiene las pendientes y libera los medios preparados que no se incorporarán antes de reservar el staging final. Descartar nunca borra archivos locales guardados o preexistentes.

**Cargar más** consulta la siguiente página de la lista; **Anterior** vuelve a una página cacheada. Las seleccionadas se conservan entre páginas. **Seleccionar página** agrega todas las disponibles de la página y **Quitar selección de página** solo retira esas posiciones. No hay máximo fijo por tanda ni recorte definitivo a 50 canciones. Los presupuestos de memoria/tiempo/bytes y el fin o rechazo del origen siguen aplicando. Ante un fallo de página se conserva selección/página actual y **Continuar / Comprobar estado** reintenta el mismo token; no inicia una lista nueva. No aceptar tokens de otro snapshot, offsets ni flags del caller.

Cancelar permite guardar los archivos listos. Descartar vuelve al formulario y elimina los archivos restantes. Reiniciar/dormir el backend pierde snapshots y trabajos; la página pide cargar la lista otra vez. La disponibilidad en preview no garantiza que YouTube permita descargar el medio.

## Publicación y rollback

1. Desde la raíz del backend, construir el Dockerfile con los módulos de playlist y la guardia Python incluidos. Conservar la configuración privada de sesión y el entrypoint.
2. Publicar primero el backend. Comprobar salud, descarga individual y rechazo de playlist en `/api/jobs` antes de publicar el frontend.
3. Publicar el frontend con la misma `API_BASE_URL`. No hay nuevas variables públicas ni secretos de Vercel.
4. Comprobar listas pequeñas de YouTube y Music en ambos formatos y los tres modos: permisos/stream/ACK, ZIP completo/parcial, pausa/cancelación, expiración y despertar.

Para revertir, detener las tandas nuevas y publicar primero el frontend manual anterior; después el backend compatible. Un backend sin capacidades nuevas hace que el cliente ofrezca solamente Manual. Si tampoco tiene playlists, el cliente informa incompatibilidad y nunca envía esas URLs a `/api/jobs`. No desactivar autorización para revertir una sesión privada.

## Verificación reproducible

`tests/private-session/verify.ps1` ejecuta regresiones, matrices sintéticas de playlists/modos, auditoría de imágenes y build estático. `node tests/playlists/unit.cjs` comprueba almacén/clasificación/recibos; `node tests/playlists/frontend.cjs` ejecuta el controlador real con DOM/red/reloj simulados; `node tests/playlists/directory.cjs` verifica streaming/cleanup con File System Access simulado. El recorrido de navegador y la publicación real se documentan por separado.

La evidencia local usa destinos controlados, cookies y claves ficticias, 512 MiB y 0,1 CPU. No demuestra que YouTube acepte una IP de Render ni completa las comprobaciones de host pendientes de cambios archivados.
