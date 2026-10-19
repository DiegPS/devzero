# Pi-Chico

Agente de programación de terminal para **macOS y Linux** con Node.js 22+, ES Modules y **cero dependencias npm**. Todo el núcleo está en `agent.mjs` (**164 líneas**, 100 % ASCII puro y **cero expresiones regulares**), diseñado para poder escribirse a mano fácilmente y mejorarse a sí mismo usando **llama-server** (llama.cpp / ik_llama.cpp) con streaming SSE y tool calling estructurado.

## Inicio rápido

1. Arranca tu servidor con `--jinja` (y opcionalmente con MTP para decodificación especulativa):

```sh
# Basico
llama-server -m gemma.gguf --jinja --host 127.0.0.1 --port 8081

# Con MTP (Multi-Token Prediction) y cache KV q8_0
llama-server -m gemma.gguf -md mtp.gguf --spec-type mtp:n_max=3,p_min=0.0 \
  --ctx-size 8192 -ctk q8_0 -ctv q8_0 -ngl 38 -ngld 99 --jinja --port 8081
```

2. Ejecuta Pi-Chico:

```sh
node agent.mjs                                      # http://127.0.0.1:8081, directorio actual
node agent.mjs http://127.0.0.1:8081 ~/mi-proyecto
```

## Arquitectura

1. **`toolSpecs` (Registro declarativo de herramientas):** Define en un solo objeto `read`, `write`, `edit` y `bash`. De ahí se generan automáticamente los esquemas JSON para el modelo, la validación de argumentos requeridos/desconocidos y el despacho en `Workspace.execute`.
2. **`Backend.chat`:** Envía el historial y `tools` por HTTP POST a `/v1/chat/completions` con `stream: true`, procesa eventos SSE usando `indexOf('\n')` (sin regex), imprime el texto en tiempo real con soporte de `**negritas**` (`createPrinter`) y reconstruye las llamadas a herramientas fragmentadas.
3. **`Workspace`:** Resuelve rutas dentro del proyecto (`inside`), bloquea archivos sensibles (`SECRETS`) y enlaces simbólicos que apunten fuera de la raíz (`fs.realpath`), solicita aprobación interactiva `[s/N]` antes de modificar archivos o ejecutar comandos, y ejecuta `/bin/sh -c` en un grupo de procesos independiente (`detached: true`) para poder cancelar árbol completo con `process.kill(-child.pid, 'SIGKILL')`.
4. **`commands` (Registro de comandos CLI):** Objeto declarativo para `/help`, `/clear`, `/tokens`, `/save` y `/load`.

## Herramientas y comandos

| Herramienta | Función |
| --- | --- |
| `read` | Lee líneas exactas de un archivo (`path`, `start`, `lines`) o lista un directorio. |
| `write` | Crea o sobrescribe un archivo previa aprobación `[s/N]`. |
| `edit` | Reemplaza una coincidencia exacta y única (`old` -> `replacement`) previa aprobación `[s/N]`. |
| `bash` | Ejecuta un comando en `/bin/sh -c` con timeout y cancelación por grupo de procesos. |

| Comando | Acción |
| --- | --- |
| `/help` | Mostrar comandos disponibles. |
| `/clear` | Reiniciar el historial de conversación. |
| `/tokens` | Estimar tokens actuales del historial. |
| `/save [nombre]` | Guardar sesión en `~/.pi-chico/<nombre>.json`. |
| `/load [nombre]` | Cargar sesión desde `~/.pi-chico/<nombre>.json`. |
| `/exit` | Salir del agente. |

## Automejora con Gemma 4 12B

Gracias a que `read` devuelve hasta 500 líneas exactas (sin prefijos por línea), `/help` se genera dinámicamente desde `Object.keys(commands)` y `systemMessage` guía el flujo `read` -> `edit`, puedes pedirle mejoras con prompts cortos y naturales sin indicar archivos ni números de línea:

```text
Agregale un comando /status para ver el host y los tokens
Agregale una herramienta search para buscar un texto dentro de un archivo y devolver las lineas que coincidan
Agregale un comando /undo para borrar el ultimo turno
```
