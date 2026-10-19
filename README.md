# Pi-Chico

Agente de programación de terminal para **macOS y Linux** con Node.js 22+, ES Modules y **cero dependencias npm**. Todo el núcleo está en `agent.mjs` (menos de 400 líneas): habla con un **llama-server** (llama.cpp) por HTTP, con streaming y tool calling estructurado, para leer, escribir, editar y ejecutar comandos. No interpreta llamadas escondidas en texto libre.

Tú inicias el servidor del modelo por tu lado; Pi-Chico solo se conecta a él. No gestiona modelos ni proveedores.

## Inicio rápido

1. Arranca tu servidor con `--jinja` (necesario para tool calling) y espera `HTTP server listening`. Por ejemplo:

```sh
llama-server -m modelo.gguf --jinja --host 127.0.0.1 --port 8080
```

2. Desde Pi-Chico:

```sh
node agent.mjs                                           # http://127.0.0.1:8080, proyecto = directorio actual
node agent.mjs --host http://127.0.0.1:8081 --project ~/mi-proyecto
npm start -- --project ~/mi-proyecto
```

Se usa el modelo que tenga cargado el servidor; no se envía ni se elige nombre de modelo. Para cambiar de modelo, reinicia el servidor.

## Arquitectura

1. La CLI añade la tarea al historial.
2. `Backend.chat` envía el historial y los esquemas JSON de las herramientas; transmite el texto a la terminal y acumula las tool calls (SSE, argumentos JSON fragmentados).
3. `runTask` añade el mensaje del asistente y recorre sus llamadas en orden.
4. `Workspace.execute` valida nombre y argumentos contra el registro, ejecuta la herramienta y siempre devuelve un resultado, también si falla o se rechaza.
5. El ciclo continúa hasta una respuesta sin herramientas o el límite de iteraciones.

**Registros en lugar de condicionales.** `toolSpecs` define cada herramienta una sola vez (descripción, esquema y ejecutor) y de ahí salen tanto los esquemas enviados al modelo como la validación y el despacho. Los comandos de la CLI son igualmente un objeto `commands`, del que se genera también `/help`. Añadir una herramienta o un comando es añadir una entrada, sin tocar el motor.

## Herramientas y permisos

| Herramienta | Función |
| --- | --- |
| `read` | Lee texto con números de línea (`start`, `lines`; 200 por defecto, máximo 300) o lista un directorio. |
| `write` | Crea o sobrescribe texto. Muestra el contenido y pide aprobación. |
| `edit` | Reemplaza una única coincidencia exacta. Rechaza búsquedas vacías, ausentes o ambiguas. |
| `bash` | Ejecuta con `/bin/sh -c` desde el proyecto. Devuelve stdout, stderr y código. |

Escribe `s` para aprobar cada cambio o comando; cualquier otra respuesta lo rechaza. **Todos los comandos requieren aprobación**, porque una lista de patrones no identifica de forma fiable los peligros de un shell. En modo `--prompt` o si stdin no es una terminal interactiva, los cambios y comandos se rechazan. Las lecturas no piden confirmación. Al pedir aprobación se descarta la entrada adelantada.

Protecciones de archivos:

- Se rechazan `..`, rutas externas, enlaces simbólicos externos, binarios, UTF-8 inválido y archivos mayores de 1 MiB.
- Se bloquean nombres habituales de credenciales (`.env`, claves privadas, `credentials.json`…).
- Se detecta si el archivo cambió durante la aprobación y no se sobrescriben enlaces simbólicos.
- La escritura es atómica (temporal + `rename`/`link`), conserva enlaces duros ajenos, bits de permisos, BOM y finales de línea. La creación sin sobrescritura requiere un sistema de archivos con enlaces duros (APFS, ext4).

`bash` ejecuta con tus permisos y **no está aislado**: un comando aprobado puede salir del proyecto y leer credenciales. Revisa cada comando. Los límites de tiempo y de salida terminan el grupo de procesos con `SIGKILL`; los procesos que se desacoplen por su cuenta pueden sobrevivir.

Los valores de variables de entorno con nombre de secreto, las claves PEM y patrones comunes se redactan en resultados y sesiones. **La redacción no cubre todos los secretos posibles**: revisa antes de guardar o compartir. No hay logging automático de conversaciones ni peticiones.

## Interfaz

- Prompt `tú ›` en cian; herramientas como `→ read ruta` en amarillo, resultados en gris indentados (`↳` sin afirmar éxito, `✗` en rojo para errores).
- El texto del modelo admite `**negritas**`, `*cursiva*` y `` `código` `` (también bloques con tres comillas invertidas) en streaming, incluso si el marcador llega partido entre fragmentos. Dentro de código no se interpretan otros marcadores y un `*` rodeado de espacios se deja literal.
- Mientras el modelo no ha emitido texto se muestra `… pensando`, que se borra al llegar la primera respuesta.
- Sin color si la salida no es una terminal o existe `NO_COLOR`.
- Los controles de terminal y de dirección de texto que envíe el modelo se muestran como escapes visibles; el original se conserva en el historial.

| Comando | Acción |
| --- | --- |
| `/help` | Mostrar ayuda. |
| `/clear` | Vaciar el historial. |
| `/tokens` | Estimar tokens del historial por caracteres (no es un tokenizer). |
| `/save [nombre]` | Guardar JSONL redactado en `~/.pi-chico/sessions/nombre.jsonl` (sin nombre usa fecha/hora). |
| `/load nombre` | Recuperar una sesión del mismo proyecto. |
| `/exit` | Salir. |

Ctrl+C cancela la tarea, petición o comando activo y deja un resultado por cada tool call solicitada; en el prompt principal sale. Las sesiones solo se guardan a petición y no se sobrescriben; carga únicamente archivos propios y de confianza.

## Configuración

```sh
node agent.mjs --help
node agent.mjs --prompt 'Usa read para listar el directorio actual y describe su contenido.'
```

| Opción / variable | Valor predeterminado |
| --- | --- |
| `--host` / `AGENT_HOST` | `http://127.0.0.1:8080`; acepta `host:puerto` y un `/v1` final |
| `--project` | Directorio actual |
| `--prompt` | Ejecuta una sola tarea y termina |
| `--max-turns` | `12` iteraciones por tarea |
| `AGENT_API_KEY` | Sin valor; si existe se envía como Bearer y nunca se imprime |
| `AGENT_HTTP_TIMEOUT_MS` | `300000`, tiempo máximo por petición, incluido el streaming |
| `AGENT_COMMAND_TIMEOUT_MS` | `60000`, tiempo máximo por comando |
| `AGENT_CONTEXT_TOKENS` | `32768`, presupuesto aproximado de contexto |
| `NO_COLOR` | Desactiva colores y negritas |

El host no admite credenciales, query ni fragmento, y las redirecciones HTTP se rechazan. Se reservan 4096 tokens de generación y la tarea se detiene si la estimación supera el presupuesto (la compactación queda pendiente). Los resultados se recortan, un comando con más de 1 MiB de salida se termina y las respuestas del servidor se limitan a 2 MiB. Se admiten hasta 32 tool calls por respuesta; los errores de protocolo impiden ejecutar una respuesta incompleta y no se acepta contenido posterior al final del modelo. La conversación y los resultados se envían al servidor configurado.

El MVP no incorpora subagentes, MCP, extensiones ni compactación automática.
