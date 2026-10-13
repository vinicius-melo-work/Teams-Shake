import hashlib
import hmac
import json
import logging
import os
import random
import secrets
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
HTML_DIRECTORY = ROOT / "html"
DATABASE = ROOT / "data" / "sorteios.sqlite3"
MAX_REQUEST_BYTES = 1_000_000
SESSION_COOKIE = "sorteio_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 7


def connect_database():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
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
        """
    )
    draw_columns = {row["name"] for row in connection.execute("PRAGMA table_info(draws)")}
    if "user_id" not in draw_columns:
        connection.execute("ALTER TABLE draws ADD COLUMN user_id INTEGER REFERENCES users(id)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_draws_user_id ON draws(user_id, id DESC)")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)")
    connection.commit()
    return connection


def validate_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("O corpo da requisição deve ser um objeto JSON.")

    names = payload.get("names")
    group_count = payload.get("group_count")
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
        raise ValueError("Informe os nomes dos participantes como uma lista de textos.")
    names = [name.strip() for name in names if name.strip()]
    if not names:
        raise ValueError("Informe pelo menos um participante.")
    if not isinstance(group_count, int) or isinstance(group_count, bool) or group_count < 1:
        raise ValueError("A quantidade de grupos deve ser um número inteiro positivo.")
    if group_count > len(names):
        raise ValueError("A quantidade de grupos não pode ser maior que a de participantes.")
    if len(names) % group_count:
        raise ValueError("Os participantes precisam ser divididos igualmente entre os grupos.")
    return names, group_count


def validate_password(password):
    if not isinstance(password, str):
        raise ValueError("A senha deve ter pelo menos 8 caracteres.")
    requirements = (
        (len(password) >= 8, "A senha deve ter pelo menos 8 caracteres."),
        (any(char.islower() for char in password), "A senha deve conter uma letra minúscula."),
        (any(char.isupper() for char in password), "A senha deve conter uma letra maiúscula."),
        (any(char.isdigit() for char in password), "A senha deve conter um número."),
        (any(not char.isalnum() for char in password), "A senha deve conter um caractere especial."),
    )
    for valid, message in requirements:
        if not valid:
            raise ValueError(message)


def hash_password(password, salt=None):
    validate_password(password)
    salt = salt or secrets.token_bytes(16)
    password_hash = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)
    return salt.hex(), password_hash.hex()


def verify_password(password, salt_hex, password_hash_hex):
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(password_hash_hex)
    except ValueError:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)
    return hmac.compare_digest(actual, expected)


def validate_credentials(payload, require_name=False):
    if not isinstance(payload, dict):
        raise ValueError("O corpo da requisição deve ser um objeto JSON.")
    name = payload.get("name", "").strip() if isinstance(payload.get("name", ""), str) else ""
    email = payload.get("email", "").strip().lower() if isinstance(payload.get("email", ""), str) else ""
    password = payload.get("password")
    if require_name and not name:
        raise ValueError("Informe seu nome.")
    if not email or "@" not in email:
        raise ValueError("Informe um e-mail válido.")
    if not isinstance(password, str) or not password:
        raise ValueError("Informe sua senha.")
    if require_name:
        validate_password(password)
    return name, email, password


def create_session(connection, user_id):
    session_id = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=SESSION_MAX_AGE)
    connection.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", (session_id, user_id, expires_at.isoformat()))
    connection.commit()
    return session_id


def get_session_user(connection, session_id):
    if not session_id:
        return None
    row = connection.execute(
        "SELECT users.id, users.name, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ?",
        (session_id, datetime.now(timezone.utc).isoformat()),
    ).fetchone()
    return dict(row) if row else None


def create_draw(connection, user_id, names=None, group_count=None):
    if group_count is None:
        group_count = names
        names = user_id
        user_id = None
    participantes = list(names)
    random.SystemRandom().shuffle(participantes)
    tamanho_grupo = len(participantes) // group_count
    groups = [
        participantes[inicio:inicio + tamanho_grupo]
        for inicio in range(0, len(participantes), tamanho_grupo)
    ]
    created_at = datetime.now(timezone.utc).isoformat()
    cursor = connection.execute(
        "INSERT INTO draws (user_id, created_at, names_json, groups_json) VALUES (?, ?, ?, ?)",
        (
            user_id,
            created_at,
            json.dumps(names, ensure_ascii=False),
            json.dumps(groups, ensure_ascii=False),
        ),
    )
    connection.commit()
    return {
        "id": cursor.lastrowid,
        "created_at": created_at,
        "names": names,
        "groups": groups,
    }


def list_draws(connection, user_id):
    if user_id is None:
        rows = connection.execute(
            "SELECT id, created_at, names_json, groups_json FROM draws WHERE user_id IS NULL ORDER BY id DESC LIMIT 50"
        ).fetchall()
    else:
        rows = connection.execute(
            "SELECT id, created_at, names_json, groups_json FROM draws WHERE user_id = ? ORDER BY id DESC LIMIT 50",
            (user_id,),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "created_at": row["created_at"],
            "names": json.loads(row["names_json"]),
            "groups": json.loads(row["groups_json"]),
        }
        for row in rows
    ]


class SorteioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _session_id(self):
        header = self.headers.get("Cookie", "")
        jar = cookies.SimpleCookie()
        jar.load(header)
        morsel = jar.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def _current_user(self, connection):
        return get_session_user(connection, self._session_id())

    def _send_session_cookie(self, session_id):
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}={session_id}; HttpOnly; SameSite=Lax; Max-Age={SESSION_MAX_AGE}; Path=/")

    def _require_user(self, connection):
        user = self._current_user(connection)
        if not user:
            self._send_json(401, {"error": "Faça login para acessar esta página."})
        return user

    def _send_json(self, status, payload, session_id=None, clear_session=False):
        corpo = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if session_id:
            self._send_session_cookie(session_id)
        if clear_session:
            self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/")
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/":
            with closing(connect_database()) as connection:
                self.path = "/html/index.html" if self._current_user(connection) else "/html/login.html"
            return super().do_GET()
        if path == "/api/me":
            with closing(connect_database()) as connection:
                user = self._current_user(connection)
                self._send_json(200, {"authenticated": bool(user), "user": user})
            return
        if path == "/api/draws":
            pass
        elif path in ("/html/index.html", "/html/login.html", "/css/styles.css", "/js/app.js", "/js/login.js"):
            return super().do_GET()
        else:
            self._send_json(404, {"error": "Recurso não encontrado."})
            return
        try:
            with closing(connect_database()) as connection:
                user = self._require_user(connection)
                if user:
                    self._send_json(200, {"draws": list_draws(connection, user["id"])})
        except sqlite3.Error:
            logging.exception("Falha ao consultar os sorteios salvos.")
            self._send_json(500, {"error": "Não foi possível carregar os sorteios salvos."})

    def _handle_auth(self, path):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Tamanho da requisição inválido."})
            return
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "A requisição está vazia ou é muito grande."})
            return
        try:
            payload = json.loads(self.rfile.read(content_length))
            name, email, password = validate_credentials(payload, require_name=path == "/api/register")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "O corpo da requisição precisa ser um JSON válido."})
            return
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
            return

        try:
            with closing(connect_database()) as connection:
                if path == "/api/register":
                    salt, password_hash = hash_password(password)
                    cursor = connection.execute(
                        "INSERT INTO users (name, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
                        (name, email, password_hash, salt, datetime.now(timezone.utc).isoformat()),
                    )
                    user = {"id": cursor.lastrowid, "name": name, "email": email}
                else:
                    row = connection.execute(
                        "SELECT id, name, email, password_hash, password_salt FROM users WHERE email = ?", (email,)
                    ).fetchone()
                    if not row or not verify_password(password, row["password_salt"], row["password_hash"]):
                        self._send_json(401, {"error": "E-mail ou senha incorretos."})
                        return
                    user = {"id": row["id"], "name": row["name"], "email": row["email"]}
                session_id = create_session(connection, user["id"])
            self._send_json(201 if path == "/api/register" else 200, {"user": user}, session_id=session_id)
        except sqlite3.IntegrityError:
            self._send_json(409, {"error": "Este e-mail já foi utilizado."})
        except sqlite3.Error:
            logging.exception("Falha ao processar a autenticação.")
            self._send_json(500, {"error": "Não foi possível concluir a autenticação."})

    def do_POST(self):
        path = urlsplit(self.path).path
        if path in ("/api/register", "/api/login"):
            self._handle_auth(path)
            return
        if path == "/api/logout":
            with closing(connect_database()) as connection:
                session_id = self._session_id()
                connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
                connection.commit()
                self._send_json(200, {"ok": True}, clear_session=True)
            return
        if path != "/api/draws":
            self._send_json(404, {"error": "Endpoint não encontrado."})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Tamanho da requisição inválido."})
            return
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "A requisição está vazia ou é muito grande."})
            return

        try:
            payload = json.loads(self.rfile.read(content_length))
            names, group_count = validate_payload(payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "O corpo da requisição precisa ser um JSON válido."})
            return
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
            return

        try:
            with closing(connect_database()) as connection:
                user = self._require_user(connection)
                if not user:
                    return
                draw = create_draw(connection, user["id"], names, group_count)
            self._send_json(201, {"draw": draw})
        except sqlite3.Error:
            logging.exception("Falha ao salvar o sorteio.")
            self._send_json(500, {"error": "Não foi possível salvar o sorteio."})


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), SorteioHandler)
    print(f"Teams Shake disponível em http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()
