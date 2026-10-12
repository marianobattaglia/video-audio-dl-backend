# Evidencia local: guardado automático y ZIP

Fecha: 12 de octubre de 2026. Implementación local sin commit ni despliegue de esta feature. Complementa `evidence-2026-10-12.md`; las comprobaciones anteriores de entrega manual no califican por sí solas los modos nuevos.

## Alcance y privacidad

Las suites usan exclusivamente clave, cookies, TLS, DNS, metadata y medios ficticios/controlados. No se leyeron cookies ni claves reales del operador. La prueba de navegador usa los puertos locales 43000/43001 y un backend ficticio independiente del servicio de Render. No publicar permisos de descarga, contenidos de jars, headers, rutas de carpetas locales ni logs crudos.

La implementación agrega modo inmutable manual/automatic/zip, tickets separados, confirmación de guardado, recibos que sobreviven al barrido del job, helper ZIP_STORED por stdin desde descriptores validados, staging/reemplazo y presupuestos compartidos. El contrato individual, su entrega nativa y `/healthz` se conservan.

## Comprobaciones de modos

La matriz Docker ampliada pasó **13/13** en una ejecución independiente de la revisión corregida. Incluye:

- Autorización independiente de Origin, rechazo de campos/rutas ajenos y tickets no intercambiables.
- MP3/MP4 automáticos retenidos después de HTTP, nueva transferencia explícita, rechazo de confirmación vieja, ACK repetido y limpieza del resultado vinculado.
- MP3/MP4 en ZIP, append/finalize idempotentes, posiciones repetidas del mismo video con nombres distintos, resumen permitido, CRC y ZIP_STORED.
- Fallo de worker con rollback, archivo anterior y fuente preservados, staging eliminado y reintento sin duplicados.
- Fallo específico de una canción y paquete parcial explícito.
- Pico de espacio compartido: rechaza el siguiente append sin consumir la fuente; finalizar parcial libera los medios no incorporados y permite sellar el paquete anterior.
- Paquete alterado/symlink rechazado, original ficticio intacto.
- Modo abierto sin sesión, worker acotado y cancelación con admisión compartida, deadline total incluyendo pausas, ticket vencido/renovado sin extender retención y reinicio que pierde el archivo anterior.

Recursos de esa ejecución: 512 MiB / 0,1 CPU; pico medido del contenedor **81.256.448 bytes**, sin OOM; `cpu.max=10000 100000`. Son fixtures pequeños y pruebas locales, no una medición de capacidad ni disponibilidad de Render.

También pasan: **21/21** de store/clasificación/recibos/deadlines/nombres, **17/17** del controlador real con DOM/red/reloj simulados y **5/5** del saver real con File System Access simulado. Los casos simulados cubren cierre antes del ACK, confirmación perdida sin volver a guardar, permiso denegado, escritura/stream truncado/cancelación/deadline, nombres Unicode, archivos previos preservados, pausa, máximo de dos esperas por admisión conocida y respuesta tardía tras cancelación que no bloquea otra tanda. Un reintento explícito puede reactivar un parcial recuperable, conservando su deadline original; una consulta o un rechazo de admisión no renueva su retención.

El helper Python también pasó una comprobación real bajo seccomp y `network none`: sockets IPv4/IPv6 bloqueados, encuadre acotado, nombres peligrosos rechazados, firma de medio, bytes/truncamiento, tamaño e integridad ZIP. No se relajó `openMedia` ni el sandbox.

## Recorrido real y confirmación del operador

- Navegador integrado: playlist ficticia de 123 posiciones, selección de **1/2/3/51/52/53**, MP3 y modo ZIP. Conservó selección entre páginas y mostró las seis filas incorporadas. Un clic nativo terminó con **«El ZIP fue entregado al navegador»**. La captura muestra el resultado sin valores de claves. La espera del evento de descarga del adaptador del navegador venció; no se obtuvo una ruta del archivo guardado y no se declara inspección de ese ZIP en el disco del navegador. La integridad/miembros se comprobaron separadamente por API.
- El intento de elegir carpeta desde el navegador integrado terminó rechazado, sin iniciar medios. La apertura del panel estaba encolada y el operador no veía el selector. No se trató ese intento como una prueba exitosa.
- El operador abrió la página local en **Chrome**, usó la sesión ficticia, eligió las dos primeras canciones en Audio/Automático y confirmó **«Se guardaron ambos MP3»**. Es evidencia reportada por el operador; no se inspeccionó su carpeta ni se registró su ruta.

Todavía falta el recorrido extendido de 5.4/7.12: más de cinco posiciones en todos los modos y ambos formatos, revocación de permiso durante la escritura, resultados locales preexistentes, recuperación/expiración/respuesta perdida en navegador, ZIP parcial y cancelación, y backend anterior. Las pruebas simuladas no sustituyen esos casos.

## Histórico de regresión y correcciones

La primera pasada completa con los modos iniciales terminó con salida 0: sesión privada 47/47, sin cookies/red/individual/tickets 39/39, playlists 17/17 y modos 10/10; se amplió posteriormente la matriz. Su imagen de suites era distinta de la reconstruida al final porque hubo cambios durante la revisión; no califica la última revisión.

La siguiente regresión pasó sesión privada, red e individuales y playlists, pero se detuvo en modos: **12/13**, con el caso de deadline/cancelación devolviendo 500 en vez del 422 esperado. Al matar un worker, el pipe podía rechazar con EPIPE antes de recibirse su resultado de salida. Se normalizó ese fallo a error recuperable de archivo; se conservan paquete previo/fuente y cleanup. La matriz independiente posterior pasó 13/13.

Se corrigió además el caso de capacidad que retenía una fuente no incorporada y podía impedir finalizar el parcial. La acción explícita ahora valida primero el paquete comprometido y libera esos resultados dentro del bloqueo de finalización, antes de reservar staging.

## Regresión final

`tests/private-session/verify.ps1` terminó con **salida 0**, registrada **2026-10-12T23:46:29Z**:

| Suite/comprobación | Resultado |
| --- | --- |
| Sesión privada | 47/47 |
| Sin cookies, red, individual y tickets | 39/39 |
| API de playlists y CLI fijada | 17/17 |
| Modos nuevos, rollback/capacidad/deadlines/shutdown | 14/14 |
| Store, recibos y reloj/nombres | 21/21 |
| Controlador real con DOM/red/reloj simulados | 17/17 |
| Saver real con File System Access simulado | 5/5 |
| Servidor de desarrollo real y scripts | Pasa |
| Guardia real de medio único y worker ZIP bajo seccomp | Pasan |
| Rechazo de arranque sin sandbox y reinicio de contenedor | Pasan |
| Contexto, metadata y capas Docker | Pasa: 13 capas, 12051 archivos |
| Build estático público, CSP/HTTPS/loopback | Pasa |

La matriz final de modos midió **60.944.384 bytes** de pico del contenedor, sin OOM, bajo `cpu.max=10000 100000`. El caso nuevo de shutdown espera un PID distinto del worker anterior, verifica entorno sin clave/source env, lo detiene y comprueba staging eliminado y paquete transitorio barrido antes de readiness del reinicio.

Revisión Git de base: `0e11a7a74703b112fb91fbaf9777eb85c85e12cf`; **worktree dirty**, no es un commit desplegado de esta feature. Imagen de suites registrada: `sha256:3ff4629763b10c5c5a9b328f78cdfdf90a963287c6ab1d7c1a0468762d83c4e2`. Imagen reconstruida/auditada al terminar: `sha256:f0337af765bef50df7e736c7a329bc91f13761250ffdde9460574c8a101859ae`. El identificador inicial no quedó disponible después del reemplazo de tags de la reconstrucción; no se presenta como imagen recuperable. Se conservan resultados/hashes locales y la imagen final auditada.

Hashes SHA-256 de la revisión final:

| Archivo | SHA-256 |
| --- | --- |
| `server.js` | `3723759e9b2f7d61dabd5b9d41a8cc7dcd8a16b95efc4bc145d241ca4fe81e9f` |
| `playlist-archive.js` | `aae7a3b9f82cae6780525b9d07ebd9f4f5d82f4fb4b46fd6a667e24a2306ab82` |
| `automatic-delivery.js` | `8c74d84d9333d9e2d9410c84e308800b29b82ea65ca79a15783a8ca632fe15fd` |
| `archive-output.js` | `0109e47bce6c6253f975dcd269d9f90dedcc1f5cb81a9f1b099ef9cefa45fbd9` |
| `archive-worker.py` | `86a0b5d2d53c9847d578d93faf9f587b7053c87b25f3c25b61c3998d4e397009` |
| Frontend `playlist-controller.js` | `3b0b50a62c4ae41a2ef129583dfabd9947122cee226afba95b6eaeec14165e40` |
| Frontend `directory-saver.js` | `2b470076b87072958cc1ca25040b2e17040587cbafd7472852ec589fc3fdd348` |

El reporte local detallado es `tests/private-session/results-latest.json`; esta evidencia separa fixtures/simulaciones, navegador integrado y confirmación del operador. Las tareas 5.4/7.12 de navegador extendido y 6.2/6.3 de host permanecen pendientes. No se reabren ni se declaran realizadas las calificaciones archivadas.
