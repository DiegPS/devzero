# devzero

> **Zero-dependency, single-file autonomous coding agent for local LLMs.**  
> Built for Node.js 22+, `llama.cpp` (`llama-server`), and Ollama. Pure JavaScript, zero bloat, maximum auditability.

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg?style=flat-square)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0%20npm-blue.svg?style=flat-square)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-purple.svg?style=flat-square)](#multiplataforma)
[![License](https://img.shields.io/badge/license-MIT-orange.svg?style=flat-square)](LICENSE)

---

## ⚡ ¿Por qué devzero?

La mayoría de los agentes de programación modernos arrastran cientos de dependencias de `npm`, configuraciones complejas de build, telemetría y miles de líneas de código opaco. 

**devzero** adopta la filosofía contraria (inspirada en la simplicidad de `/dev/zero`):
* **0 dependencias de npm:** Utiliza únicamente los módulos nativos de **Node.js 22+** (`node:fs/promises`, `node:child_process`, `node:readline`, `node:crypto`, `node:http`). No hay `node_modules` ni riesgos de supply-chain.
* **Todo en un solo archivo:** El motor completo reside en [`agent.mjs`](agent.mjs) en menos de 400 líneas de código limpio y legible.
* **Tool Calling Estructurado real:** No intenta adivinar comandos dentro de texto libre; se conecta vía Server-Sent Events (SSE) a endpoints compatibles con la API de OpenAI (`/v1/chat/completions`) utilizando plantillas Jinja (`--jinja`) para llamadas a funciones tipadas y estructuradas.
* **Seguridad Human-in-the-Loop:** Cada comando en consola y cada modificación de archivos requiere tu aprobación explícita (`[s/N]`). No hay ejecuciones a ciegas.
* **Privacidad absoluta:** Tu código nunca sale de tu máquina. El agente habla exclusivamente con tu servidor local de inferencia.

---

## 🏗️ Arquitectura y Flujo de Ejecución

```mermaid
flowchart TD
    User([Usuario en Terminal]) -->|Escribe tarea o prompt| REPL[Bucle Principal / REPL]
    REPL -->|Agrega a historial| Loop[Bucle Agéntico: runTask]
    Loop -->|POST /v1/chat/completions SSE| Server[(llama-server / Ollama)]
    Server -->|Streaming de texto + Tool Calls| Parser[Backend: Acumulador SSE]
    Parser -->|Imprime texto y detecta herramientas| Dispatcher{¿Hay llamadas a herramientas?}
    Dispatcher -->|No| Finished([Tarea Completada])
    Dispatcher -->|Sí: read, write, edit, bash| Guard[Workspace Guard: Seguridad y Path Check]
    Guard -->|Pide autorización interactiva| UserApproval{¿Aprobado [s/N]?}
    UserApproval -->|No| Rejected[Resultado: Rechazado / Error]
    UserApproval -->|Sí| Execution[Ejecución en Disco / Shell]
    Execution --> Result[Resultado Sanitizado y Redactado]
    Rejected --> Result
    Result -->|Añade resultado al contexto| Loop
```

---

## 🛠️ Herramientas Integradas

El modelo interactúa con tu espacio de trabajo a través de 4 herramientas fundamentales definidas con esquemas JSON Schema:

| Herramienta | Función | Control de Seguridad |
| :--- | :--- | :--- |
| **`read`** | Lee archivos con numeración de líneas (`start`, `lines`; 200 por defecto) o lista directorios. | Bloquea archivos de credenciales (`.env`, `id_rsa`, `.pem`) y limita la lectura a 1 MiB de texto UTF-8. No requiere aprobación. |
| **`write`** | Crea o sobreescribe archivos de texto. | Muestra el contenido propuesto y **requiere aprobación previa**. Escritura atómica (`.tmp` + `rename`). |
| **`edit`** | Reemplaza una única coincidencia exacta (`old` $\to$ `replacement`). | **Requiere aprobación previa**. Falla de forma segura si la búsqueda está vacía, no existe o es ambigua (múltiples coincidencias). |
| **`bash`** | Ejecuta comandos en el shell del sistema. | **Requiere aprobación previa**. En Windows usa `powershell.exe`; en macOS y Linux usa `/bin/sh`. Aislamiento y terminación de árbol de procesos (`taskkill` o `process.kill(-pid)`). |

---

## 🔒 Modelo de Seguridad y Defensas

1. **Jailbreak y Path Traversal:**
   * Se rechaza cualquier ruta que intente salir del proyecto (`..`, rutas absolutas ajenas, enlaces simbólicos fuera de la raíz).
   * En Windows se bloquean nombres de dispositivo reservados (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) y *Alternate Data Streams* (`archivo:stream`).
2. **Redacción Automática de Secretos:**
   * Todo valor de variable de entorno que contenga `key`, `token`, `password` o `secret` con 6+ caracteres es enmascarado como `[REDACTADO]`.
   * Bloques de claves privadas PEM (`BEGIN PRIVATE KEY`) y tokens Bearer son redactados antes de mostrarse en terminal o guardarse en sesiones.
3. **Escritura Atómica y Protección de Enlaces:**
   * Las escrituras usan un archivo temporal único antes de renombrar o enlazar, evitando corrupción por cortes abruptos.
   * Se detecta si un archivo cambió externamente mientras el usuario decidía la aprobación.
   * Se protegen enlaces duros ajenos y se conservan los bits de permisos originales en Unix.

---

## 🚀 Inicio Rápido

### 1. Prerrequisitos
* **Node.js >= 22** instalado ([nodejs.org](https://nodejs.org) o vía `brew install node`).
* Un servidor local de inferencia compatible con OpenAI (`llama.cpp`, Ollama, vLLM, etc.) que soporte tool calling con Jinja.

### 2. Arrancar tu servidor local
Con **`llama-server`** (de `llama.cpp`):
```bash
# macOS (Apple Silicon Metal) / Linux / Windows
llama-server -m /ruta/a/tu-modelo.gguf --jinja -c 16384 -ngl 99 --port 8080
```
> [!IMPORTANT]
> El flag `--jinja` es indispensable para que el servidor formatee y procese las llamadas a herramientas estructuradas.

### 3. Iniciar devzero

```bash
# Ejecutar en el proyecto actual conectado al host por defecto (http://127.0.0.1:8080)
node agent.mjs

# Especificar host y ruta de proyecto
node agent.mjs --host http://127.0.0.1:8080 --project /ruta/a/tu/codigo

# Modo comando único (sin REPL interactivo)
node agent.mjs --prompt "Lee package.json y crea un resumen en resumen.txt"
```

---

## 💻 Comandos de la Interfaz (REPL)

Dentro de la terminal interactiva de **devzero**, cuentas con los siguientes comandos rápidos:

* **`/help`**: Muestra la lista de comandos disponibles.
* **`/tokens`**: Muestra una estimación del presupuesto de contexto consumido en tiempo real.
* **`/save [nombre]`**: Guarda la sesión actual (con secretos redactados) en formato JSONL en `~/.devzero/sessions/` o `~/.pi-chico/sessions/`.
* **`/load <nombre>`**: Restaura una sesión previa vinculada al proyecto actual.
* **`/clear`**: Limpia el historial de la conversación para liberar contexto a cero.
* **`/exit`**: Finaliza y cierra la sesión.
* **`Ctrl+C`**: Cancela de inmediato la tarea, comando o petición HTTP en curso sin salir del agente (si se pulsa en el prompt principal, sale).

---

## ⚙️ Configuración y Variables de Entorno

| Variable / Flag | Por defecto | Descripción |
| :--- | :--- | :--- |
| `--host` / `AGENT_HOST` | `http://127.0.0.1:8080` | URL base del servidor de inferencia. |
| `--project` | Directorio actual | Ruta raíz del espacio de trabajo donde operará el agente. |
| `--prompt` | *Ninguno* | Tarea directa; se ejecuta y finaliza de inmediato. |
| `--max-turns` | `12` | Límite máximo de iteraciones de herramientas por tarea. |
| `AGENT_CONTEXT_TOKENS` | `32768` | Presupuesto máximo de contexto antes de solicitar limpieza. |
| `AGENT_HTTP_TIMEOUT_MS`| `300000` (5 min) | Tiempo máximo de espera para peticiones HTTP y streaming. |
| `AGENT_COMMAND_TIMEOUT_MS`| `60000` (1 min) | Tiempo máximo de ejecución antes de matar un proceso de `bash`. |
| `AGENT_API_KEY` | *Ninguno* | Token opcional enviado en el encabezado `Authorization: Bearer`. |
| `NO_COLOR` | *Falso* | Desactiva colores ANSI y formato en terminal si está presente. |

---

## 🍏 Multiplataforma

* **macOS:** Utiliza `/bin/sh` nativo, soporte completo de rutas POSIX y terminación limpia de grupos de procesos vía `SIGKILL`. Ideal con Apple Silicon y aceleración Metal en `llama.cpp`.
* **Linux:** Entorno POSIX idéntico a macOS, optimizado para servidores locales o estaciones con GPU CUDA/ROCm.
* **Windows:** Utiliza `PowerShell` en modo no interactivo (`-NoProfile -NonInteractive`), gestión de procesos en árbol con `taskkill /T /F` y filtros contra nombres reservados de DOS y ADS.

---

## 🧪 Pruebas y Verificación

La suite de pruebas automatizadas utiliza el test runner nativo de Node.js:

```bash
npm test
# O directamente:
node --test
```

Las 23 pruebas cubren:
* Servidores HTTP mock con streaming SSE fragmentado y multilínea.
* Ejecución y rechazo de herramientas reales (`read`, `write`, `edit`, `bash`).
* Detección de path traversal, enlaces simbólicos externos y archivos de secretos.
* Redacción de credenciales en memoria y en disco.
* Cancelación limpia de procesos por timeout y señales AbortController.
* **Regla de oro:** Verificación estructural de que el motor se mantiene en un único archivo de menos de 400 líneas sin dependencias.

---

## 📄 Licencia

Este proyecto está bajo la Licencia MIT. Libre para usar, modificar y distribuir.
