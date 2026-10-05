# Verificación local sin cookies

Desde la raíz del backend, con Docker Desktop en ejecución:

```powershell
powershell -ExecutionPolicy Bypass -File tests/qualification/verify.ps1
```

Duración aproximada: cuatro minutos más la construcción. No usa `.env`, secretos, cookies, enlaces de YouTube ni servicios desplegados. No publica puertos. Crea y elimina exclusivamente los recursos del proyecto Docker `video-audio-dl-qualification` y dos contenedores temporales con ese prefijo. Conserva la imagen local de prueba. No ejecutar dos verificaciones a la vez.

Los cinco casos de cliente necesitan el repositorio hermano `video-audio-dl-frontend/public`. Ejecutan su código real con DOM, peticiones y temporizadores simulados; no reemplazan una prueba en un navegador. El backend sigue pudiendo construirse y desplegarse sin ese repositorio.

## Alcance

- Servidor de medios sintéticos: MP4 de tres segundos con video generado y audio sinusoidal. HTTP, HTTPS con CA efímera de prueba, redirecciones, tamaños excesivos y respuestas lentas.
- Red Docker **interna**, sin salida a Internet. El rango `11.250.237.0/24` se usa solo dentro de ese espacio de red para que la política lo clasifique como público. Ninguna petición se envía a sus titulares reales. No demuestra transferencia a un sitio público desde Render.
- Backend como UID 1000, sin capacidades adicionales, `no-new-privileges`, raíz de solo lectura, 512 MiB de RAM y 0,1 CPU. El servidor de fixtures usa root únicamente para escribir el volumen de certificados de prueba y no es parte del despliegue.
- Cuotas reducidas para probar los rechazos: salida 1 MiB, presupuesto temporal 3 MiB, tiempo 30 segundos, retención 60 segundos, ticket 10 segundos. No valida cargas cercanas a los límites de producción.
- DNS mixto real en el contenedor; pinning y discrepancia de dirección efectiva mediante inyección de DNS/transporte en un proceso de prueba. No modifica los módulos de producción.
- Instalación e herencia de seccomp, sockets y descriptores heredados, proxy sin permiso/revocado, TLS y postprocesamiento local, cancelación, cuotas y limpieza.
- Parsing de los assets EJS con Node protegido: no demuestra resolución de un desafío de YouTube.
- Reinicio explícito del contenedor: pérdida de trabajos, limpieza de tmpfs y reintento. La política `unless-stopped` se comprueba como configuración; no se simula la caída/reanudación del daemon Docker ni el reinicio de Render.
- Arranque sin seccomp: contenedor sin red que debe finalizar con código 1 antes de habilitar la API. El error es el resultado esperado.

El script guarda un resumen JSON en `results-latest.json`. Los resultados de una ejecución concreta deben conservar su fecha, imagen y revisión. La RAM y CPU registradas pertenecen al contenedor completo de la suite, incluido el verificador; no son una medición aislada del servidor ni una estimación para medios grandes.

La ejecución registrada del 5 de octubre de 2026 está en [results-2026-10-05.json](results-2026-10-05.json): 33 casos de suite y dos comprobaciones adicionales aprobadas. El informe no contiene cookies, claves reales ni diagnósticos de usuarios.

Las pruebas no consultan destinos privados reales. Una prueba fallida debe investigarse; no se deben desactivar las protecciones para que pase.
