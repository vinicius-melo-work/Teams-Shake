const abaLogin = document.getElementById("aba-login");
const abaCadastro = document.getElementById("aba-cadastro");
const formularioLogin = document.getElementById("form-login");
const formularioCadastro = document.getElementById("form-cadastro");
const titulo = document.getElementById("titulo-autenticacao");
const subtitulo = document.getElementById("subtitulo-autenticacao");
const cadastroSenha = document.getElementById("cadastro-password");
const cadastroConfirmacao = document.getElementById("cadastro-password-confirmacao");

function senhaValida(password) {
  return {
    tamanho: password.length >= 8,
    minuscula: /[a-z]/.test(password),
    maiuscula: /[A-Z]/.test(password),
    numero: /\d/.test(password),
    especial: /[^A-Za-z0-9]/.test(password),
  };
}

function atualizarRequisitosSenha() {
  const requisitos = senhaValida(cadastroSenha.value);
  Object.entries(requisitos).forEach(([nome, valido]) => {
    const requisito = document.querySelector(`[data-requisito="${nome}"]`);
    requisito.classList.toggle("cumprido", valido);
    requisito.querySelector(".requisito-icone").textContent = valido ? "✓" : "×";
  });
}

cadastroSenha.addEventListener("input", atualizarRequisitosSenha);

atualizarRequisitosSenha();

function selecionarAba(cadastro) {
  abaLogin.classList.toggle("ativo", !cadastro);
  abaCadastro.classList.toggle("ativo", cadastro);
  abaLogin.setAttribute("aria-selected", String(!cadastro));
  abaCadastro.setAttribute("aria-selected", String(cadastro));
  formularioLogin.classList.toggle("oculto", cadastro);
  formularioCadastro.classList.toggle("oculto", !cadastro);
  titulo.textContent = cadastro ? "Crie sua conta" : "Bem-vindo de volta";
  subtitulo.textContent = cadastro
    ? "Comece a organizar os sorteios do seu time hoje."
    : "Entre para acessar seus sorteios e continuar de onde parou.";
}

abaLogin.addEventListener("click", () => selecionarAba(false));
abaCadastro.addEventListener("click", () => selecionarAba(true));

async function lerRespostaJson(resposta) {
  const dados = await resposta.json();
  if (!resposta.ok) throw new Error(dados.error || "Não foi possível concluir a operação.");
  return dados;
}

function validarFormularioLogin() {
  const email = document.getElementById("login-email");
  const senha = document.getElementById("login-password");
  if (!email.validity.valid) return "Informe um e-mail válido para continuar.";
  if (!senha.value) return "Informe sua senha para continuar.";
  return "";
}

function configurarFormulario(id, endpoint, obterDados, mensagemId) {
  const formulario = document.getElementById(id);
  const mensagem = document.getElementById(mensagemId);
  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = formulario.querySelector("button");
    botao.disabled = true;
    mensagem.className = "";
    mensagem.textContent = "";
    try {
      if (id === "form-login") {
        const erroLogin = validarFormularioLogin();
        if (erroLogin) throw new Error(erroLogin);
      }
      if (id === "form-cadastro") {
        const requisitos = senhaValida(cadastroSenha.value);
        if (!Object.values(requisitos).every(Boolean)) {
          throw new Error("Sua senha ainda não atende a todos os requisitos acima.");
        }
        if (cadastroSenha.value !== cadastroConfirmacao.value) {
          throw new Error("As senhas informadas não coincidem. Verifique e tente novamente.");
        }
      }
      mensagem.textContent = id === "form-login" ? "Entrando..." : "Criando sua conta...";
      await lerRespostaJson(await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(obterDados()),
      }));
      window.location.replace("/html/index.html");
    } catch (erro) {
      mensagem.className = "erro";
      if (id === "form-login" && (erro.message.includes("incorretos") || erro.message.includes("senha"))) {
        mensagem.textContent = "Não foi possível entrar. Confira seu e-mail e sua senha e tente novamente.";
      } else {
        mensagem.textContent = erro.message;
      }
    } finally {
      botao.disabled = false;
    }
  });
}

configurarFormulario(
  "form-login",
  "/api/login",
  () => ({
    email: document.getElementById("login-email").value,
    password: document.getElementById("login-password").value,
  }),
  "mensagem-login",
);

configurarFormulario(
  "form-cadastro",
  "/api/register",
  () => ({
    name: document.getElementById("cadastro-nome").value,
    email: document.getElementById("cadastro-email").value,
    password: cadastroSenha.value,
  }),
  "mensagem-cadastro",
);
