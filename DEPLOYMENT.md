# Conectar y publicar los dos proyectos

## Estado

El código está separado en dos proyectos autónomos y dos repositorios Git locales. Todavía no hay remotos Git configurados, servicios creados ni dominios reales. La compatibilidad del backend con Render y el recorrido desplegado completo están pendientes. Ver [HOST-QUALIFICATION.md](HOST-QUALIFICATION.md).

Los proyectos son carpetas hermanas: `video-audio-dl-frontend/` y `video-audio-dl-backend/`. Cada una tiene su propio `.git`, README y configuración. Publicá cada raíz en un remoto distinto con el mismo nombre que su proyecto. La carpeta contenedora conserva OpenSpec y no es un repositorio Git. Podés mantener ambas copias de trabajo en ubicaciones distintas.

## Configuración por entorno

| Entorno | Frontend: `API_BASE_URL` | Backend: `FRONTEND_ORIGINS` |
| --- | --- | --- |
| Local | `http://localhost:3000` mediante `npm run dev` | `http://localhost:5173` |
| Producción | `https://TU_BACKEND.onrender.com` o el origen del host validado | `https://TU_FRONTEND.vercel.app` o tu dominio final |
| Preview | Origen HTTPS de una API de pruebas | Origen exacto de ese preview o dominio estable de pruebas |

Son ejemplos; reemplazalos por los valores reales. No incluyas rutas ni barras finales. En el backend, separá varios orígenes con comas. Si cambiás un dominio, ajustá ambos lados. No uses wildcards para previews.

`AUTH_REQUIRED=false` deja acceso abierto por defecto. Para exigir clave más adelante, usá `AUTH_REQUIRED=true` y configurá `ACCESS_CREDENTIAL` exclusivamente en el runtime del backend; la interfaz la pedirá al conocer ese modo en `/healthz`. La clave no es necesaria y se ignora con la función apagada. `API_BASE_URL` es público y se incorpora a la construcción estática del frontend. Nunca publiques `.env` ni pongas la clave en Vercel.

## Orden de publicación

1. Creá dos repositorios remotos vacíos y publicá cada proyecto desde su raíz siguiendo sus respectivos READMEs.
2. Completá la validación del host Docker del backend, incluidos firewall, resolver DNS, recursos y limpieza. El contenedor abortará si no puede instalar las reglas.
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

- Construcción de `video-audio-dl-frontend/` desde su propia raíz con un origen HTTPS de ejemplo; genera el sitio y `config.js` sin leer archivos del backend.
- Revisión de sintaxis de la API, del cliente y de los scripts de construcción/desarrollo.
- Revisión estática de separación de rutas, configuración pública frente a claves privadas, CORS, autorizaciones, permisos y estados de conexión.
- Inicialización independiente de Git en ambas raíces. No hay commits, remotos ni publicaciones realizados.

La imagen Docker también se construyó localmente tras corregir la configuración prematura de `TMPDIR`; la instalación de certificados finalizó correctamente. No se ejecutaron pruebas automatizadas, el recorrido del navegador, el servicio Docker ni conversiones reales para esa comprobación. Las tareas que dependen de mediciones o despliegues permanecen abiertas en OpenSpec.
