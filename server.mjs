import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');
const dataDir = path.join(__dirname, 'data');
const distDir = path.join(__dirname, 'dist');
const databasePath = path.join(dataDir, 'flora.sqlite');
let database;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

async function loadEnvFile() {
  try {
    const file = await readFile(envPath, 'utf8');

    for (const line of file.split('\n')) {
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmedLine.indexOf('=');

      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmedLine.slice(0, separatorIndex).trim();
      const value = trimmedLine.slice(separatorIndex + 1).trim();

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function openDatabase() {
  await mkdir(dataDir, { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deleted_remote_todos (
      id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function readTodos() {
  return database
    .prepare(
      `
        SELECT id, title, done
        FROM todos
        ORDER BY position ASC, updated_at ASC
      `,
    )
    .all()
    .map((todo) => ({
      id: todo.id,
      title: todo.title,
      done: Boolean(todo.done),
    }));
}

function readLocalTodosForSync() {
  return database
    .prepare(
      `
        SELECT id, title, done, position
        FROM todos
        ORDER BY position ASC, updated_at ASC
      `,
    )
    .all()
    .map((todo) => ({
      id: todo.id,
      title: todo.title,
      done: Boolean(todo.done),
      position: todo.position,
    }));
}

function createLocalTodo(todo) {
  const insertTodo = database.prepare(`
    INSERT INTO todos (id, title, done, position, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const savedTodo = {
    id: String(todo.id),
    title: String(todo.title || '').trim(),
    done: Boolean(todo.done),
    position: Number(todo.position || 0),
  };

  insertTodo.run(savedTodo.id, savedTodo.title, savedTodo.done ? 1 : 0, savedTodo.position);
  return savedTodo;
}

function updateLocalTodo(id, changes) {
  const currentTodo = database
    .prepare('SELECT id, title, done, position FROM todos WHERE id = ?')
    .get(id);

  if (!currentTodo) {
    return null;
  }

  const nextTodo = {
    id: currentTodo.id,
    title: changes.title === undefined ? currentTodo.title : String(changes.title).trim(),
    done: changes.done === undefined ? Boolean(currentTodo.done) : Boolean(changes.done),
    position:
      changes.position === undefined ? currentTodo.position : Number(changes.position || 0),
  };

  database
    .prepare(
      `
        UPDATE todos
        SET title = ?, done = ?, position = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    )
    .run(nextTodo.title, nextTodo.done ? 1 : 0, nextTodo.position, id);

  return nextTodo;
}

function deleteLocalTodo(id) {
  const result = database.prepare('DELETE FROM todos WHERE id = ?').run(id);
  return result.changes > 0;
}

function hideRemoteTodo(id) {
  database
    .prepare(
      `
        INSERT OR REPLACE INTO deleted_remote_todos (id, deleted_at)
        VALUES (?, CURRENT_TIMESTAMP)
      `,
    )
    .run(id);
}

function getHiddenRemoteTodoIds() {
  return new Set(
    database
      .prepare('SELECT id FROM deleted_remote_todos')
      .all()
      .map((todo) => todo.id),
  );
}

function getRemoteConfig() {
  const restUrl = process.env.DATABASE_REST_URL;
  const apiKey = process.env.DATABASE_API_KEY;

  if (!restUrl || !apiKey) {
    return null;
  }

  return { restUrl, apiKey };
}

async function fetchRemoteTodos() {
  if (!getRemoteConfig()) {
    return null;
  }

  const url = new URL(process.env.DATABASE_REST_URL);
  url.searchParams.set('order', 'position.asc');

  const res = await fetch(url, {
    headers: {
      'x-api-key': process.env.DATABASE_API_KEY,
    },
  });

  if (!res.ok) {
    throw new Error(`Remote database GET failed: ${res.status}`);
  }

  const hiddenIds = getHiddenRemoteTodoIds();
  const todos = await res.json();

  return todos
    .map((row, index) => {
      const data = row.data ?? row;

      return {
        id: String(data.id ?? row.id ?? row.todo_id ?? index),
        title: String(data.title || ''),
        done: Boolean(data.done),
      };
    })
    .filter((todo) => !hiddenIds.has(todo.id));
}

async function createRemoteTodo(todo) {
  const config = getRemoteConfig();

  if (!config) {
    return null;
  }

  const response = await fetch(config.restUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'prefer': 'return=representation',
      'x-api-key': config.apiKey,
    },
    body: JSON.stringify({
      id: String(todo.id || crypto.randomUUID()),
      title: String(todo.title || '').trim(),
      done: todo.done ? 1 : 0,
      position: Number(todo.position || 0),
    }),
  });

  if (!response.ok) {
    throw new Error(`Remote database POST failed: ${response.status}`);
  }

  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : rows;
  const data = row?.data ?? row;

  return {
    id: String(data?.id ?? row?.id ?? todo.id),
    title: String(data?.title ?? todo.title ?? ''),
    done: Boolean(data?.done ?? todo.done),
  };
}

async function syncLocalTodosToRemote() {
  if (!getRemoteConfig()) {
    return;
  }

  try {
    const remoteTodos = await fetchRemoteTodos();
    const remoteKeys = new Set(
      (remoteTodos || []).map((todo) => `${todo.id}:${todo.title}`),
    );
    const remoteTitles = new Set((remoteTodos || []).map((todo) => todo.title));
    const localTodos = readLocalTodosForSync().filter(
      (todo) => !remoteKeys.has(`${todo.id}:${todo.title}`) && !remoteTitles.has(todo.title),
    );

    for (const todo of localTodos) {
      await createRemoteTodo(todo);
    }

    if (localTodos.length > 0) {
      console.log(`Synced ${localTodos.length} local todo(s) to remote database.`);
    }
  } catch (error) {
    console.error('Remote sync failed:', error);
  }
}

async function updateRemoteTodo(id, changes) {
  const config = getRemoteConfig();

  if (!config) {
    return null;
  }

  const body = {};

  if (changes.title !== undefined) {
    body.title = String(changes.title).trim();
  }

  if (changes.done !== undefined) {
    body.done = changes.done ? 1 : 0;
  }

  if (changes.position !== undefined) {
    body.position = Number(changes.position || 0);
  }

  const response = await fetch(`${config.restUrl}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'prefer': 'return=representation',
      'x-api-key': config.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Remote database PATCH failed: ${response.status}`);
  }

  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : rows;
  const data = row?.data ?? row;

  return {
    id: String(data?.id ?? row?.id ?? id),
    title: String(data?.title ?? changes.title ?? ''),
    done: Boolean(data?.done ?? changes.done),
  };
}

async function deleteRemoteTodo(id) {
  const config = getRemoteConfig();

  if (!config) {
    return null;
  }

  const response = await fetch(`${config.restUrl}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      'x-api-key': config.apiKey,
    },
  });

  if (response.status === 404) {
    hideRemoteTodo(id);
    return true;
  }

  if (!response.ok) {
    throw new Error(`Remote database DELETE failed: ${response.status}`);
  }

  return true;
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(data));
}

async function sendFile(response, filePath) {
  const extension = path.extname(filePath);
  const contentType = contentTypes[extension] || 'application/octet-stream';
  const file = await readFile(filePath);

  response.writeHead(200, {
    'Content-Type': contentType,
  });
  response.end(file);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const decodedPath = decodeURIComponent(url.pathname);
  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = path.normalize(path.join(distDir, requestedPath));

  if (!filePath.startsWith(distDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    await sendFile(response, filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    await sendFile(response, path.join(distDir, 'index.html'));
  }
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      response.end();
      return;
    }

    if (request.url === '/api/todos' && request.method === 'GET') {
      try {
        sendJson(response, 200, (await fetchRemoteTodos()) ?? readTodos());
      } catch (error) {
        console.error(error);
        sendJson(response, 200, readTodos());
      }
      return;
    }

    if (request.url === '/api/todos' && request.method === 'POST') {
      const todo = await readJsonBody(request);
      let savedTodo;

      try {
        savedTodo = await createRemoteTodo(todo);
      } catch (error) {
        console.error(error);
      }

      savedTodo =
        savedTodo ??
        createLocalTodo({
          ...todo,
          id: todo.id || crypto.randomUUID(),
        });

      sendJson(response, 201, savedTodo);
      return;
    }

    const todoUpdateMatch = request.url.match(/^\/api\/todos\/([^/?]+)$/);

    if (todoUpdateMatch && request.method === 'PATCH') {
      const id = decodeURIComponent(todoUpdateMatch[1]);
      const changes = await readJsonBody(request);
      let savedTodo;

      try {
        savedTodo = await updateRemoteTodo(id, changes);
      } catch (error) {
        console.error(error);
      }

      savedTodo = savedTodo ?? updateLocalTodo(id, changes);

      if (!savedTodo) {
        sendJson(response, 404, { error: 'Todo not found.' });
        return;
      }

      sendJson(response, 200, savedTodo);
      return;
    }

    if (todoUpdateMatch && request.method === 'DELETE') {
      const id = decodeURIComponent(todoUpdateMatch[1]);
      let deleted;

      try {
        deleted = await deleteRemoteTodo(id);
      } catch (error) {
        console.error(error);
        if (getRemoteConfig()) {
          hideRemoteTodo(id);
          deleted = true;
        }
      }

      deleted = deleted ?? deleteLocalTodo(id);

      if (!deleted) {
        sendJson(response, 404, { error: 'Todo not found.' });
        return;
      }

      sendJson(response, 200, { deleted: true });
      return;
    }

    if (request.url.startsWith('/api/')) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);

    if (request.url.startsWith('/api/')) {
      sendJson(response, 500, { error: 'Internal server error.' });
      return;
    }

    response.writeHead(500, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end('Internal server error.');
  }
});

await loadEnvFile();
const port = Number(process.env.PORT || process.env.API_PORT || 3001);
await openDatabase();
await syncLocalTodosToRemote();

server.listen(port, () => {
  console.log(`Database API running on http://localhost:${port}`);
  console.log(
    getRemoteConfig()
      ? `Remote database endpoint: ${process.env.DATABASE_REST_URL}`
      : `SQLite database: ${databasePath}`,
  );
  console.log(`Serving app from ${distDir}`);
});
