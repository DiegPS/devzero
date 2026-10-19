#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const LIMIT = 20000;
const SECRETS = ['.env', 'id_rsa', 'id_ed25519', 'credentials', 'secret', '.pem', '.key'];

const clip = (s, n = LIMIT) => s.length > n ? s.slice(0, n) + '\n[Salida truncada]' : s;
const tokens = x => Math.ceil(JSON.stringify(x).length / 3);
const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function createPrinter() {
  let bold = false, hold = '';
  return chunk => {
    if (chunk === null) {
      if (hold) process.stdout.write(hold);
      if (bold) process.stdout.write('\x1b[0m');
      bold = false;
      hold = '';
      return;
    }
    let text = hold + chunk;
    hold = text.endsWith('*') && !text.endsWith('**') ? '*' : '';
    if (hold) text = text.slice(0, -1);
    const parts = text.split('**');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        bold = !bold;
        process.stdout.write(bold ? '\x1b[1;97m' : '\x1b[0m');
      }
      process.stdout.write(parts[i]);
    }
  };
}

export function config(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
      host: { type: 'string' },
      project: { type: 'string' },
      prompt: { type: 'string' },
      'max-turns': { type: 'string' },
    },
  });
  let host = values.host || process.env.AGENT_HOST || 'http://127.0.0.1:8080';
  if (!host.includes('://')) host = 'http://' + host;
  while (host.endsWith('/')) host = host.slice(0, -1);
  if (host.endsWith('/v1')) host = host.slice(0, -3);
  return {
    ...values,
    host,
    project: path.resolve(values.project || process.cwd()),
    maxTurns: Number(values['max-turns'] || 12),
    timeout: Number(process.env.AGENT_HTTP_TIMEOUT_MS || 300000),
    commandTimeout: Number(process.env.AGENT_COMMAND_TIMEOUT_MS || 60000),
    context: Number(process.env.AGENT_CONTEXT_TOKENS || 32768),
  };
}

const str = description => ({ type: 'string', description });
const int = description => ({ type: 'integer', description });

const toolSpecs = {
  read: {
    description: 'Leer archivo o listar directorio (usa path . para explorar).',
    properties: { path: str('Ruta relativa'), start: int('Linea inicial'), lines: int('Cantidad de lineas') },
    required: ['path'],
    async run(ws, { path: name, start = 1, lines = 500 }) {
      const file = await ws.resolve(name);
      const stat = await fs.stat(file);
      if (stat.isDirectory()) {
        const items = await fs.readdir(file, { withFileTypes: true });
        return clip(items.map(d => d.name + (d.isDirectory() ? '/' : '')).sort().join('\n'));
      }
      const all = (await fs.readFile(file, 'utf8')).split('\n');
      const slice = all.slice(start - 1, start - 1 + lines).join('\n');
      return clip(slice) + `\n[Lineas ${start}-${Math.min(all.length, start + lines - 1)} de ${all.length}]`;
    },
  },
  write: {
    description: 'Crear o sobrescribir un archivo con aprobacion.',
    properties: { path: str('Archivo'), content: str('Contenido completo') },
    required: ['path', 'content'],
    async run(ws, { path: name, content }, signal) {
      const file = await ws.resolve(name);
      const ok = await ws.approve(`Escribir ${name} (${content.length} chars):\n${clip(content, 2000)}`, signal);
      if (!ok) throw Error('Cambio no autorizado.');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
      return `Archivo escrito: ${name}`;
    },
  },
  edit: {
    description: 'Reemplazar bloque exacto leido previamente con read.',
    properties: { path: str('Archivo'), old: str('Copia exacta del bloque actual'), replacement: str('Bloque nuevo') },
    required: ['path', 'old', 'replacement'],
    async run(ws, { path: name, old, replacement }, signal) {
      const file = await ws.resolve(name);
      const previous = await fs.readFile(file, 'utf8');
      const target = previous.includes(old) ? old : old?.trim();
      const next = target === old ? replacement : replacement.trim();
      if (!target || !previous.includes(target)) throw Error('Texto old no encontrado en el archivo.');
      if (previous.indexOf(target) !== previous.lastIndexOf(target)) throw Error('Coincidencia ambigua; incluye mas lineas en old.');
      const preview = `ANTES:\n${clip(target, 1000)}\nDESPUES:\n${clip(next, 1000)}`;
      if (!await ws.approve(`Editar ${name}:\n${preview}`, signal)) throw Error('Cambio no autorizado.');
      await fs.writeFile(file, previous.replace(target, () => next), 'utf8');
      return `Archivo editado: ${name}`;
    },
  },
  bash: {
    description: 'Ejecutar comando en /bin/sh con aprobacion.',
    properties: { command: str('Comando shell') },
    required: ['command'],
    async run(ws, { command }, signal) {
      if (!command?.trim()) throw Error('Comando vacio.');
      if (!await ws.approve(`Ejecutar en ${ws.root}:\n${command}`, signal)) throw Error('Comando no autorizado.');
      return ws.command(command, signal);
    },
  },
};

export const tools = Object.entries(toolSpecs).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: { type: 'object', properties: t.properties, required: t.required } },
}));

export class Backend {
  constructor(cfg) { this.cfg = cfg; }
  async chat(messages, signal, onText = () => {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.AGENT_API_KEY) headers.Authorization = `Bearer ${process.env.AGENT_API_KEY}`;
    const signals = [AbortSignal.timeout(this.cfg.timeout), signal].filter(Boolean);
    const res = await fetch(this.cfg.host + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages, tools, stream: true, max_tokens: 4096, temperature: 0.2 }),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) throw Error(`HTTP ${res.status}`);
    const message = { role: 'assistant', content: '' };
    const calls = new Map();
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let pos;
      while ((pos = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, pos).trim();
        buffer = buffer.slice(pos + 1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        const delta = JSON.parse(raw).choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          message.content += delta.content;
          onText(delta.content);
        }
        for (const call of delta.tool_calls || []) {
          const item = calls.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.id) item.id += call.id;
          if (call.function?.name) item.function.name += call.function.name;
          if (call.function?.arguments) item.function.arguments += call.function.arguments;
          calls.set(call.index, item);
        }
      }
    }
    if (calls.size) message.tool_calls = [...calls.values()];
    return message;
  }
}

export class Workspace {
  static async open(root, approve, timeout = 60000) {
    return new Workspace(await fs.realpath(root), approve, timeout);
  }
  constructor(root, approve, timeout = 60000) {
    this.root = root;
    this.approve = approve;
    this.timeout = timeout;
  }
  async resolve(name) {
    if (!name || typeof name !== 'string') throw Error('Ruta invalida.');
    const file = path.resolve(this.root, name);
    if (!inside(this.root, file)) throw Error('Ruta fuera del proyecto.');
    const base = path.basename(file).toLowerCase();
    if (SECRETS.some(s => base.includes(s))) throw Error('Archivo de credenciales bloqueado.');
    for (let probe = file; ; probe = path.dirname(probe)) {
      try {
        const real = await fs.realpath(probe);
        if (!inside(this.root, real)) throw Error('Enlace simbolico fuera del proyecto.');
        return file;
      } catch (e) {
        if (e.code !== 'ENOENT' || path.dirname(probe) === probe) throw e;
      }
    }
  }
  async execute(name, args, signal) {
    try {
      const tool = toolSpecs[name];
      if (!tool || !args) throw Error(`Herramienta invalida: ${name}`);
      for (const k of Object.keys(args)) if (!tool.properties[k]) throw Error(`Argumento desconocido: ${k}`);
      for (const k of tool.required) if (!(k in args)) throw Error(`Falta argumento: ${k}`);
      return await tool.run(this, args, signal);
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }
  command(command, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { cwd: this.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', stopped = '';
      const stop = reason => {
        if (stopped) return;
        stopped = reason;
        if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      child.stdout.setEncoding('utf8').on('data', c => { stdout = clip(stdout + c); });
      child.stderr.setEncoding('utf8').on('data', c => { stderr = clip(stderr + c); });
      const timer = setTimeout(() => stop('Tiempo maximo excedido'), this.timeout);
      const onAbort = () => stop('Cancelado');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(JSON.stringify({ stdout, stderr, code, stopped }));
      });
    });
  }
}

export function systemMessage(root) {
  return {
    role: 'system',
    content: `Eres Pi-Chico, agente de programacion en ${root}. Responde en espanol. Si te piden mejorar el agente o agregar comandos/herramientas, lee directamente agent.mjs con read. Para explorar otros archivos usa read (nunca bash). Lee siempre el archivo con read antes de usar edit, y pon en old las lineas exactas a cambiar. En agent.mjs: usa async/await con fs (ej. await fs.readFile, await fs.readdir(dir, { recursive: true })), en toolSpecs usa str(), int(), await ws.resolve() y clip(), y en commands cada turno de messages inicia en role="user" (usa while para deshacer hasta user conservando messages[0]). Escribe JavaScript simple en ASCII sin expresiones regulares.`,
  };
}

export async function runTask({ backend, workspace, messages, task, signal }) {
  messages.push({ role: 'user', content: task });
  const write = createPrinter();
  for (let turn = 0; turn < backend.cfg.maxTurns; turn++) {
    signal?.throwIfAborted();
    let thinking = process.stdout.write(paint('2', '  ... pensando'));
    const clearThinking = () => thinking && (thinking = !process.stdout.write('\r\x1b[K'));
    const reply = await backend.chat(messages, signal, text => { clearThinking(); write(text); }).finally(clearThinking);
    write(null);
    console.log('');
    messages.push(reply);
    if (!reply.tool_calls?.length) return;
    for (const call of reply.tool_calls) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments || '{}');
      console.log(paint('33', `  -> ${name} ${args.path || args.command || ''}`));
      const result = await workspace.execute(name, args, signal);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      const color = result.startsWith('Error:') ? '31' : '2';
      console.log(paint(color, `     ${clip(result, 240).replaceAll('\n', '\n     ')}`));
    }
  }
  throw Error('Se alcanzo el limite de iteraciones.');
}

export async function main() {
  const cfg = config();
  if (cfg.help) return console.log('Uso: node agent.mjs [--host URL] [--project RUTA] [--prompt TAREA]');
  cfg.project = await fs.realpath(cfg.project);
  const backend = new Backend(cfg);
  console.log(`\n  PI-CHICO - ${cfg.host}\n  Proyecto: ${cfg.project}\n  /help ayuda - /exit salir - Ctrl+C cancelar\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false, controller = null;
  rl.on('close', () => { closed = true; });
  rl.on('SIGINT', () => controller ? controller.abort() : rl.close());
  const ask = prompt => closed ? Promise.resolve(null) : new Promise(resolve => rl.question(prompt, resolve));
  const approve = async text => {
    if (cfg.prompt) return false;
    const ans = (await ask(`\n  ${paint('1;33', 'APROBACION')}\n${text}\n\n  Autorizar? [s/N] `))?.trim().toLowerCase();
    return ans === 's' || ans === 'si';
  };
  const workspace = new Workspace(cfg.project, approve, cfg.commandTimeout);
  let messages = [systemMessage(cfg.project)];
  const sessionDir = path.join(os.homedir(), '.pi-chico');
  const commands = {
    '/help': () => console.log('Comandos: ' + Object.keys(commands).join(', ') + ', /exit'),
    '/clear': () => { messages = [systemMessage(cfg.project)]; },
    '/tokens': () => console.log(`~${tokens(messages)} tokens`),
    '/save': async name => {
      await fs.mkdir(sessionDir, { recursive: true });
      const file = path.join(sessionDir, (name || 'sesion') + '.json');
      await fs.writeFile(file, JSON.stringify(messages, null, 2));
      console.log('Guardado en ' + file);
    },
    '/load': async name => {
      const file = path.join(sessionDir, (name || 'sesion') + '.json');
      messages = JSON.parse(await fs.readFile(file, 'utf8'));
      console.log('Sesion cargada.');
    },
  };
  try {
    while (!closed) {
      const line = cfg.prompt ?? await ask(paint('1;36', 'tu > '));
      if (line === null) break;
      const text = line.trim();
      if (text === '/exit') break;
      if (text) {
        const space = text.indexOf(' ');
        const cmd = space === -1 ? text : text.slice(0, space);
        const arg = space === -1 ? '' : text.slice(space + 1).trim();
        controller = new AbortController();
        try {
          if (cmd.startsWith('/')) {
            if (!commands[cmd]) throw Error('Comando desconocido. Usa /help.');
            await commands[cmd](arg);
          } else {
            await runTask({ backend, workspace, messages, task: text, signal: controller.signal });
          }
        } catch (e) {
          console.error(paint('31', `\nError: ${e.message}`));
        } finally {
          controller = null;
        }
      }
      if (cfg.prompt !== undefined) break;
    }
  } finally {
    rl.close();
  }
}

if (import.meta.main) main().catch(e => { console.error(e.message); process.exitCode = 1; });
