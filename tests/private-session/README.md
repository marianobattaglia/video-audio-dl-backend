# Verificación local de sesión privada

Todos los datos son ficticios. No se leen perfiles del navegador, no se consulta YouTube ni se utilizan credenciales reales. Requiere Docker Desktop Linux, Node 22 y el frontend hermano para probar su código.

Desde la raíz del backend:

```powershell
powershell -ExecutionPolicy Bypass -File tests/private-session/verify.ps1
```

El script construye el backend, ejecuta la suite privada y las 33 regresiones sin cookies, audita Git/contexto/capas Docker y builds estáticos, guarda `results-latest.json` (ignorado) y elimina sus contenedores/redes/volúmenes. No modifica el contenedor local normal del usuario. La auditoría restaura `dist` con API local `http://localhost:3000` y elimina exclusivamente sus marcadores y carpeta temporal.

La suite privada usa una fuente Netscape generada en runtime en un volumen externo de solo lectura y claves aleatorias generadas por el verificador. La red Docker interna `11.250.238.0/24` no tiene salida a Internet. `bootstrap.cjs` inyecta DNS, downloader y fallos **solo en procesos de prueba**. El API, lanzador seccomp, permisos, FFmpeg, contratos y validación de salida son reales; las transferencias autenticadas de YouTube son simuladas. `policy.py` prueba el jar exacto de yt-dlp y su manejo de redirecciones mediante requests/responses simuladas bajo el filtro real.

Casos: matriz de arranque/autorización, fuente/normalización/permisos, presupuesto, selección HTTPS de YouTube, cookies nuevas y alcance host/domain/path/expiración, argumentos/entorno, buffers/logs/nombres, archivos maliciosos/tickets, cancelación/timeout/descendientes, borrado fallido, shutdown y huérfanos al reiniciar. Dos pruebas VM del cliente comprueban memoria, eliminación del storage heredado y Authorization. La regresión adicional ejercita transferencias controladas HTTP/HTTPS con yt-dlp real, TLS inválido, DNS/peer/proxy, aislamiento heredado y cuotas.

## Recorrido de navegador separado

El script principal no automatiza un navegador. Para el recorrido local, construir el frontend con `API_BASE_URL=http://localhost:43001` y `build({local:true})`, ejecutar `node tests/private-session/browser-server.cjs`, y habilitar el fixture:

```powershell
docker compose -p video-audio-dl-private-session-tests -f tests/private-session/compose.yaml --profile browser up -d browser-api
```

Abrir `http://localhost:43000`. Credencial **exclusivamente ficticia del fixture**: `synthetic-browser-access-123456789`; fuente generada por `fixture.cjs`. Usar `https://www.youtube.com/watch?v=complete` para completar o `?v=slow` para progreso/cancelación. El hostname es redirigido por el fixture: no sale tráfico a YouTube. `/probe-csp` verifica una conexión al propio origen permitida y otro HTTPS bloqueado con CSP generada + cabeceras reales de Vercel. No desactivar CSP/TLS para el recorrido.

Solo `browser-api` agrega una red puente para publicar su puerto en **127.0.0.1:43001**; suite principal y medios siguen en la red interna. Seccomp y controles del API permanecen activos. No implica calificación de Vercel/HTTPS en producción. Variantes propias del fixture: `PRIVATE_SESSION_BROWSER_AUTH=false` y `PRIVATE_SESSION_BROWSER_COOKIES=disabled` para abierto sin sesión; `PRIVATE_SESSION_BROWSER_AUTH=true` con `PRIVATE_SESSION_BROWSER_COOKIES=disabled` para protegido sin sesión. El lanzador de prueba convierte `disabled` en ruta vacía; producción no reconoce ese valor. `PRIVATE_SESSION_BROWSER_HEALTH_DELAY=10000` demora solo la primera salud del navegador para observar el mensaje de despertar y reintento manual. Recrear solo el fixture y recargar entre variantes; retirar esas variables al terminar. Nunca usar estos valores para un despliegue real.

## Evidencia y limitaciones

Los resultados fechados incluidos registran solo verificaciones efectivamente terminadas. Los fallos iniciales encontraron una remuxeada MP4 aplicada indebidamente a audio; se corrigió el API para aplicar esa opción solo a video. También se corrigieron dos detalles del harness: esperar el cierre de un proceso ya terminado y colisión de IP entre fixture de navegador y verificador. Ningún arreglo reduce protecciones de producción.

Estas pruebas no garantizan que Render acepte el aislamiento, que el solver resuelva desafíos reales, ni que YouTube acepte cookies/IP del proveedor. Fuente y copias no se guardan en la imagen. Los recursos medidos son de medios sintéticos pequeños y del verificador completo. Tareas de despliegue y sesión real siguen pendientes; el cambio de separación conserva sus propias tareas abiertas.
