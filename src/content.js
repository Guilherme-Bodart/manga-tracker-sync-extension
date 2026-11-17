const MAX_HYDRATION_ATTEMPTS = 5;
const HYDRATION_RETRY_DELAY_MS = 600;

let lastCheckedUrl = "";
let lastSentKey = "";
let retryTimerId = null;
let hydrationAttempt = 0;
let detectionInFlight = false;

function normalizeDomain(value) {
  const trimmed = String(value || "").trim();
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

function shouldRunOnDomain(allowedDomains, hostname) {
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return false;
  }

  const normalizedHost = normalizeDomain(hostname);
  if (!normalizedHost) return false;

  return allowedDomains.some((domain) => {
    const normalizedAllowed = normalizeDomain(domain);
    if (!normalizedAllowed) return false;
    return (
      normalizedHost === normalizedAllowed ||
      normalizedHost.endsWith(`.${normalizedAllowed}`)
    );
  });
}

function clearRetryTimer() {
  if (retryTimerId !== null) {
    clearTimeout(retryTimerId);
    retryTimerId = null;
  }
}

async function detectAndSync() {
  if (detectionInFlight) return;
  detectionInFlight = true;

  try {
    const config = await chrome.storage.sync.get(["enabled", "allowedDomains"]);
    if (!config.enabled) return;
    if (!shouldRunOnDomain(config.allowedDomains, window.location.hostname)) {
      return;
    }

    const detectFn = globalThis.detectMangaPayload;
    if (typeof detectFn !== "function") {
      console.error("detectMangaPayload is not available");
      return;
    }

    const payload = detectFn(document, window.location);
    if (!payload) {
      if (hydrationAttempt < MAX_HYDRATION_ATTEMPTS) {
        hydrationAttempt += 1;
        clearRetryTimer();
        retryTimerId = setTimeout(() => {
          retryTimerId = null;
          void detectAndSync();
        }, HYDRATION_RETRY_DELAY_MS);
      }
      return;
    }

    clearRetryTimer();
    const dedupeKey = `${payload.sourceDomain}:${payload.externalMangaId}:${payload.chapter}`;
    if (dedupeKey === lastSentKey) {
      return;
    }

    lastSentKey = dedupeKey;
    await chrome.runtime.sendMessage({
      type: "MANGA_PROGRESS_DETECTED",
      payload,
    });
  } catch (error) {
    console.warn("Manga Tracker Sync content error:", error);
  } finally {
    detectionInFlight = false;
  }
}

function handleNavigation(force = false) {
  const currentUrl = window.location.href;
  if (!force && currentUrl === lastCheckedUrl) {
    return;
  }

  lastCheckedUrl = currentUrl;
  hydrationAttempt = 0;
  clearRetryTimer();
  void detectAndSync();
}

function installSpaObservers() {
  if (globalThis.__mangaTrackerSpaInstalled) {
    return;
  }
  globalThis.__mangaTrackerSpaInstalled = true;

  const originalPushState = history.pushState.bind(history);
  history.pushState = function patchedPushState(...args) {
    const result = originalPushState(...args);
    handleNavigation();
    return result;
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function patchedReplaceState(...args) {
    const result = originalReplaceState(...args);
    handleNavigation();
    return result;
  };

  window.addEventListener("popstate", () => handleNavigation());
  window.addEventListener("hashchange", () => handleNavigation());

  const targetNode = document.documentElement || document.body;
  if (targetNode && typeof MutationObserver === "function") {
    let mutationTimer = null;
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastCheckedUrl) {
        handleNavigation();
        return;
      }

      if (mutationTimer !== null) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        if (!detectionInFlight && hydrationAttempt < MAX_HYDRATION_ATTEMPTS) {
          void detectAndSync();
        }
      }, 300);
    });

    observer.observe(targetNode, { childList: true, subtree: true });
  }
}

installSpaObservers();
handleNavigation(true);
