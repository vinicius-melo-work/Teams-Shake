# Teams Shake

O site permite criar uma conta com login e senha, informar participantes, escolher
a quantidade de grupos, validar uma divisão com o mesmo número de pessoas em cada
grupo e salvar os resultados em um banco SQLite. Cada usuário acessa somente seu
próprio histórico. O código do site está separado em `html/`, `css/` e `js/`.

## Executar

É necessário ter Python 3.9 ou superior. No diretório do projeto, execute:

```powershell
python server.py
```

Abra `http://localhost:8000`. O servidor escuta em todas as interfaces de rede
para permitir acesso por outros dispositivos na mesma rede privada. Neles,
acesse o endereço IP do computador que executa o servidor, na porta `8000`.

A marca do sistema é **Teams Shake**. Para usar uma URL amigável na sua máquina,
adicione `127.0.0.1 teams-shake.local` ao arquivo `C:\\Windows\\System32\\drivers\\etc\\hosts`
e acesse `http://teams-shake.local:8000`. O nome da marca não altera a porta do servidor.

**Segurança:** as senhas são armazenadas com hash PBKDF2 e as sessões usam cookie
HttpOnly. Este servidor ainda não oferece HTTPS; use-o somente em uma rede privada
confiável e não o exponha diretamente à internet. Os sorteios e contas são
armazenados em `data/sorteios.sqlite3`, no computador que executa o servidor.

Para alterar a porta, defina a variável de ambiente `PORT`. Para limitar o
servidor a uma interface específica, defina `HOST` antes de iniciá-lo.

## Testes

```powershell
python -m unittest
```
