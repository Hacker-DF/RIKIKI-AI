// L'appel passe par ton Worker Cloudflare (voir worker.js) : les clés API
// ne touchent jamais le navigateur, elles restent secrètes côté serveur.
// Remplace la valeur ci-dessous par l'URL de ton Worker une fois déployé.
const API_URL = "https://ton-worker.ton-sous-compte.workers.dev";

const chatBox = document.getElementById("chatBox");
const MAX_HISTORY = 60; // 30 échanges gardés en contexte
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

if (!chatBox) {
  showErrorBanner("Élément #chatBox introuvable — index.html n'est pas à jour avec script.js.");
}

let history = loadHistory();
let codeBlocks = [];
let currentUser = loadUser();

// --- Banniere d'erreur visible (utile sans devtools mobile) ---
function showErrorBanner(text) {
  let banner = document.getElementById("errorBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "errorBanner";
    banner.className = "error-banner";
    banner.title = "Toucher pour fermer";
    banner.onclick = () => banner.remove();
    document.body.prepend(banner);
  }
  banner.textContent = "🐞 " + text;
}

window.onerror = (message, source, lineno) => {
  showErrorBanner(`${message} (ligne ${lineno})`);
  return false;
};

window.addEventListener("unhandledrejection", (event) => {
  showErrorBanner(`Promesse rejetée : ${event.reason?.message || event.reason}`);
});

// --- Compte utilisateur (email/téléphone/nom/sexe, sans mot de passe) ---
function loadUser() {
  try {
    return JSON.parse(localStorage.getItem("currentUser") || "null");
  } catch {
    return null;
  }
}

function saveUser(user) {
  try {
    localStorage.setItem("currentUser", JSON.stringify(user));
  } catch (e) {
    console.error("Impossible de sauvegarder le profil", e);
  }
}

function showAuthTab(tab) {
  const signupForm = document.getElementById("signupForm");
  const loginForm = document.getElementById("loginForm");
  const tabSignup = document.getElementById("tabSignup");
  const tabLogin = document.getElementById("tabLogin");
  if (!signupForm || !loginForm || !tabSignup || !tabLogin) return;

  if (tab === "signup") {
    signupForm.classList.remove("hidden");
    loginForm.classList.add("hidden");
    tabSignup.classList.add("active");
    tabLogin.classList.remove("active");
  } else {
    signupForm.classList.add("hidden");
    loginForm.classList.remove("hidden");
    tabLogin.classList.add("active");
    tabSignup.classList.remove("active");
  }
}

async function submitSignup() {
  const errorEl = document.getElementById("signupError");
  const val = (id) => document.getElementById(id)?.value.trim() || "";

  const firstName = val("signupFirstName");
  const lastName = val("signupLastName");
  const email = val("signupEmail").toLowerCase();
  const dialCode = val("signupDialCode");
  const phone = val("signupPhone");
  const gender = document.getElementById("signupGender")?.value || "";

  if (!firstName || !lastName || !email || !dialCode || !phone || !gender) {
    if (errorEl) errorEl.textContent = "Merci de remplir tous les champs.";
    return;
  }

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "signup",
        profile: { firstName, lastName, email, dialCode, phone, gender }
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if (errorEl) errorEl.textContent = data.error || "Erreur lors de l'inscription.";
      return;
    }
    currentUser = data.profile;
    saveUser(currentUser);
    enterApp(true);
  } catch (err) {
    if (errorEl) errorEl.textContent = "Connexion au serveur impossible.";
    console.error(err);
  }
}

async function submitLogin() {
  const errorEl = document.getElementById("loginError");
  const email = (document.getElementById("loginEmail")?.value.trim() || "").toLowerCase();

  if (!email) {
    if (errorEl) errorEl.textContent = "Merci d'indiquer ton email.";
    return;
  }

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", email })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      if (errorEl) errorEl.textContent = data.error || "Compte introuvable.";
      return;
    }
    currentUser = data.profile;
    saveUser(currentUser);
    enterApp(false);
  } catch (err) {
    if (errorEl) errorEl.textContent = "Connexion au serveur impossible.";
    console.error(err);
  }
}

function enterApp(isNewAccount) {
  document.getElementById("authScreen")?.classList.add("hidden");
  document.getElementById("appScreen")?.classList.remove("hidden");
  addMessage("bot", genderedGreeting(currentUser, isNewAccount));
}

function genderedGreeting(user, isNew) {
  const name = user?.firstName || "";
  const e = user?.gender === "femme" ? "e" : "";
  return isNew
    ? `Bienvenue ${name} ! 👋 Ravi${e} de faire ta connaissance.`
    : `Content${e} de te revoir, ${name} !`;
}

function logout() {
  try { localStorage.removeItem("currentUser"); } catch {}
  currentUser = null;
  document.getElementById("appScreen")?.classList.add("hidden");
  document.getElementById("authScreen")?.classList.remove("hidden");
  showAuthTab("signup");
}

// --- Persistance de la discussion (localStorage) + expiration 6h ---
function loadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem("chatHistory") || "null");
    const lastActive = parseInt(localStorage.getItem("lastActive") || "0", 10);
    if (saved && Date.now() - lastActive < SIX_HOURS_MS) {
      return saved;
    }
  } catch (e) {
    console.error("Historique illisible, on repart à zéro", e);
  }
  try { localStorage.removeItem("capNoticeShown"); } catch {}
  return [];
}

function saveHistory() {
  try {
    localStorage.setItem("chatHistory", JSON.stringify(history));
    localStorage.setItem("lastActive", String(Date.now()));
  } catch (e) {
    console.error("Impossible de sauvegarder l'historique", e);
  }
}

function restoreChatUI() {
  history.forEach(m => {
    if (m.content === "[Image générée]") {
      addMessage("bot", "🖼️ Image précédente (non conservée après rechargement)");
    } else {
      addMessage(m.role === "user" ? "user" : "bot", m.content);
    }
  });
}

function checkHistoryCap() {
  const exchanges = Math.floor(history.length / 2);
  if (exchanges === 30 && !localStorage.getItem("capNoticeShown")) {
    addMessage("bot", "ℹ️ 30 échanges atteints. Cette discussion reste disponible 6h — au-delà, une nouvelle sera créée automatiquement à ta prochaine visite.");
    try { localStorage.setItem("capNoticeShown", "true"); } catch {}
  }
}

function sendMessage() {
  const input = document.getElementById("userInput");
  if (!input) return showErrorBanner("Élément #userInput introuvable.");
  const userText = input.value.trim();
  if (!userText) return;

  addMessage("user", userText);
  input.value = "";
  getBotResponse(userText);
}

function addMessage(sender, text) {
  if (!chatBox) return;
  const msg = document.createElement("div");
  msg.className = `message ${sender}`;

  const bubble = document.createElement("div");
  bubble.innerHTML = formatMessage(text);
  msg.appendChild(bubble);

  if (sender === "bot") {
    msg.appendChild(createActionBar(text));
  }

  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addImageMessage(base64, mimeType) {
  if (!chatBox) return;
  const msg = document.createElement("div");
  msg.className = "message bot";
  const img = document.createElement("img");
  img.src = `data:${mimeType};base64,${base64}`;
  img.className = "generated-image";
  img.alt = "Image générée";
  msg.appendChild(img);
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function createActionBar(text) {
  const bar = document.createElement("div");
  bar.className = "action-bar";

  const copyBtn = document.createElement("button");
  copyBtn.className = "action-btn";
  copyBtn.textContent = "📋";
  copyBtn.title = "Copier";
  copyBtn.onclick = () => navigator.clipboard?.writeText(text);

  const readBtn = document.createElement("button");
  readBtn.className = "action-btn";
  readBtn.textContent = "🔊";
  readBtn.title = "Lire à voix haute";
  readBtn.onclick = () => {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "fr-FR";
    speechSynthesis.speak(utterance);
  };

  const upBtn = document.createElement("button");
  upBtn.className = "action-btn";
  upBtn.textContent = "👍";
  upBtn.title = "Utile";

  const downBtn = document.createElement("button");
  downBtn.className = "action-btn";
  downBtn.textContent = "👎";
  downBtn.title = "Pas utile";

  upBtn.onclick = () => {
    upBtn.classList.toggle("active");
    downBtn.classList.remove("active");
  };
  downBtn.onclick = () => {
    downBtn.classList.toggle("active");
    upBtn.classList.remove("active");
  };

  bar.append(copyBtn, readBtn, upBtn, downBtn);
  return bar;
}

function formatMessage(text) {
  if (!text.includes("```")) {
    return escapeHtml(text);
  }
  return parseCode(text);
}

function parseCode(text) {
  const regex = /```(\w+)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let result = "";
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result += escapeHtml(text.slice(lastIndex, match.index));
    }
    const lang = (match[1] || "texte").toLowerCase();
    const code = match[2].trim();
    const id = codeBlocks.length;
    codeBlocks.push({ code, lang });
    result += `<div class="code-block">
      <div class="code-header">
        <span class="code-lang">${escapeHtml(lang)}</span>
        <div class="code-actions">
          <button class="code-btn" onclick="copyCode(${id})" title="Copier">📋</button>
          <button class="code-btn" onclick="downloadCode(${id})" title="Télécharger">⬇️</button>
        </div>
      </div>
      <pre><code>${escapeHtml(code)}</code></pre>
    </div>`;
    lastIndex = regex.lastIndex;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function copyCode(id) {
  const block = codeBlocks[id];
  if (block) navigator.clipboard?.writeText(block.code);
}

function downloadCode(id) {
  const block = codeBlocks[id];
  if (!block) return;
  const ext = extForLang(block.lang);
  const blob = new Blob([block.code], { type: "text/plain;charset=utf-8" });
  saveAs(blob, `code_${id}.${ext}`);
}

function extForLang(lang) {
  const map = {
    javascript: "js", js: "js", python: "py", py: "py", html: "html",
    css: "css", java: "java", c: "c", cpp: "cpp", php: "php",
    ruby: "rb", go: "go", rust: "rs", sql: "sql", json: "json",
    bash: "sh", shell: "sh", typescript: "ts", ts: "ts"
  };
  return map[lang] || "txt";
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function getBotResponse(prompt) {
  const sendBtn = document.getElementById("sendBtn");
  const input = document.getElementById("userInput");
  const providerSelect = document.getElementById("providerSelect");
  const provider = providerSelect ? providerSelect.value : "gemini";

  history.push({ role: "user", content: prompt });

  const thinking = document.createElement("div");
  thinking.className = "message bot";
  thinking.innerText = provider === "image" ? "🎨 Génération..." : "⏳ Réflexion...";
  if (chatBox) {
    chatBox.appendChild(thinking);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "chat",
        provider,
        messages: history,
        userName: currentUser?.firstName || null
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `Erreur ${res.status}`);
    }

    thinking.remove();

    if (data.image) {
      addImageMessage(data.image, data.mimeType);
      history.push({ role: "assistant", content: "[Image générée]" });
    } else {
      history.push({ role: "assistant", content: data.text });
      addMessage("bot", data.text);
    }

    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }
    checkHistoryCap();
  } catch (err) {
    thinking.remove();
    addMessage("bot", `⚠️ Erreur : ${err.message || "connexion impossible"}`);
    console.error(err);
    if (history.length && history[history.length - 1].role === "user") {
      history.pop();
    }
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.disabled = false;
    saveHistory();
  }
}

const providerSelectEl = document.getElementById("providerSelect");
if (providerSelectEl) {
  providerSelectEl.addEventListener("change", (e) => {
    const input = document.getElementById("userInput");
    if (input) {
      input.placeholder = e.target.value === "image"
        ? "Décrivez l'image à générer..."
        : "Posez votre question ici...";
    }
  });
}

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("Reconnaissance vocale non supportée par ce navigateur.");
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "fr-FR";
  recognition.start();
  recognition.onresult = (event) => {
    const input = document.getElementById("userInput");
    if (input) input.value = event.results[0][0].transcript;
  };
  recognition.onerror = (event) => {
    alert("Erreur vocale : " + event.error);
  };
}

function downloadChat() {
  const messages = document.querySelectorAll(".message");
  let chatContent = "";
  messages.forEach(msg => {
    chatContent += msg.textContent + "\n";
  });

  const blob = new Blob([chatContent], { type: "text/plain;charset=utf-8" });
  saveAs(blob, "conversation_chatbot.txt");
}

function downloadChatPDF() {
  if (!window.jspdf) return showErrorBanner("Librairie jsPDF non chargée.");
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const messages = document.querySelectorAll(".message");
  let y = 15;

  messages.forEach(msg => {
    const text = msg.textContent.trim();
    if (!text) return;
    const lines = doc.splitTextToSize(text, 180);
    if (y + lines.length * 6 > 285) {
      doc.addPage();
      y = 15;
    }
    doc.text(lines, 10, y);
    y += lines.length * 6 + 6;
  });

  doc.save("conversation_chatbot.pdf");
}

// Thème : on applique et mémorise la préférence
try {
  if (localStorage.getItem("theme") === "light") {
    document.body.classList.add("light");
  }
} catch {}

const toggleThemeEl = document.getElementById("toggleTheme");
if (toggleThemeEl) {
  toggleThemeEl.addEventListener("click", () => {
    document.body.classList.toggle("light");
    try {
      localStorage.setItem("theme", document.body.classList.contains("light") ? "light" : "dark");
    } catch {}
  });
} else {
  showErrorBanner("Élément #toggleTheme introuvable.");
}

// Écran de démarrage : compte existant -> direct dans l'appli, sinon écran auth
if (currentUser) {
  document.getElementById("authScreen")?.classList.add("hidden");
  document.getElementById("appScreen")?.classList.remove("hidden");
}

restoreChatUI();
