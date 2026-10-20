(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.DailySongSearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalize(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase("ja")
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function fold(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase("ja").trim();
  }

  function normalizeLiteral(value) {
    return fold(value).replace(/\s+/gu, "");
  }

  function leadingSigilQuery(value) {
    const literal = normalizeLiteral(value);
    return /^[*@#+&]+[\p{L}\p{N}]/u.test(literal) ? literal : "";
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function numericTokenIndex(value, query) {
    const text = fold(value);
    const token = String(query || "");
    if (!token) return -1;
    let offset = 0;
    while (offset <= text.length - token.length) {
      const index = text.indexOf(token, offset);
      if (index < 0) return -1;
      const before = index > 0 ? text[index - 1] : "";
      const after = index + token.length < text.length ? text[index + token.length] : "";
      if (!/[0-9]/u.test(before) && !/[0-9]/u.test(after)) return index;
      offset = index + 1;
    }
    return -1;
  }

  function looksLikeOrdinalTitle(value, query) {
    const text = fold(value).replace(/\s+/gu, " ");
    const token = escapeRegExp(query);
    return (
      new RegExp(`^\\s*${token}\\s*[.．:_-]\\s*\\S`, "iu").test(text) ||
      new RegExp(`^\\s*(?:m\\s*|no\\.?\\s*|song\\s+)${token}(?:\\s|[.．:_-]|$)`, "iu").test(text) ||
      new RegExp(`(?:^|\\s)${token}\\s*曲目(?:\\s|$)`, "iu").test(text) ||
      new RegExp(`^\\s*\\d+\\s*[_-]\\s*${token}(?:\\D|$)`, "iu").test(text)
    );
  }

  function looksLikeNumericMetadata(value, query) {
    const text = fold(value);
    const token = escapeRegExp(query);
    return (
      /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/u.test(text) ||
      /^\s*\d+(?:[.,]\d+)+(?:点|pts?)?\s*$/iu.test(text) ||
      new RegExp(`^\\s*${token}\\s+(?:key\\b|track\\b|song\\b|曲目)`, "iu").test(text) ||
      new RegExp(`[（(]\\s*${token}\\s*[’']?\\s*[)）]\\s*$`, "u").test(text)
    );
  }

  function meaningfulNumericCredit(value, query) {
    const text = fold(value);
    if (looksLikeNumericMetadata(text, query)) return false;
    const stripped = text
      .replace(new RegExp(escapeRegExp(query), "gu"), "")
      .replace(/[\s\p{P}\p{S}\d]+/gu, "");
    return stripped.length > 0;
  }

  function searchScore(item, type, rawQuery) {
    const query = normalize(rawQuery);
    if (!query) return -1;

    const name = String(item?.name || "");
    const secondary = String(item?.secondary || "");
    const nameKey = normalize(name);
    const secondaryKey = normalize(secondary);
    const textKey = normalize(item?.text || "");

    const literalQuery = leadingSigilQuery(rawQuery);
    if (literalQuery) {
      const nameLiteral = normalizeLiteral(name);
      const secondaryLiteral = normalizeLiteral(secondary);
      const textLiteral = normalizeLiteral(item?.text || "");

      if (nameLiteral === literalQuery) return 1100;
      if (nameLiteral.startsWith(literalQuery)) return 950;
      if (nameLiteral.includes(literalQuery)) return 800;
      if (secondaryLiteral === literalQuery) return 700;
      if (secondaryLiteral.startsWith(literalQuery)) return 600;
      if (secondaryLiteral.includes(literalQuery)) return 500;
      if (textLiteral.includes(literalQuery)) return 350;
      return -1;
    }

    if (/^\d+$/u.test(query)) {
      if (type === "songs") {
        if (nameKey === query) return 1000;

        const titleIndex = numericTokenIndex(name, query);
        if (
          titleIndex >= 0 &&
          !looksLikeOrdinalTitle(name, query) &&
          !looksLikeNumericMetadata(name, query)
        ) {
          return titleIndex === 0 ? 900 : 700;
        }

        const secondaryIndex = numericTokenIndex(secondary, query);
        if (
          secondaryIndex >= 0 &&
          secondaryKey !== query &&
          meaningfulNumericCredit(secondary, query)
        ) {
          return secondaryIndex === 0 ? 450 : 350;
        }
        return -1;
      }

      if (nameKey === query) return 1000;
      const nameIndex = numericTokenIndex(name, query);
      if (nameIndex >= 0 && !looksLikeNumericMetadata(name, query)) {
        return nameIndex === 0 ? 850 : 700;
      }
      const secondaryIndex = numericTokenIndex(secondary, query);
      if (secondaryIndex >= 0 && meaningfulNumericCredit(secondary, query)) {
        return secondaryIndex === 0 ? 500 : 350;
      }
      return -1;
    }

    if (nameKey === query) return 1000;
    if (nameKey.startsWith(query)) return 850;
    if (nameKey.includes(query)) return 700;
    if (secondaryKey === query) return 650;
    if (secondaryKey.startsWith(query)) return 550;
    if (secondaryKey.includes(query)) return 450;
    if (textKey.includes(query)) return 300;
    return -1;
  }

  function matchSearchItems(items, type, rawQuery) {
    return (items || [])
      .filter((item) => item?.type === type)
      .map((item) => ({ ...item, searchScore: searchScore(item, type, rawQuery) }))
      .filter((item) => item.searchScore >= 0);
  }

  function searchMatchTier(item, rawQuery) {
    const query = normalize(rawQuery);
    if (!query) return 2;
    const name = normalize(item?.name);
    const secondary = normalize(item?.secondary);
    if (name === query || secondary === query) return 0;
    if (name.startsWith(query) || secondary.startsWith(query)) return 1;
    return 2;
  }

  function compareSearchResults(left, right, rawQuery) {
    return searchMatchTier(left, rawQuery) - searchMatchTier(right, rawQuery)
      || Number(right?.occurrenceCount || 0) - Number(left?.occurrenceCount || 0)
      || Number(right?.videoCount || 0) - Number(left?.videoCount || 0)
      || Number(right?.searchScore || 0) - Number(left?.searchScore || 0)
      || String(left?.name || "").localeCompare(String(right?.name || ""), "ja");
  }

  return {
    normalize,
    normalizeLiteral,
    leadingSigilQuery,
    numericTokenIndex,
    looksLikeOrdinalTitle,
    looksLikeNumericMetadata,
    searchScore,
    matchSearchItems,
    searchMatchTier,
    compareSearchResults,
  };
});
