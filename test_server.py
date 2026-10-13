import json
import server
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from http.cookiejar import CookieJar
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen

from server import SorteioHandler, create_draw, list_draws, validate_payload, validate_password


class ValidatePayloadTests(unittest.TestCase):
    def test_accepts_names_and_equal_group_sizes(self):
        names, group_count = validate_payload(
            {"names": [" Ana ", "Bia", "Caio", "Davi"], "group_count": 2}
        )
        self.assertEqual(names, ["Ana", "Bia", "Caio", "Davi"])
        self.assertEqual(group_count, 2)

    def test_rejects_uneven_group_sizes(self):
        with self.assertRaisesRegex(ValueError, "divididos igualmente"):
            validate_payload({"names": ["Ana", "Bia", "Caio"], "group_count": 2})

    def test_rejects_more_groups_than_participants(self):
        with self.assertRaisesRegex(ValueError, "maior que a de participantes"):
            validate_payload({"names": ["Ana"], "group_count": 2})

    def test_rejects_non_integer_group_count(self):
        with self.assertRaisesRegex(ValueError, "número inteiro"):
            validate_payload({"names": ["Ana", "Bia"], "group_count": True})


class PasswordValidationTests(unittest.TestCase):
    def test_accepts_password_with_all_requirements(self):
        validate_password("SenhaSegura1!")

    def test_rejects_password_without_required_character(self):
        with self.assertRaisesRegex(ValueError, "caractere especial"):
            validate_password("SenhaSegura1")


class DrawPersistenceTests(unittest.TestCase):
    def test_saves_and_lists_draw_with_equal_groups(self):
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.execute(
            """
            CREATE TABLE draws (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                created_at TEXT NOT NULL,
                names_json TEXT NOT NULL,
                groups_json TEXT NOT NULL
            )
            """
        )
        names = ["Ana", "Bia", "Caio", "Davi"]

        saved = create_draw(connection, names, 2)
        draws = list_draws(connection, None)

        self.assertEqual(saved["names"], names)
        self.assertEqual(len(saved["groups"]), 2)
        self.assertEqual([len(group) for group in saved["groups"]], [2, 2])
        self.assertEqual(draws[0]["groups"], saved["groups"])
        connection.close()


class APIIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.original_database = server.DATABASE
        server.DATABASE = Path(self.temp_directory.name) / "test.sqlite3"
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), SorteioHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_port}"
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))
        register = Request(
            f"{self.base_url}/api/register",
            data=json.dumps({"name": "Teste", "email": "teste@example.com", "password": "Senha123!"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        self.opener.open(register).close()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        server.DATABASE = self.original_database
        self.temp_directory.cleanup()

    def test_register_rejects_existing_email(self):
        request = Request(
            f"{self.base_url}/api/register",
            data=json.dumps({"name": "Outro", "email": "TESTE@example.com", "password": "Outra123!"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(HTTPError) as error:
            self.opener.open(request)
        self.assertEqual(error.exception.code, 409)
        self.assertEqual(json.load(error.exception)["error"], "Este e-mail já foi utilizado.")

    def test_post_saves_draw_and_get_returns_it(self):
        request = Request(
            f"{self.base_url}/api/draws",
            data=json.dumps(
                {"names": ["Ana", "Bia", "Caio", "Davi"], "group_count": 2}
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with self.opener.open(request) as response:
            self.assertEqual(response.status, 201)
            created = json.load(response)["draw"]
        with self.opener.open(f"{self.base_url}/api/draws") as response:
            draws = json.load(response)["draws"]

        self.assertEqual(len(created["groups"]), 2)
        self.assertEqual([len(group) for group in created["groups"]], [2, 2])
        self.assertEqual(draws[0]["id"], created["id"])

    def test_post_rejects_uneven_groups_without_saving(self):
        request = Request(
            f"{self.base_url}/api/draws",
            data=json.dumps(
                {"names": ["Ana", "Bia", "Caio"], "group_count": 2}
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with self.assertRaises(HTTPError) as error:
            self.opener.open(request)

        self.assertEqual(error.exception.code, 400)
        with self.opener.open(f"{self.base_url}/api/draws") as response:
            self.assertEqual(json.load(response)["draws"], [])


if __name__ == "__main__":
    unittest.main()
