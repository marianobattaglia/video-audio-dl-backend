# Validación del host de backend

## Estado de esta implementación

**Pendiente; Render no está validado para uso público con este contenedor.**

Se consultaron las fuentes oficiales de Docker, Blueprints y el plan gratuito de Render durante la implementación. Confirman el despliegue desde Dockerfile, la configuración de salud y los límites de la instancia. La configuración documentada no ofrece un campo para agregar `NET_ADMIN`; esto no prueba por sí solo cuáles son las capacidades efectivas del contenedor. No se ejecutó un contenedor en Render y no hay evidencia de que se pueda instalar el firewall actual allí.

Durante la implementación inicial Docker no estaba disponible en PATH. Posteriormente se encontró Docker Desktop y se completó la construcción local de la imagen, incluida la instalación de certificados y la verificación del checksum de `yt-dlp`. Se corrigió el Dockerfile para configurar `TMPDIR` después de crear su carpeta, evitando que la instalación de paquetes use un directorio inexistente. No se ejecutó el servicio para esta comprobación, no se procesaron medios y no se midieron recursos. Los límites de 64 MB por trabajo, 192 MB temporales, 600 segundos y una descarga simultánea son un punto de partida que requiere medición.

La separación del código y su configuración no certifican la compatibilidad del host. La tarea 3.2 permanece abierta y no se habilitó ningún despliegue público.

## Protección conservada

1. La API valida HTTP/HTTPS, puertos 80/443, ausencia de credenciales y todas las direcciones obtenidas al resolver el dominio inicial.
2. Antes de iniciar la API, el entrypoint exige acceso a las tablas IPv4/IPv6 y aborta si no están disponibles.
3. Instala las reglas de salida originales que rechazan direcciones privadas, loopback, link-local, reservadas y destinos que no sean HTTP/HTTPS públicos.
4. Ejecuta Node y los procesos de descarga como el usuario `node`, sin permitirles cambiar las reglas.

El firewall actúa sobre las conexiones finales, incluso si `yt-dlp` sigue una redirección o vuelve a resolver el dominio. La validación inicial de URL no sustituye ese control. Las reglas DNS actuales contemplan el resolver de Docker `127.0.0.11`; hay que comprobar el resolver real del host además de las capacidades.

## Evidencia requerida antes de habilitar descargas públicas

Registrar por cada caso: host/plan, versión o commit del backend, fecha, configuración, resultado y registros relevantes sin claves ni permisos de descarga.

| Comprobación | Resultado esperado | Estado |
| --- | --- | --- |
| Construcción con las versiones fijadas | Imagen construida; herramientas disponibles | Construcción local completada; ejecución de herramientas y construcción en Render pendientes |
| Aplicación de `iptables` e `ip6tables` | Reglas instaladas; API inicia solo después | Pendiente |
| Inicio sin permisos de firewall | API no escucha y muestra el error de protección | Pendiente |
| Resolver DNS del host | Resolución pública funciona sin abrir el acceso a redes privadas | Pendiente |
| URL privada y loopback literal | Rechazada antes de crear un trabajo | Pendiente |
| Dominio con respuesta privada o mixta | Rechazado por la validación inicial | Pendiente |
| Redirección pública hacia loopback, privada o metadatos | La conexión final queda bloqueada | Pendiente |
| Cambio DNS después de la validación inicial | La conexión a una dirección privada queda bloqueada | Pendiente |
| IPv6 privado/reservado y variantes IPv4 mapeadas | Acceso bloqueado | Pendiente |
| Conexión HTTP/HTTPS pública | Funciona dentro de las reglas | Pendiente |
| Puertos no permitidos | Conexión bloqueada | Pendiente |
| Video y audio pequeños | Se procesan y entregan sin agotar la instancia | Pendiente |
| Trabajo que supera tamaño/tiempo | Termina con error y elimina sus temporales | Pendiente |
| Archivos terminados ocupando el presupuesto | No se admite un trabajo que excedería el margen | Pendiente |
| Reinicio durante una descarga | El navegador informa interrupción, no avance antiguo | Pendiente |

Usar dominios y endpoints de prueba controlados para redirecciones y cambios DNS; no consultar servicios privados reales del proveedor. Este documento define las comprobaciones necesarias, no indica que hayan pasado.

## Decisión de host

- Si Render pasa todas las comprobaciones, registrar los resultados y habilitar el uso personal con los límites medidos.
- Si rechaza las capacidades o no permite la política DNS/red actual, mantener el error de inicio y evaluar otro host compatible.
- Si se propone sustituir el firewall por otro mecanismo, actualizar primero el diseño OpenSpec y asegurar control de todas las conexiones, incluidas redirecciones y cambios DNS. No publicar una variante con solo validación inicial.

Referencias: [Docker en Render](https://render.com/docs/docker), [campos admitidos por Blueprints](https://render.com/docs/blueprint-spec), [restricciones del plan gratuito](https://render.com/docs/free).
