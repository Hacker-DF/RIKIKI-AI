// Domaine autorisé à appeler ce Worker — remplace par ton vrai domaine de prod
const ALLOWED_ORIGIN = "https://ton-domaine.com";

const SYSTEM_PROMPT = "Tu es un assistant expert et pédagogue. Tu maîtrises le développement web, mobile et logiciel, la programmation dans tous les langages, les réseaux et la sécurité informatique, la cybersécurité et le hacking éthique (uniquement dans un cadre légal, défensif et pédagogique), la rédaction de lettres professionnelles et personnelles, la recherche d'information, et la détection/correction de bugs dans du code. Donne des conseils clairs, concrets et pratiques.";

function buildSystemPrompt(userName, lang) {
  let prompt = SYSTEM_PROMPT;
  prompt += lang === "en"
    ? " Always respond in English, regardless of the language the user writes in."
    : " Réponds toujours en français, quelle que soit la langue utilisée par l'utilisateur.";
  if (userName) {
    prompt += lang === "en"
      ? ` You are talking with ${userName}. Address them by their first name naturally from time to time, without overdoing it.`
      : ` Tu discutes avec ${userName}. Adresse-toi à elle/lui par son prénom de temps en temps, de façon naturelle, sans exagérer.`;
  }
  return prompt;
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    if (request.method !== "POST") {
      return json({ error: "Méthode non autorisée" }, 405, headers);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "JSON invalide" }, 400, headers);
    }

    const action = body?.action || "chat";

    // Un seul try/catch pour tout : la moindre erreur imprévue renvoie du
    // JSON avec les bons en-têtes CORS au lieu de planter sans réponse lisible.
    try {
      if (action === "signup") return await handleSignup(body, env, headers);
      if (action === "login") return await handleLogin(body, env, headers);
      if (action === "listConversations") return await handleListConversations(body, env, headers);
      if (action === "getConversation") return await handleGetConversation(body, env, headers);
      if (action === "saveConversation") return await handleSaveConversation(body, env, headers);

      // action === "chat" (comportement existant)
      const messages = body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return json({ error: "Champ 'messages' manquant" }, 400, headers);
      }

      const provider = body.provider || "gemini";
      const userName = body.userName || null;
      const lang = body.lang === "en" ? "en" : "fr";
      let result;

      switch (provider) {
        case "claude": result = await callClaude(messages, env, userName, lang); break;
        case "openai": result = await callOpenAI(messages, env, userName, lang); break;
        case "grok": result = await callGrok(messages, env, userName, lang); break;
        case "image": result = await callImage(messages, env); break;
        default: result = await callGemini(messages, env, userName, lang);
      }

      return json(result, 200, headers);
    } catch (err) {
      return json({ error: err.message || "Erreur inconnue" }, 502, headers);
    }
  }
};

// =====================================================================
// COMPTES : pseudo (identifiant unique) + nom + prénom + mot de passe.
// DISCUSSIONS : une liste par pseudo + le contenu de chaque discussion.
// Tout est stocké comme du JSON dans Cloudflare KV (binding "USERS_KV") :
//   user:{pseudo}       -> profil (pseudo, nom, prenom, hash mdp)
//   convlist:{pseudo}   -> [{id, title, updatedAt}, ...]   (index léger)
//   conv:{pseudo}:{id}  -> {id, messages:[...], updatedAt} (contenu complet)
// Invité (pas de pseudo) : chat fonctionnel, mais rien n'est sauvegardé.
// =====================================================================

async function handleSignup(body, env, headers) {
  if (!env.USERS_KV) return json({ error: "Binding USERS_KV manquant" }, 500, headers);

  const p = body.profile || {};
  const pseudo = normalizePseudo(p.pseudo || "");
  const nom = (p.nom || "").trim();
  const prenom = (p.prenom || "").trim();
  const password = p.password || "";

  if (!pseudo || !nom || !prenom || !password) {
    return json({ error: "Tous les champs sont obligatoires" }, 400, headers);
  }
  if (!isPasswordStrong(password)) {
    return json({ error: "Mot de passe : 8 caractères min., avec majuscule, minuscule, chiffre et caractère spécial" }, 400, headers);
  }

  const existing = await env.USERS_KV.get(`user:${pseudo}`);
  if (existing) {
    return json({ error: "Ce pseudo est déjà utilisé" }, 409, headers);
  }

  const { hashHex, saltHex } = await hashPassword(password);
  const profile = { pseudo, nom, prenom, passwordHash: hashHex, passwordSalt: saltHex };
  await env.USERS_KV.put(`user:${pseudo}`, JSON.stringify(profile));

  return json({ profile: safeProfile(profile) }, 200, headers);
}

async function handleLogin(body, env, headers) {
  if (!env.USERS_KV) return json({ error: "Binding USERS_KV manquant" }, 500, headers);

  const pseudo = normalizePseudo(body.pseudo || "");
  const password = body.password || "";
  if (!pseudo || !password) return json({ error: "Pseudo et mot de passe requis" }, 400, headers);

  const raw = await env.USERS_KV.get(`user:${pseudo}`);
  if (!raw) return json({ error: "Aucun compte trouvé avec ce pseudo" }, 404, headers);
  const profile = JSON.parse(raw);

  const valid = await verifyPassword(password, profile.passwordSalt, profile.passwordHash);
  if (!valid) return json({ error: "Mot de passe incorrect" }, 401, headers);

  return json({ profile: safeProfile(profile) }, 200, headers);
}

async function handleListConversations(body, env, headers) {
  if (!env.USERS_KV) return json({ error: "Binding USERS_KV manquant" }, 500, headers);
  const pseudo = normalizePseudo(body.pseudo || "");
  if (!pseudo) return json({ error: "Pseudo requis" }, 400, headers);

  const raw = await env.USERS_KV.get(`convlist:${pseudo}`);
  return json({ conversations: raw ? JSON.parse(raw) : [] }, 200, headers);
}

async function handleGetConversation(body, env, headers) {
  if (!env.USERS_KV) return json({ error: "Binding USERS_KV manquant" }, 500, headers);
  const pseudo = normalizePseudo(body.pseudo || "");
  const id = (body.id || "").trim();
  if (!pseudo || !id) return json({ error: "Pseudo et id requis" }, 400, headers);

  const raw = await env.USERS_KV.get(`conv:${pseudo}:${id}`);
  if (!raw) return json({ error: "Discussion introuvable" }, 404, headers);
  return json({ conversation: JSON.parse(raw) }, 200, headers);
}

async function handleSaveConversation(body, env, headers) {
  if (!env.USERS_KV) return json({ error: "Binding USERS_KV manquant" }, 500, headers);
  const pseudo = normalizePseudo(body.pseudo || "");
  if (!pseudo) return json({ error: "Pseudo requis" }, 400, headers);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  let id = (body.id || "").trim();
  const isNew = !id;
  if (isNew) id = crypto.randomUUID();

  const listRaw = await env.USERS_KV.get(`convlist:${pseudo}`);
  let list = listRaw ? JSON.parse(listRaw) : [];
  const idx = list.findIndex(c => c.id === id);

  let title = idx >= 0 ? list[idx].title : "Sans titre";
  if (isNew) {
    const firstUserMsg = messages.find(m => m.role === "user");
    if (firstUserMsg) {
      title = firstUserMsg.content.slice(0, 40) + (firstUserMsg.content.length > 40 ? "…" : "");
    }
  }

  const updatedAt = Date.now();
  await env.USERS_KV.put(`conv:${pseudo}:${id}`, JSON.stringify({ id, messages, updatedAt }));

  const entry = { id, title, updatedAt };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  await env.USERS_KV.put(`convlist:${pseudo}`, JSON.stringify(list));

  return json({ id, title }, 200, headers);
}

function isPasswordStrong(pwd) {
  return pwd.length >= 8
    && /[A-Z]/.test(pwd)
    && /[a-z]/.test(pwd)
    && /[0-9]/.test(pwd)
    && /[^A-Za-z0-9]/.test(pwd);
}

function normalizePseudo(pseudo) {
  return pseudo.trim().toLowerCase();
}

function safeProfile(profile) {
  const { passwordHash, passwordSalt, ...rest } = profile;
  return rest;
}

// --- Hash de mot de passe : PBKDF2-SHA256 via Web Crypto (natif aux Workers) ---
async function hashPassword(password, existingSaltHex) {
  const salt = existingSaltHex ? hexToBytes(existingSaltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  return { hashHex: bytesToHex(new Uint8Array(derived)), saltHex: bytesToHex(salt) };
}

async function verifyPassword(password, saltHex, expectedHashHex) {
  const { hashHex } = await hashPassword(password, saltHex);
  return hashHex === expectedHashHex;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// =====================================================================
// IA
// =====================================================================

async function callGemini(messages, env, userName, lang) {
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(userName, lang) }] },
        contents
      })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Erreur Gemini ${res.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Réponse Gemini vide ou bloquée");
  return { text };
}

async function callClaude(messages, env, userName, lang) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: buildSystemPrompt(userName, lang),
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Erreur Claude ${res.status}`);
  const text = data?.content?.find(b => b.type === "text")?.text;
  if (!text) throw new Error("Réponse Claude vide");
  return { text };
}

async function callOpenAI(messages, env, userName, lang) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5.6",
      messages: [
        { role: "system", content: buildSystemPrompt(userName, lang) },
        ...messages.map(m => ({ role: m.role, content: m.content }))
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Erreur ChatGPT ${res.status}`);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Réponse ChatGPT vide");
  return { text };
}

async function callGrok(messages, env, userName, lang) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "grok-4.3",
      messages: [
        { role: "system", content: buildSystemPrompt(userName, lang) },
        ...messages.map(m => ({ role: m.role, content: m.content }))
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Erreur Grok ${res.status}`);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Réponse Grok vide");
  return { text };
}

async function callImage(messages, env) {
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  if (!lastUser) throw new Error("Aucun prompt fourni pour l'image");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: lastUser.content }] }] })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Erreur image ${res.status}`);
  const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData || p.inline_data);
  const inline = part?.inlineData || part?.inline_data;
  if (!inline) throw new Error("Pas d'image générée (prompt probablement bloqué)");
  return { image: inline.data, mimeType: inline.mimeType || inline.mime_type || "image/png" };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

// ⚠️ Temporaire pendant le développement : accepte n'importe quelle origine,
// pour éviter que ALLOWED_ORIGIN (jamais renseigné) ne bloque silencieusement
// les appels. Donne le domaine réel du site quand il sera stable, pour qu'on
// repasse à une whitelist stricte.
function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  // "null" est l'Origin envoyée par les navigateurs en test local (file://) —
  // la renvoyer telle quelle comme ACAO est peu fiable selon les navigateurs,
  // donc on force un vrai wildcard dans ce cas.
  const allowOrigin = (!origin || origin === "null") ? "*" : origin;
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
