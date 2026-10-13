const PALETA = ["#7c5cff", "#3ec6ff", "#ff7ab6", "#ffd166"];
const form = document.getElementById("form-sorteio");
const participantesEl = document.getElementById("participantes");
const adicionarParticipante = document.getElementById("adicionar-participante");
const gruposInput = document.getElementById("quantidade-grupos");
const resumo = document.getElementById("resumo");
const mensagem = document.getElementById("mensagem");
const botao = document.getElementById("sortear");
const gruposEl = document.getElementById("grupos");
const historicoEl = document.getElementById("lista-historico");
const nomeUsuario = document.getElementById("nome-usuario");
const sair = document.getElementById("sair");

function adicionarCampoParticipante(valor = "") {
  const linha = document.createElement("div");
  linha.className = "participante";

  const campo = document.createElement("input");
  campo.type = "text";
  campo.name = "participante";
  campo.placeholder = "Nome do participante";
  campo.value = valor;
  campo.addEventListener("input", validarEntrada);

  const remover = document.createElement("button");
  remover.type = "button";
  remover.className = "botao-remover";
  remover.textContent = "Remover";
  remover.setAttribute("aria-label", "Remover participante");
  remover.addEventListener("click", () => {
    linha.remove();
    validarEntrada();
  });

  linha.append(campo, remover);
  participantesEl.appendChild(linha);
  return campo;
}

function participantesInformados() {
  return [...participantesEl.querySelectorAll("input[name='participante']")]
    .map((campo) => campo.value.trim())
    .filter(Boolean);
}

function validarEntrada() {
  const pessoas = participantesInformados();
  const quantidade = Number(gruposInput.value);
  const quantidadeValida = Number.isSafeInteger(quantidade) && quantidade >= 1;

  if (pessoas.length === 0 || !quantidadeValida) {
    resumo.textContent = "Informe os nomes e uma quantidade válida de grupos.";
    return { valida: false, pessoas, quantidade };
  }
  if (quantidade > pessoas.length) {
    resumo.textContent = `São necessários pelo menos ${quantidade} participantes para formar ${quantidade} grupos.`;
    return { valida: false, pessoas, quantidade };
  }
  if (pessoas.length % quantidade !== 0) {
    resumo.textContent = `${pessoas.length} participantes não podem ser divididos igualmente em ${quantidade} grupos.`;
    return { valida: false, pessoas, quantidade };
  }

  const porGrupo = pessoas.length / quantidade;
  resumo.textContent = `${pessoas.length} participantes · ${quantidade} grupos · ${porGrupo} pessoas por grupo.`;
  return { valida: true, pessoas, quantidade };
}

function criarGrupo(grupo, indice) {
  const card = document.createElement("article");
  card.className = "grupo";
  card.style.setProperty("--tom", PALETA[indice % PALETA.length]);

  const titulo = document.createElement("h2");
  titulo.textContent = `Grupo ${indice + 1}`;
  card.appendChild(titulo);

  grupo.forEach((nome) => {
    const pessoa = document.createElement("div");
    pessoa.className = "pessoa";

    const inicial = document.createElement("div");
    inicial.className = "inicial";
    inicial.setAttribute("aria-hidden", "true");
    inicial.textContent = nome.trim().charAt(0).toLocaleUpperCase("pt-BR");

    const nomeEl = document.createElement("span");
    nomeEl.textContent = nome;

    pessoa.append(inicial, nomeEl);
    card.appendChild(pessoa);
  });

  return card;
}

function exibirGrupos(container, grupos) {
  container.replaceChildren(...grupos.map(criarGrupo));
}

function mostrarVazio(container, texto) {
  const vazio = document.createElement("div");
  vazio.className = "vazio";
  vazio.textContent = texto;
  container.replaceChildren(vazio);
}

function exibirHistorico(sorteios) {
  if (sorteios.length === 0) {
    const vazio = document.createElement("p");
    vazio.className = "vazio";
    vazio.textContent = "Nenhum sorteio salvo ainda.";
    historicoEl.replaceChildren(vazio);
    return;
  }

  const itens = sorteios.map((sorteio) => {
    const detalhe = document.createElement("details");
    detalhe.className = "sorteio-salvo";

    const titulo = document.createElement("summary");
    const data = new Date(sorteio.created_at).toLocaleString("pt-BR");
    titulo.textContent = `${data} · ${sorteio.names.length} participantes · ${sorteio.groups.length} grupos`;
    detalhe.appendChild(titulo);

    const resultado = document.createElement("div");
    resultado.className = "grupos-lista";
    resultado.setAttribute("aria-label", "Grupos deste sorteio");
    exibirGrupos(resultado, sorteio.groups);
    detalhe.appendChild(resultado);
    return detalhe;
  });
  historicoEl.replaceChildren(...itens);
}

async function lerRespostaJson(resposta) {
  const texto = await resposta.text();
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    throw new Error(
      "O servidor do sorteio não está ativo. Feche o Live Server e abra esta página por http://localhost:8000 após executar python server.py."
    );
  }
  if (!resposta.ok) throw new Error(dados.error || "Não foi possível concluir a operação.");
  return dados;
}

async function carregarUsuario() {
  const resposta = await fetch("/api/me");
  const dados = await lerRespostaJson(resposta);
  if (!dados.authenticated) {
    window.location.replace("/html/login.html");
    return false;
  }
  nomeUsuario.textContent = `Olá, ${dados.user.name}`;
  return true;
}

async function carregarHistorico() {
  const resposta = await fetch("/api/draws");
  if (resposta.status === 401) {
    window.location.replace("/html/login.html");
    return;
  }
  const dados = await lerRespostaJson(resposta);
  exibirHistorico(dados.draws);
}

sair.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.replace("/html/login.html");
});

adicionarParticipante.addEventListener("click", () => {
  const campo = adicionarCampoParticipante();
  campo.focus();
  validarEntrada();
});

gruposInput.addEventListener("input", validarEntrada);

adicionarCampoParticipante();
form.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const entrada = validarEntrada();
  if (!entrada.valida) {
    mensagem.className = "erro";
    mensagem.textContent = "Corrija a quantidade de participantes ou de grupos para continuar.";
    return;
  }

  botao.disabled = true;
  mensagem.className = "";
  mensagem.textContent = "Realizando e salvando o sorteio...";
  try {
    const resposta = await fetch("/api/draws", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: entrada.pessoas, group_count: entrada.quantidade }),
    });
    const dados = await lerRespostaJson(resposta);

    exibirGrupos(gruposEl, dados.draw.groups);
    mensagem.textContent = "Sorteio realizado e salvo com sucesso.";
    try {
      await carregarHistorico();
    } catch (erroHistorico) {
      mensagem.className = "erro";
      mensagem.textContent = `Sorteio salvo, mas não foi possível atualizar o histórico: ${erroHistorico.message}`;
    }
  } catch (erro) {
    mensagem.className = "erro";
    mensagem.textContent = erro.message;
  } finally {
    botao.disabled = false;
  }
});

carregarUsuario().then((autenticado) => {
  if (!autenticado) return;
  return carregarHistorico();
}).catch((erro) => {
  historicoEl.replaceChildren();
  mensagem.className = "erro";
  mensagem.textContent = erro.message;
});
