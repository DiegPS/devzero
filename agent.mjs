import * as fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';

const runSh = promisify(exec);
const HOST = process.env.HOST || process.argv[2] || 'http://127.0.0.1:8081';
const ROOT = await fs.realpath(process.argv[3] || '.');

const clip = (s, n = 20000) => s.length > n ? s.slice(0, n) + '\n[Truncado]' : s;
const str = description => ({ type: 'string', description });
const int = description => ({ type: 'integer', description });

const rl = createInterface({ input: process.stdin, output: process.stdout });
const approve = async text => (await rl.question(`\n${text}\nAutorizar? [s/N] `)).trim().toLowerCase() === 's';
const resolve = name => {
  const file = path.resolve(ROOT, name || '');
  if (!file.startsWith(ROOT)) throw Error('Ruta fuera del proyecto');
  return file;
};

const toolSpecs = {
  read: {
    description: 'Leer archivo o listar directorio (usa path . para explorar).',
    properties: { path: str('Ruta'), start: int('Inicio'), lines: int('Lineas') },
    required: ['path'],
    async run({ path: name, start = 1, lines = 500 }) {
      const file = resolve(name);
      if ((await fs.stat(file)).isDirectory()) return (await fs.readdir(file)).join('\n');
      const all = (await fs.readFile(file, 'utf8')).split('\n');
      return clip(all.slice(start - 1, start - 1 + lines).join('\n'));
    },
  },
  write: {
    description: 'Crear o sobrescribir archivo.',
    properties: { path: str('Ruta'), content: str('Contenido') },
    required: ['path', 'content'],
    async run({ path: name, content }) {
      const file = resolve(name);
      if (!await approve(`Escribir ${name} (${content.length} chars)`)) throw Error('Rechazado');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, 'utf8');
      return `Escrito: ${name}`;
    },
  },
  edit: {
    description: 'Reemplazar bloque exacto leido con read.',
    properties: { path: str('Ruta'), old: str('Bloque actual exacto'), replacement: str('Bloque nuevo') },
    required: ['path', 'old', 'replacement'],
    async run({ path: name, old, replacement }) {
      const file = resolve(name);
      const prev = await fs.readFile(file, 'utf8');
      const target = prev.includes(old) ? old : old?.trim();
      const next = target === old ? replacement : replacement.trim();
      if (!target || !prev.includes(target)) throw Error('Texto old no encontrado');
      if (prev.indexOf(target) !== prev.lastIndexOf(target)) throw Error('Texto old ambiguo');
      if (!await approve(`Editar ${name}:\nANTES:\n${clip(target, 400)}\nDESPUES:\n${clip(next, 400)}`)) throw Error('Rechazado');
      await fs.writeFile(file, prev.replace(target, () => next), 'utf8');
      return `Editado: ${name}`;
    },
  },
  bash: {
    description: 'Ejecutar comando shell.',
    properties: { command: str('Comando') },
    required: ['command'],
    async run({ command }) {
      if (!await approve(`Ejecutar: ${command}`)) throw Error('Rechazado');
      const { stdout, stderr } = await runSh(command, { cwd: ROOT, timeout: 60000 });
      return clip((stdout + stderr).trim() || '(ok)');
    },
  },
};

const tools = Object.entries(toolSpecs).map(([name, t]) => ({
  type: 'function',
  function: { name, description: t.description, parameters: { type: 'object', properties: t.properties, required: t.required } },
}));

async function chat(messages) {
  const res = await fetch(HOST + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, tools, stream: true, max_tokens: 4096, temperature: 0.2 }),
  });
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  const msg = { role: 'assistant', content: '' };
  const calls = new Map();
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      const d = JSON.parse(raw).choices?.[0]?.delta;
      if (d?.content) {
        msg.content += d.content;
        process.stdout.write(d.content);
      }
      for (const c of d?.tool_calls || []) {
        const item = calls.get(c.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        item.id += c.id || '';
        item.function.name += c.function?.name || '';
        item.function.arguments += c.function?.arguments || '';
        calls.set(c.index, item);
      }
    }
  }
  if (calls.size) msg.tool_calls = [...calls.values()];
  return msg;
}

const systemPrompt = () => ({
  role: 'system',
  content: `Eres Pi-Chico, agente de programacion en ${ROOT}. Responde en espanol. Si te piden mejorar el agente o agregar comandos/herramientas, lee directamente agent.mjs con read. Para explorar otros archivos usa read (nunca bash). Lee siempre el archivo con read antes de usar edit, y pon en old las lineas exactas a cambiar. En agent.mjs: usa async/await con fs, en toolSpecs usa str(), int(), resolve() y clip(), y en commands agrega comandos CLI. Escribe JavaScript simple en ASCII sin expresiones regulares.`,
});

async function runTask(messages, task) {
  messages.push({ role: 'user', content: task });
  for (let turn = 0; turn < 12; turn++) {
    const reply = await chat(messages);
    console.log('');
    messages.push(reply);
    if (!reply.tool_calls?.length) return;
    for (const call of reply.tool_calls) {
      const name = call.function.name;
      const args = JSON.parse(call.function.arguments || '{}');
      console.log(`-> ${name} ${args.path || args.command || ''}`);
      let result;
      try {
        result = await toolSpecs[name].run(args);
      } catch (e) {
        result = `Error: ${e.stderr || e.message}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      console.log(clip(result, 200));
    }
  }
}

let messages = [systemPrompt()];
const commands = {
  '/help': () => console.log('Comandos: ' + Object.keys(commands).join(', ') + ', /exit'),
  '/clear': () => { messages = [systemPrompt()]; },
};

console.log(`PI-CHICO | ${HOST} | ${ROOT}`);
while (true) {
  const text = (await rl.question('\ntu > ')).trim();
  if (text === '/exit') break;
  if (!text) continue;
  try {
    if (commands[text]) await commands[text]();
    else await runTask(messages, text);
  } catch (e) {
    console.error(`Error: ${e.message}`);
  }
}
rl.close();
