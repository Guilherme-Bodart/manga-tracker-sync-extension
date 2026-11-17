const MAX_TITLE_LENGTH = 300;
const MAX_EXTERNAL_ID_LENGTH = 255;

const CHAPTER_CONTEXT_RE =
  /(?:cap[ií]tulo|chapter|cap\.?|ch\.?)\s*[:#\-]?\s*(\d+)(?:[.,-]\d+)?/i;
const CHAPTER_BARE_RE =
  /^\s*(?:(?:cap[ií]tulo|chapter|cap\.?|ch\.?)\s*[:#\-]?\s*)?(\d+)(?:[.,-]\d+)?\s*$/i;
const CHAPTER_SEGMENT_RE =
  /^(?:cap(?:[ií]tulo)?|chapter|ch|ep(?:isode)?|epis[oó]dio|p[aá]gina|page|p)[-_]?\d+(?:[.-]\d+)?$/i;
const LEADING_ROUTE_SEGMENTS = new Set(["read", "ler", "reader", "view"]);

function parseChapterFromText(value, { requireContext = true } = {}) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(requireContext ? CHAPTER_CONTEXT_RE : CHAPTER_BARE_RE);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function titleizeSlug(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function sanitizeMangaTitle(title) {
  if (!title) return "";
  let cleaned = String(title).replace(/\s+/g, " ").trim();

  cleaned = cleaned
    .replace(
      /^(?:ler(?:\s+mang[aá])?|read(?:\s+manga)?)\s*(?:[:|\-–—]\s*)?/i,
      "",
    )
    .replace(
      /\s*(?:[-|–—]\s*)?(?:cap[ií]tulo|chapter|cap\.?|ch\.?)\s*#?\s*\d+(?:[.,-]\d+)?(?:\s*[-|–—].*)?$/i,
      "",
    )
    .replace(
      /\s*[-|–—]\s*(?:manga\s*livre|mangalivre|ler\s+online|read\s+online|online|pt-?br|leitor|reader|manga\s+tracker).*$/i,
      "",
    )
    .replace(/\s*[-|–—]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, MAX_TITLE_LENGTH).trim();
}

function buildGenericExternalMangaId(pathname, title) {
  const rawSegments = String(pathname || "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  const beforeChapter = [];
  for (const segment of rawSegments) {
    if (CHAPTER_SEGMENT_RE.test(segment)) {
      break;
    }
    if (/^\d+$/.test(segment) && beforeChapter.length > 0) {
      break;
    }
    beforeChapter.push(segment);
  }

  while (
    beforeChapter.length > 1 &&
    LEADING_ROUTE_SEGMENTS.has(beforeChapter[0].toLowerCase())
  ) {
    beforeChapter.shift();
  }

  const pathSlug = beforeChapter
    .slice(0, 2)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (pathSlug) {
    return pathSlug.slice(0, MAX_EXTERNAL_ID_LENGTH);
  }

  const titleSlug = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return titleSlug.slice(0, MAX_EXTERNAL_ID_LENGTH);
}

function parseMangaLivre(documentRef, locationRef) {
  const match = locationRef.pathname.match(
    /^\/manga\/([^/]+)\/(?:capitulo|cap)-(\d+)(?:[.-]\d+)?(?:\/.*)?$/i,
  );
  if (!match) {
    return null;
  }

  const mangaSlug = match[1].toLowerCase().slice(0, MAX_EXTERNAL_ID_LENGTH);
  const chapter = Number.parseInt(match[2], 10);
  if (!Number.isInteger(chapter) || chapter < 0) {
    return null;
  }

  const ogTitle = documentRef
    .querySelector("meta[property='og:title']")
    ?.getAttribute("content");
  const h1Title = documentRef.querySelector("h1")?.textContent;
  const pageTitle = documentRef.title;

  const title =
    sanitizeMangaTitle(ogTitle) ||
    sanitizeMangaTitle(h1Title) ||
    sanitizeMangaTitle(pageTitle) ||
    sanitizeMangaTitle(titleizeSlug(mangaSlug));

  if (!title || !mangaSlug) {
    return null;
  }

  return {
    title,
    chapter,
    externalMangaId: mangaSlug,
    sourceDomain: locationRef.hostname,
  };
}

function parseGeneric(documentRef, locationRef) {
  const rawTitleCandidates = [
    documentRef.querySelector("meta[property='og:title']")?.getAttribute("content"),
    documentRef.querySelector("h1")?.textContent,
    documentRef.title,
  ].filter(Boolean);

  let title = "";
  for (const candidate of rawTitleCandidates) {
    title = sanitizeMangaTitle(candidate);
    if (title) break;
  }

  if (!title) {
    return null;
  }

  const explicitChapterHints = [
    documentRef.querySelector("meta[name='chapter']")?.getAttribute("content"),
    documentRef.querySelector("[data-chapter]")?.getAttribute("data-chapter"),
  ].filter(Boolean);

  let chapter = null;
  for (const hint of explicitChapterHints) {
    chapter = parseChapterFromText(hint, { requireContext: false });
    if (chapter !== null) break;
  }

  if (chapter === null) {
    const contextualHints = [
      locationRef.pathname,
      documentRef.querySelector(".chapter")?.textContent,
      documentRef.querySelector("h1")?.textContent,
      documentRef.title,
      documentRef.body?.textContent?.slice(0, 2000),
    ].filter(Boolean);

    for (const hint of contextualHints) {
      chapter = parseChapterFromText(hint, { requireContext: true });
      if (chapter !== null) break;
    }
  }

  if (chapter === null) {
    return null;
  }

  const externalMangaId = buildGenericExternalMangaId(
    locationRef.pathname,
    title,
  );
  if (!externalMangaId) {
    return null;
  }

  return {
    title,
    chapter,
    externalMangaId,
    sourceDomain: locationRef.hostname,
  };
}

function detectMangaPayload(documentRef, locationRef) {
  const hostname = locationRef.hostname.toLowerCase();
  if (hostname === "mangalivre.tv" || hostname.endsWith(".mangalivre.tv")) {
    return parseMangaLivre(documentRef, locationRef);
  }

  return parseGeneric(documentRef, locationRef);
}

globalThis.detectMangaPayload = detectMangaPayload;
