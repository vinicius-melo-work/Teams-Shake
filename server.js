const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

const ROOT = __dirname;
const DATABASE_PATH = path.join(ROOT, "data", "sorteios.sqlite3");
const MAX_REQUEST_BYTES = "1mb";
const SESSION_COOKIE = "sorteio_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function connectDatabase(databasePath = DATABASE_PATH) {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS draws (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      created_at TEXT NOT NULL,
      names_json TEXT NOT NULL,
      groups_json TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  const drawColumns = database.prepare("PRAGMA table_info(draws)").all().map((column) => column.name);
  if (!drawColumns.includes("user_id")) {
    database.exec("ALTER TABLE draws ADD COLUMN user_id INTEGER REFERENCES users(id)");
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_draws_user_id ON draws(user_id, id DESC)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)");
  return database;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("O corpo da requisição deve ser um objeto JSON.");
  }
  const { names, group_count: groupCount } = payload;
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
    throw new Error("Informe os nomes dos participantes como uma lista de textos.");
  }
  const cleanedNames = names.map((name) => name.trim()).filter(Boolean);
  if (!cleanedNames.length) throw new Error("Informe pelo menos um participante.");
  if (!Number.isInteger(groupCount) || groupCount < 1) {
    throw new Error("A quantidade de grupos deve ser um número inteiro positivo.");
  }
  if (groupCount > cleanedNames.length) {
    throw new Error("A quantidade de grupos não pode ser maior que a de participantes.");
  }
  if (cleanedNames.length % groupCount) {
    throw new Error("Os participantes precisam ser divididos igualmente entre os grupos.");
  }
  return [cleanedNames, groupCount];
}

function validatePassword(password) {
  const requirements = [
    [typeof password === "string" && password.length >= 8, "A senha deve ter pelo menos 8 caracteres."],
    [typeof password === "string" && /[a-z]/.test(password), "A senha deve conter uma letra minúscula."],
    [typeof password === "string" && /[A-Z]/.test(password), "A senha deve conter uma letra maiúscula."],
    [typeof password === "string" && /\d/.test(password), "A senha deve conter um número."],
    [typeof password === "string" && /[^A-Za-z0-9]/.test(password), "A senha deve conter um caractere especial."],
  ];
  const failed = requirements.find(([valid]) => !valid);
  if (failed) throw new Error(failed[1]);
}

function validateCredentials(payload, requireName = false) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("O corpo da requisição deve ser um objeto JSON.");
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const { password } = payload;
  if (requireName && !name) throw new Error("Informe seu nome.");
  if (!email || !email.includes("@")) throw new Error("Informe um e-mail válido.");
  if (typeof password !== "string" || !password) throw new Error("Informe sua senha.");
  if (requireName) validatePassword(password);
  return { name, email, password };
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  validatePassword(password);
  return { salt: salt.toString("hex"), hash: crypto.pbkdf2Sync(password, salt, 310000, 32, "sha256").toString("hex") };
}

function verifyPassword(password, saltHex, hashHex) {
  try {
    const actual = crypto.pbkdf2Sync(password, Buffer.from(saltHex, "hex"), 310000, 32, "sha256");
    return crypto.timingSafeEqual(actual, Buffer.from(hashHex, "hex"));
  } catch {
    return false;
  }
}

function createSession(database, userId) {
  const id = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
  database.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, expiresAt);
  return id;
}

function getSessionUser(database, sessionId) {
  if (!sessionId) return null;
  return database.prepare(`SELECT users.id, users.name, users.email FROM sessions
    JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ?`)
    .get(sessionId, new Date().toISOString()) || null;
}

function createDraw(database, userId, names, groupCount) {
  const shuffled = [...names];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  const groupSize = shuffled.length / groupCount;
  const groups = Array.from({ length: groupCount }, (_, index) => shuffled.slice(index * groupSize, (index + 1) * groupSize));
  const createdAt = new Date().toISOString();
  const result = database.prepare("INSERT INTO draws (user_id, created_at, names_json, groups_json) VALUES (?, ?, ?, ?)")
    .run(userId, createdAt, JSON.stringify(names), JSON.stringify(groups));
  return { id: Number(result.lastInsertRowid), created_at: createdAt, names, groups };
}

function listDraws(database, userId) {
  return database.prepare("SELECT id, created_at, names_json, groups_json FROM draws WHERE user_id = ? ORDER BY id DESC LIMIT 50")
    .all(userId).map((row) => ({ ...row, names: JSON.parse(row.names_json), groups: JSON.parse(row.groups_json) }));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").filter(Boolean).map((item) => {
    const [key, ...value] = item.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

function createApp(database = connectDatabase()) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_REQUEST_BYTES }));
  app.use((request, response, next) => {
    request.currentUser = () => getSessionUser(database, parseCookies(request)[SESSION_COOKIE]);
    next();
  });

  app.get("/", (request, response) => response.sendFile(path.join(ROOT, "html", request.currentUser() ? "index.html" : "login.html")));
  app.get("/api/me", (request, response) => {
    const user = request.currentUser();
    response.json({ authenticated: Boolean(user), user });
  });
  app.post("/api/register", (request, response) => {
    try {
      const { name, email, password } = validateCredentials(request.body, true);
      const { salt, hash } = hashPassword(password);
      const result = database.prepare("INSERT INTO users (name, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(name, email, hash, salt, new Date().toISOString());
      const user = { id: Number(result.lastInsertRowid), name, email };
      const sessionId = createSession(database, user.id);
      response.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: "lax", maxAge: SESSION_MAX_AGE, path: "/" });
      response.status(201).json({ user });
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) return response.status(409).json({ error: "Este e-mail já foi utilizado." });
      return response.status(400).json({ error: error.message });
    }
  });
  app.post("/api/login", (request, response) => {
    try {
      const { email, password } = validateCredentials(request.body);
      const user = database.prepare("SELECT id, name, email, password_hash, password_salt FROM users WHERE email = ?").get(email);
      if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) return response.status(401).json({ error: "E-mail ou senha incorretos." });
      const sessionId = createSession(database, user.id);
      response.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: "lax", maxAge: SESSION_MAX_AGE, path: "/" });
      return response.json({ user: { id: user.id, name: user.name, email: user.email } });
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  });
  app.post("/api/logout", (request, response) => {
    const sessionId = parseCookies(request)[SESSION_COOKIE];
    database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" }).json({ ok: true });
  });
  app.get("/api/draws", (request, response) => {
    const user = request.currentUser();
    if (!user) return response.status(401).json({ error: "Faça login para acessar esta página." });
    return response.json({ draws: listDraws(database, user.id) });
  });
  app.post("/api/draws", (request, response) => {
    try {
      const user = request.currentUser();
      if (!user) return response.status(401).json({ error: "Faça login para acessar esta página." });
      const [names, groupCount] = validatePayload(request.body);
      return response.status(201).json({ draw: createDraw(database, user.id, names, groupCount) });
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  });
  app.use(express.static(ROOT, { index: false }));
  app.use((request, response) => response.status(404).json({ error: "Recurso não encontrado." }));
  return app;
}

if (require.main === module) {
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || 8000);
  createApp().listen(port, host, () => console.log(`Teams Shake disponível em http://${host}:${port}`));
}

module.exports = { connectDatabase, createApp, createDraw, hashPassword, listDraws, validatePassword, validatePayload };
