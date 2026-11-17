const DEFAULT_API_BASE_URL = "http://localhost:3001";

let statusTimerId = null;

function byId(id) {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing element: ${id}`);
  }
  return node;
}

function setStatus(message, { isError = false, autoClearMs = 0 } = {}) {
  if (statusTimerId !== null) {
    clearTimeout(statusTimerId);
    statusTimerId = null;
  }

  const status = byId("status");
  status.textContent = message;
  status.classList.toggle("error", Boolean(isError));

  if (autoClearMs > 0) {
    statusTimerId = setTimeout(() => {
      status.textContent = "";
      status.classList.remove("error");
      statusTimerId = null;
    }, autoClearMs);
  }
}

function isLocalHttpHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]"
  );
}

function normalizeAndValidateApiBaseUrl(rawUrl) {
  const candidate = String(rawUrl || DEFAULT_API_BASE_URL).trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol === "https:") {
    return parsed.toString().replace(/\/+$/, "");
  }

  if (parsed.protocol === "http:" && isLocalHttpHost(parsed.hostname)) {
    return parsed.toString().replace(/\/+$/, "");
  }

  return null;
}

function normalizeDomainEntry(rawEntry) {
  const trimmed = String(rawEntry || "").trim();
  if (!trimmed) return "";

  let hostname = trimmed;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    hostname = new URL(withScheme).hostname;
  } catch {
    hostname = trimmed.split("/")[0].split(":")[0];
  }

  return hostname.trim().toLowerCase().replace(/^www\./, "");
}

function parseAllowedDomains(rawText, extraDomain = "") {
  const entries = String(rawText || "")
    .split("\n")
    .map(normalizeDomainEntry)
    .filter(Boolean);

  const normalizedExtra = normalizeDomainEntry(extraDomain);
  if (normalizedExtra) {
    entries.push(normalizedExtra);
  }

  return Array.from(new Set(entries));
}

async function getAccessTokenWithMigration() {
  const localData = await chrome.storage.local.get(["accessToken"]);
  if (typeof localData.accessToken === "string" && localData.accessToken.trim()) {
    return localData.accessToken.trim();
  }

  const syncData = await chrome.storage.sync.get(["accessToken"]);
  if (typeof syncData.accessToken === "string" && syncData.accessToken.trim()) {
    const migratedToken = syncData.accessToken.trim();
    await chrome.storage.local.set({ accessToken: migratedToken });
    await chrome.storage.sync.remove("accessToken");
    return migratedToken;
  }

  return "";
}

async function clearWarningBadge() {
  try {
    if (chrome.action?.setBadgeText) {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    // Ignore if badge API is unavailable in options context.
  }
}

async function load() {
  const [syncData, accessToken] = await Promise.all([
    chrome.storage.sync.get([
      "enabled",
      "apiBaseUrl",
      "partnerSlug",
      "allowedDomains",
    ]),
    getAccessTokenWithMigration(),
  ]);

  const normalizedDomains = Array.isArray(syncData.allowedDomains)
    ? Array.from(
        new Set(syncData.allowedDomains.map(normalizeDomainEntry).filter(Boolean)),
      )
    : [];

  byId("enabled").checked = Boolean(syncData.enabled);
  byId("apiBaseUrl").value = syncData.apiBaseUrl || DEFAULT_API_BASE_URL;
  byId("partnerSlug").value = syncData.partnerSlug || "";
  byId("accessToken").value = accessToken;
  byId("allowedDomains").value = normalizedDomains.join("\n");
  byId("sourceDomain").value = normalizedDomains[0] || "";
}

async function save() {
  const enabled = byId("enabled").checked;
  const apiBaseUrl = normalizeAndValidateApiBaseUrl(byId("apiBaseUrl").value);
  if (!apiBaseUrl) {
    setStatus(
      "URL da API inválida. Use HTTPS (ou HTTP apenas para localhost/127.0.0.1).",
      { isError: true },
    );
    return;
  }

  const partnerSlug = byId("partnerSlug").value.trim();
  const accessToken = byId("accessToken").value.trim();
  const allowedDomains = parseAllowedDomains(byId("allowedDomains").value);

  byId("apiBaseUrl").value = apiBaseUrl;
  byId("allowedDomains").value = allowedDomains.join("\n");

  await Promise.all([
    chrome.storage.sync.set({
      enabled,
      apiBaseUrl,
      partnerSlug,
      allowedDomains,
    }),
    chrome.storage.sync.remove("accessToken"),
    accessToken
      ? chrome.storage.local.set({ accessToken })
      : chrome.storage.local.remove("accessToken"),
  ]);

  if (accessToken) {
    await clearWarningBadge();
  }

  setStatus("Configurações salvas.", { autoClearMs: 1800 });
}

async function exchangeCode() {
  const apiBaseUrl = normalizeAndValidateApiBaseUrl(byId("apiBaseUrl").value);
  if (!apiBaseUrl) {
    setStatus(
      "URL da API inválida. Use HTTPS (ou HTTP apenas para localhost/127.0.0.1).",
      { isError: true },
    );
    return;
  }

  const partnerSlug = byId("partnerSlug").value.trim();
  const connectCode = byId("connectCode").value.trim();
  const clientSecret = byId("clientSecret").value.trim();
  const sourceDomain = normalizeDomainEntry(byId("sourceDomain").value);

  if (!partnerSlug || !connectCode) {
    setStatus("Preencha URL da API, slug do parceiro e código de conexão.", {
      isError: true,
    });
    return;
  }

  const payload = {
    partnerSlug,
    code: connectCode,
  };
  if (clientSecret) {
    payload.clientSecret = clientSecret;
  }
  if (sourceDomain) {
    payload.sourceDomain = sourceDomain;
  }

  setStatus("Trocando código...");
  try {
    const response = await fetch(`${apiBaseUrl}/integrations/connect/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      setStatus(`Falha ao trocar código (${response.status}): ${text}`, {
        isError: true,
      });
      return;
    }

    const data = await response.json();
    if (!data?.accessToken || typeof data.accessToken !== "string") {
      setStatus("Resposta sem accessToken.", { isError: true });
      return;
    }

    const accessToken = data.accessToken.trim();
    const allowedDomains = parseAllowedDomains(
      byId("allowedDomains").value,
      sourceDomain,
    );

    byId("apiBaseUrl").value = apiBaseUrl;
    byId("accessToken").value = accessToken;
    byId("allowedDomains").value = allowedDomains.join("\n");
    byId("enabled").checked = true;

    await Promise.all([
      chrome.storage.local.set({ accessToken }),
      chrome.storage.sync.remove("accessToken"),
      chrome.storage.sync.set({
        enabled: true,
        apiBaseUrl,
        partnerSlug,
        allowedDomains,
      }),
    ]);

    await clearWarningBadge();
    setStatus("Token atualizado e configurações salvas automaticamente.");
  } catch (error) {
    setStatus(
      `Erro na troca: ${error instanceof Error ? error.message : "desconhecido"}`,
      { isError: true },
    );
  }
}

byId("saveBtn").addEventListener("click", () => {
  void save();
});
byId("exchangeBtn").addEventListener("click", () => {
  void exchangeCode();
});

void load();
