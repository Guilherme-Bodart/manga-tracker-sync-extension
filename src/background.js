const DEFAULT_API_BASE_URL = "http://localhost:3001";
const SYNC_QUEUE_KEY = "syncQueue";
const FETCH_TIMEOUT_MS = 10000;
const MAX_QUEUE_SIZE = 50;
const MAX_RETRY_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 5000;

let refreshInFlight = null;
let queueChain = Promise.resolve();
let retryTimerId = null;

function withQueueLock(task) {
  const next = queueChain.then(task, task);
  queueChain = next.catch(() => {});
  return next;
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

async function getConfig() {
  const [syncData, accessToken] = await Promise.all([
    chrome.storage.sync.get(["apiBaseUrl", "partnerSlug", "enabled"]),
    getAccessTokenWithMigration(),
  ]);

  return {
    apiBaseUrl: syncData.apiBaseUrl,
    partnerSlug: syncData.partnerSlug,
    enabled: Boolean(syncData.enabled),
    accessToken,
  };
}

function buildIdempotencyKey(payload) {
  const nowBucket = Math.floor(Date.now() / 60000);
  return `${payload.sourceDomain}:${payload.externalMangaId}:${payload.chapter}:${nowBucket}`;
}

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timerId);
  }
}

async function setAuthWarningBadge(active) {
  try {
    if (active) {
      await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
      await chrome.action.setBadgeText({ text: "!" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    // Ignore badge errors in contexts where action API is unavailable.
  }
}

async function refreshAccessToken(apiBaseUrl, currentToken) {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      const response = await fetchWithTimeout(
        `${apiBaseUrl}/integrations/connect/refresh`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${currentToken}`,
          },
        },
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      if (!data?.accessToken || typeof data.accessToken !== "string") {
        return null;
      }

      const nextToken = data.accessToken.trim();
      if (!nextToken) return null;

      await chrome.storage.local.set({ accessToken: nextToken });
      await chrome.storage.sync.remove("accessToken");
      await setAuthWarningBadge(false);
      return nextToken;
    } catch (error) {
      console.error("Integration token refresh failed:", error);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isValidPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (typeof payload.externalMangaId !== "string" || !payload.externalMangaId.trim()) {
    return false;
  }
  if (typeof payload.title !== "string" || !payload.title.trim()) {
    return false;
  }
  if (typeof payload.sourceDomain !== "string" || !payload.sourceDomain.trim()) {
    return false;
  }
  return Number.isInteger(payload.chapter) && payload.chapter >= 0;
}

async function readQueue() {
  const data = await chrome.storage.local.get([SYNC_QUEUE_KEY]);
  return Array.isArray(data[SYNC_QUEUE_KEY]) ? data[SYNC_QUEUE_KEY] : [];
}

async function writeQueue(queue) {
  await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
}

async function enqueueRetryItem(item) {
  await withQueueLock(async () => {
    const queue = await readQueue();
    const dedupeKey = `${item.body.sourceDomain}:${item.body.externalMangaId}:${item.body.chapter}`;
    const filtered = queue.filter(
      (existing) =>
        `${existing.body?.sourceDomain}:${existing.body?.externalMangaId}:${existing.body?.chapter}` !==
        dedupeKey,
    );
    filtered.push(item);
    const trimmed = filtered.slice(-MAX_QUEUE_SIZE);
    await writeQueue(trimmed);
  });
}

function scheduleQueueRetry(delayMs = BASE_RETRY_DELAY_MS) {
  if (retryTimerId !== null) return;
  retryTimerId = setTimeout(() => {
    retryTimerId = null;
    void flushRetryQueue();
  }, delayMs);
}

async function sendSingleSyncRequest(apiBaseUrl, accessToken, item) {
  return fetchWithTimeout(`${apiBaseUrl}/integrations/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "x-idempotency-key": item.idempotencyKey,
    },
    body: JSON.stringify(item.body),
  });
}

async function executeSyncItem(apiBaseUrl, config, item) {
  let token = config.accessToken;
  let response;

  try {
    response = await sendSingleSyncRequest(apiBaseUrl, token, item);
  } catch (error) {
    console.error("Integration sync network error:", error);
    return { ok: false, retryable: true, error: "network_error" };
  }

  if (response.status === 401) {
    const refreshedToken = await refreshAccessToken(apiBaseUrl, token);
    if (!refreshedToken) {
      await setAuthWarningBadge(true);
      console.error("Integration sync unauthorized and refresh failed.");
      return { ok: false, retryable: false, error: "unauthorized" };
    }

    token = refreshedToken;
    config.accessToken = refreshedToken;
    try {
      response = await sendSingleSyncRequest(apiBaseUrl, token, item);
    } catch (error) {
      console.error("Integration sync retry after refresh failed:", error);
      return { ok: false, retryable: true, error: "network_error" };
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("Integration sync failed:", response.status, text);
    if (response.status === 401) {
      await setAuthWarningBadge(true);
    }
    return {
      ok: false,
      retryable: isRetryableStatus(response.status),
      error: `http_${response.status}`,
    };
  }

  await setAuthWarningBadge(false);
  const data = await response.json().catch(() => null);
  console.log("Integration sync success:", data);
  return { ok: true, retryable: false, data };
}

async function flushRetryQueue() {
  const config = await getConfig();
  if (!config.enabled || !config.partnerSlug || !config.accessToken) {
    return;
  }

  const apiBaseUrl = normalizeAndValidateApiBaseUrl(config.apiBaseUrl);
  if (!apiBaseUrl) {
    return;
  }

  const items = await withQueueLock(async () => {
    const queue = await readQueue();
    if (queue.length === 0) return [];
    await writeQueue([]);
    return queue;
  });

  if (items.length === 0) return;

  const now = Date.now();
  const remaining = [];
  let minNextDelay = null;

  for (const item of items) {
    if (item.nextRetryAt && item.nextRetryAt > now) {
      remaining.push(item);
      const waitMs = item.nextRetryAt - now;
      minNextDelay = minNextDelay === null ? waitMs : Math.min(minNextDelay, waitMs);
      continue;
    }

    const result = await executeSyncItem(apiBaseUrl, config, item);
    if (!result.ok && result.retryable) {
      const nextAttempts = (item.attempts || 0) + 1;
      if (nextAttempts < MAX_RETRY_ATTEMPTS) {
        const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, nextAttempts - 1);
        remaining.push({
          ...item,
          attempts: nextAttempts,
          nextRetryAt: Date.now() + delayMs,
        });
        minNextDelay = minNextDelay === null ? delayMs : Math.min(minNextDelay, delayMs);
      }
    }
  }

  if (remaining.length > 0) {
    await withQueueLock(async () => {
      const current = await readQueue();
      const merged = [...remaining, ...current].slice(-MAX_QUEUE_SIZE);
      await writeQueue(merged);
    });
    scheduleQueueRetry(minNextDelay ?? BASE_RETRY_DELAY_MS);
  }
}

async function sendSync(payload) {
  if (!isValidPayload(payload)) {
    return { ok: false, error: "invalid_payload" };
  }

  const config = await getConfig();
  if (!config.enabled) {
    return { ok: false, error: "disabled" };
  }
  if (!config.partnerSlug || !config.accessToken) {
    return { ok: false, error: "missing_credentials" };
  }

  const apiBaseUrl = normalizeAndValidateApiBaseUrl(config.apiBaseUrl);
  if (!apiBaseUrl) {
    console.error("Blocked insecure or invalid API base URL:", config.apiBaseUrl);
    return { ok: false, error: "insecure_or_invalid_api_url" };
  }

  const item = {
    idempotencyKey: buildIdempotencyKey(payload),
    attempts: 0,
    nextRetryAt: 0,
    body: {
      partnerSlug: config.partnerSlug,
      externalMangaId: payload.externalMangaId.trim().slice(0, 255),
      title: payload.title.trim().slice(0, 300),
      chapter: payload.chapter,
      sourceDomain: payload.sourceDomain.trim().slice(0, 255),
    },
  };

  const result = await executeSyncItem(apiBaseUrl, config, item);
  if (!result.ok && result.retryable) {
    await enqueueRetryItem({
      ...item,
      attempts: 1,
      nextRetryAt: Date.now() + BASE_RETRY_DELAY_MS,
    });
    scheduleQueueRetry(BASE_RETRY_DELAY_MS);
    return { ok: false, queued: true, error: result.error };
  }

  if (result.ok) {
    void flushRetryQueue();
  }

  return result;
}

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void flushRetryQueue();
});

chrome.runtime.onInstalled.addListener(() => {
  void flushRetryQueue();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id) {
    return false;
  }

  if (message?.type === "MANGA_PROGRESS_DETECTED" && message.payload) {
    void sendSync(message.payload)
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        console.error("Unexpected sendSync error:", error);
        sendResponse({ ok: false, error: "unexpected_error" });
      });
    return true;
  }

  return false;
});
