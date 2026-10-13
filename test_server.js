const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { connectDatabase, createApp, createDraw, listDraws, validatePassword, validatePayload } = require("./server");

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "teams-shake-"));
  return { directory, file: path.join(directory, "test.sqlite3") };
}

test("valida participantes e grupos equilibrados", () => {
  assert.deepEqual(validatePayload({ names: [" Ana ", "Bia", "Caio", "Davi"], group_count: 2 }), [["Ana", "Bia", "Caio", "Davi"], 2]);
  assert.throws(() => validatePayload({ names: ["Ana", "Bia", "Caio"], group_count: 2 }), /divididos igualmente/);
});

test("valida requisitos de senha", () => {
  assert.doesNotThrow(() => validatePassword("SenhaSegura1!"));
  assert.throws(() => validatePassword("SenhaSegura1"), /caractere especial/);
});

test("salva e lista sorteios por usuário", () => {
  const { file, directory } = temporaryDatabase();
  const database = connectDatabase(file);
  database.prepare("INSERT INTO users (name, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)").run("Teste", "teste@example.com", "hash", "salt", new Date().toISOString());
  const saved = createDraw(database, 1, ["Ana", "Bia", "Caio", "Davi"], 2);
  assert.equal(saved.groups.length, 2);
  assert.deepEqual(listDraws(database, 1)[0].groups, saved.groups);
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("registra usuário e mantém sessão nos endpoints", async () => {
  const { file, directory } = temporaryDatabase();
  const database = connectDatabase(file);
  const server = createApp(database).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const register = await fetch(`${base}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Teste", email: "teste@example.com", password: "Senha123!" }) });
  assert.equal(register.status, 201);
  const cookie = register.headers.get("set-cookie").split(";")[0];
  const draws = await fetch(`${base}/api/draws`, { headers: { cookie } });
  assert.equal(draws.status, 200);
  assert.deepEqual((await draws.json()).draws, []);
  await new Promise((resolve) => server.close(resolve));
  database.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
