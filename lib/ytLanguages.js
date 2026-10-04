/**
 * TASK CS-v1.6 — the translator tool has always labelled languages in Korean
 * ("포르투갈어 (브라질)"), which is fine for a human reading a CSV but useless
 * to the YouTube Data API: `localizations` is keyed by BCP-47 / ISO 639-1
 * codes ("pt-BR"). This module is the bridge.
 *
 * Every label maps to a *candidate list*, not a single code, because YouTube's
 * supported-language set is its own thing and changes over time: "nl-BE" may
 * simply not exist as a YouTube application language, in which case the plain
 * "nl" entry is still a perfectly good place to put a Dutch translation.
 * resolveLanguageCode() walks the candidates against the live list fetched
 * from i18nLanguages.list and takes the first one YouTube actually accepts —
 * so this file never has to be "correct about YouTube" on its own, it only has
 * to be correct about *which language the label means*.
 */

/** label -> candidate BCP-47 codes, most specific first. */
export const LANGUAGE_CODE_CANDIDATES = {
  '한국어': ['ko'],
  '광둥어 (홍콩)': ['zh-HK', 'yue', 'zh-TW'],
  '그린란드어': ['kl'],
  '네덜란드어 (네덜란드)': ['nl-NL', 'nl'],
  '네덜란드어 (벨기에)': ['nl-BE', 'nl'],
  '노르웨이어': ['no', 'nb'],
  '덴마크어': ['da'],
  '독일어 (독일)': ['de-DE', 'de'],
  '독일어 (스위스)': ['de-CH', 'de'],
  '독일어 (오스트리아)': ['de-AT', 'de'],
  '러시아어': ['ru'],
  '루마니아어': ['ro'],
  '말레이어': ['ms'],
  '베트남어': ['vi'],
  '벵골어 (인도)': ['bn'],
  '스웨덴어': ['sv'],
  '스페인어 (멕시코)': ['es-MX', 'es-419', 'es'],
  '스페인어 (라틴 아메리카)': ['es-419', 'es'],
  '스페인어 (스페인)': ['es-ES', 'es'],
  '아랍어': ['ar'],
  '영어 (미국)': ['en-US', 'en'],
  '영어 (영국)': ['en-GB', 'en'],
  '영어 (인도)': ['en-IN', 'en'],
  '영어 (캐나다)': ['en-CA', 'en'],
  '이탈리아어': ['it'],
  '인도네시아어': ['id'],
  '일본어': ['ja'],
  '중국어 (싱가포르)': ['zh-SG', 'zh-Hans', 'zh-CN', 'zh'],
  '태국어': ['th'],
  '튀르키예어 (터키어)': ['tr'],
  '페르시아어': ['fa'],
  '포르투갈어 (브라질)': ['pt-BR', 'pt'],
  '포르투갈어 (포르투갈)': ['pt-PT', 'pt'],
  '폴란드어': ['pl'],
  '프랑스어 (벨기에)': ['fr-BE', 'fr'],
  '프랑스어 (스위스)': ['fr-CH', 'fr'],
  '프랑스어 (캐나다)': ['fr-CA', 'fr'],
  '프랑스어 (프랑스)': ['fr-FR', 'fr'],
  '필리핀어': ['fil', 'tl'],
  '힌디어': ['hi'],
  '그리스어': ['el'],
  '헝가리어': ['hu'],
  '체코어': ['cs'],
  '우크라이나어': ['uk'],
  '히브리어': ['iw', 'he'],
  '아프리칸스어': ['af'],
  '아이슬란드어': ['is'],
  '카탈로니아어': ['ca'],
  '슬로바키아어': ['sk'],
  '핀란드어': ['fi'],
  '크로아티아어': ['hr'],
};

/*
 * TASK CS-v2.6 — 번역 대상 언어가 tools/yt/app.js의 하드코딩 50개 라벨 배열에
 * 묶여 있었다. 그 배열에는 '한국어'도, 대만 번체(zh-TW)도 없어서 일본어 원본
 * 채널(쇼와 카페)이 한국어 번역을 아예 만들 수 없었다. 이제 화면은
 * GET /api/yt/languages가 돌려주는 카탈로그({code,label})로 그려지고, 그
 * 카탈로그의 1순위 권위는 i18nLanguages.list(유튜브 공식 목록)다.
 *
 * 아래 배열은 그 호출이 실패했을 때(키 미설정·오프라인·쿼터)만 쓰는 대체
 * 목록이다. 코드는 i18nLanguages가 돌려주는 hl 형식(zh-CN/zh-TW/zh-HK,
 * pt=브라질·pt-PT, es=스페인·es-419, iw=히브리어)을 따른다 — 공식 목록이
 * 살아 있을 때 고른 코드와 대체 목록에서 고른 코드가 같아야 저장된 선택·
 * 캐시가 어느 쪽에서도 그대로 통한다. 라벨은 공식 목록(hl=ko)과 글자 단위로
 * 같을 필요는 없다: 식별자는 코드이고 라벨은 표시용이다.
 */
export const FALLBACK_LANGUAGE_CATALOG = Object.freeze([
  ['af', '아프리칸스어'], ['am', '암하라어'], ['ar', '아랍어'], ['as', '아삼어'],
  ['az', '아제르바이잔어'], ['be', '벨라루스어'], ['bg', '불가리아어'], ['bn', '벵골어'],
  ['bs', '보스니아어'], ['ca', '카탈로니아어'], ['cs', '체코어'], ['da', '덴마크어'],
  ['de', '독일어'], ['el', '그리스어'], ['en', '영어'], ['en-GB', '영어(영국)'],
  ['en-IN', '영어(인도)'], ['es', '스페인어(스페인)'], ['es-419', '스페인어(라틴 아메리카)'], ['es-US', '스페인어(미국)'],
  ['et', '에스토니아어'], ['eu', '바스크어'], ['fa', '페르시아어'], ['fi', '핀란드어'],
  ['fil', '필리핀어'], ['fr', '프랑스어'], ['fr-CA', '프랑스어(캐나다)'], ['gl', '갈리시아어'],
  ['gu', '구자라트어'], ['hi', '힌디어'], ['hr', '크로아티아어'], ['hu', '헝가리어'],
  ['hy', '아르메니아어'], ['id', '인도네시아어'], ['is', '아이슬란드어'], ['it', '이탈리아어'],
  ['iw', '히브리어'], ['ja', '일본어'], ['ka', '조지아어'], ['kk', '카자흐어'],
  ['km', '크메르어'], ['kn', '칸나다어'], ['ko', '한국어'], ['ky', '키르기스어'],
  ['lo', '라오어'], ['lt', '리투아니아어'], ['lv', '라트비아어'], ['mk', '마케도니아어'],
  ['ml', '말라얄람어'], ['mn', '몽골어'], ['mr', '마라티어'], ['ms', '말레이어'],
  ['my', '미얀마어'], ['ne', '네팔어'], ['nl', '네덜란드어'], ['no', '노르웨이어'],
  ['or', '오리야어'], ['pa', '펀자브어'], ['pl', '폴란드어'], ['pt', '포르투갈어(브라질)'],
  ['pt-PT', '포르투갈어(포르투갈)'], ['ro', '루마니아어'], ['ru', '러시아어'], ['si', '싱할라어'],
  ['sk', '슬로바키아어'], ['sl', '슬로베니아어'], ['sq', '알바니아어'], ['sr', '세르비아어'],
  ['sr-Latn', '세르비아어(라틴 문자)'], ['sv', '스웨덴어'], ['sw', '스와힐리어'], ['ta', '타밀어'],
  ['te', '텔루구어'], ['th', '태국어'], ['tr', '튀르키예어'], ['uk', '우크라이나어'],
  ['ur', '우르두어'], ['uz', '우즈베크어'], ['vi', '베트남어'], ['zh-CN', '중국어(간체)'],
  ['zh-HK', '중국어(홍콩)'], ['zh-TW', '중국어(번체)'], ['zu', '줄루어'],
].map(([code, label]) => Object.freeze({ code, label })));

// BCP-47 모양만 검사한다(언어 2~3자 + 선택적 하위 태그). 실제로 유튜브가
// 받는 코드인지는 planLocalizations()가 공식 목록과 대조해서 따로 본다.
const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

export function isValidLanguageCode(code) {
  return LANGUAGE_CODE_PATTERN.test(String(code || '').trim());
}

export function sameLanguageCode(a, b) {
  const x = normalizeCode(a);
  return Boolean(x) && x === normalizeCode(b);
}

/**
 * 라벨은 클라이언트가 보낸 문자열이 Gemini 프롬프트의 한 줄로 그대로
 * 들어간다. 줄바꿈이 섞이면 "Target languages" 목록 구조가 깨지므로 한 줄로
 * 접고 길이를 자른다.
 */
export function sanitizeLanguageLabel(label) {
  return String(label || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

const englishNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }); } catch { return null; }
})();

/** 'ja' -> 'Japanese'. 프롬프트의 원본 언어 명시에 쓴다. 모르는 코드면 fallbackLabel. */
export function englishLanguageName(code, fallbackLabel = '') {
  let name = '';
  try { name = englishNames?.of(String(code || '').trim()) || ''; } catch { name = ''; }
  if (!name || normalizeCode(name) === normalizeCode(code)) return fallbackLabel || String(code || '');
  return name;
}

const SUPPORTED_CACHE_MS = 12 * 60 * 60 * 1000;
let supportedCache = null;

function normalizeCode(code) {
  return String(code || '').trim().toLowerCase();
}

/**
 * i18nLanguages.list costs 1 quota unit and needs only an API key OR an OAuth
 * token, so it is cheap enough to call once per session. If it fails for any
 * reason (no key configured yet, offline, quota) we return null rather than
 * throwing — resolveLanguageCode() then falls back to "trust the first
 * candidate", which is the pre-validation behaviour and still works for the
 * plain codes (ja/en/es/...) that make up almost every real publish.
 */
export async function fetchSupportedLanguages({ apiKey = '', accessToken = '' } = {}) {
  if (supportedCache && Date.now() - supportedCache.at < SUPPORTED_CACHE_MS) {
    return supportedCache.value;
  }
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/i18nLanguages');
  endpoint.searchParams.set('part', 'snippet');
  endpoint.searchParams.set('hl', 'ko');
  if (!accessToken && apiKey) endpoint.searchParams.set('key', apiKey);

  try {
    const response = await fetch(endpoint, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      // TASK CS-v2.6 — 이제 번역 화면이 열릴 때마다 이 호출을 기다린다. 네트워크가
      // 응답 없이 매달리면 언어 목록이 영영 안 뜨므로 끊고 대체 목록으로 간다.
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) return null;
    const value = items.map((item) => ({
      code: String(item.snippet?.hl || item.id || ''),
      name: String(item.snippet?.name || ''),
    })).filter((x) => x.code);
    supportedCache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}

/*
 * TASK CS-v2.6 — GET /api/yt/languages가 돌려주는 카탈로그. 공식 목록을 받았으면
 * 그것만 쓴다(대체 목록과 섞지 않는다 — 유튜브가 안 받는 코드를 고를 수 있게
 * 보여주면 등록 미리보기에서야 빠지게 된다). 못 받았으면 대체 목록.
 * credentialAttempts는 순서대로 시도할 {apiKey}/{accessToken} 또는 그걸
 * 돌려주는 async 함수다 — OAuth 토큰 갱신은 API 키로 이미 성공했으면 아예
 * 하지 않도록 지연 평가한다.
 */
let lastCatalogSize = FALLBACK_LANGUAGE_CATALOG.length;

export async function getLanguageCatalog(credentialAttempts = []) {
  let supported = null;
  for (const attempt of credentialAttempts) {
    let credentials = null;
    try { credentials = typeof attempt === 'function' ? await attempt() : attempt; } catch { credentials = null; }
    if (!credentials || (!credentials.apiKey && !credentials.accessToken)) continue;
    supported = await fetchSupportedLanguages(credentials);
    if (supported?.length) break;
  }
  const source = supported?.length ? 'youtube' : 'fallback';
  const raw = source === 'youtube' ? supported.map((x) => ({ code: x.code, label: x.name })) : FALLBACK_LANGUAGE_CATALOG;
  const seen = new Set();
  const languages = [];
  for (const item of raw) {
    const code = String(item.code || '').trim();
    if (!isValidLanguageCode(code) || seen.has(normalizeCode(code))) continue;
    seen.add(normalizeCode(code));
    languages.push({ code, label: sanitizeLanguageLabel(item.label) || code });
  }
  languages.sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  lastCatalogSize = Math.max(FALLBACK_LANGUAGE_CATALOG.length, languages.length);
  return { languages, source };
}

/**
 * /translate가 한 요청에 받는 언어 수 상한. 예전에는 50(정적 목록 크기)으로
 * 박혀 있었는데, 카탈로그가 80개 안팎이 되면서 "전체 선택 + 짧은 제목"이라는
 * 정상 요청이 거기 걸린다. 실제 묶음 크기는 estimateMaxBatchSize()가 따로
 * 제한하므로, 이 값은 비정상적으로 큰 페이로드만 막으면 된다.
 */
export function maxLanguagesPerRequest() {
  return lastCatalogSize;
}

/**
 * 예전 localStorage/결과에는 라벨 문자열('포르투갈어 (브라질)')만 있다. 그 라벨이
 * 지금 카탈로그에서 어느 코드인지 서버가 한 번에 풀어 준다 — 후보 배열
 * (LANGUAGE_CODE_CANDIDATES)을 클라이언트에 또 복제하지 않기 위해서다(4.5).
 */
export function legacyLabelCodes(catalog) {
  const map = {};
  for (const label of Object.keys(LANGUAGE_CODE_CANDIDATES)) {
    const { code } = resolveLanguageCode(label, catalog);
    if (code) map[label] = code;
  }
  return map;
}

/**
 * TASK CS-v2.6 — 결과에 languageCode가 실려 오면(카탈로그에서 고른 언어) 그 코드를
 * 그대로 쓴다. 공식 목록에 없으면 같은 언어의 기본 코드(pt-BR -> pt)로 한 번만
 * 내려가 보고, 그것도 없으면 건너뛴다. zh는 내리지 않는다: zh-TW(번체)를 zh로
 * 내리면 간체/번체 구분이 사라진다.
 */
function resolveExplicitCode(requested, supported) {
  if (!supported) return { code: requested, exact: true, reason: '' };
  const byNorm = new Map(supported.map((x) => [normalizeCode(x.code), x.code]));
  const direct = byNorm.get(normalizeCode(requested));
  if (direct) return { code: direct, exact: true, reason: '' };
  const base = requested.split('-')[0];
  if (base !== requested && normalizeCode(base) !== 'zh' && byNorm.has(normalizeCode(base))) {
    const code = byNorm.get(normalizeCode(base));
    return { code, exact: false, reason: `유튜브가 ${requested}를 지원하지 않아 ${code}로 등록합니다.` };
  }
  return { code: '', exact: false, reason: `유튜브가 지원하지 않는 언어 코드입니다 (${requested}).` };
}

/**
 * @param {string} label      e.g. '포르투갈어 (브라질)'
 * @param {Array|null} supported  result of fetchSupportedLanguages(), or null
 * @returns {{code:string, exact:boolean, reason:string}}
 *   exact=false means we had to fall back to a broader language (nl-BE -> nl)
 *   or could not verify the code at all; the caller surfaces that to the user
 *   instead of silently publishing to a language they didn't pick.
 */
export function resolveLanguageCode(label, supported = null) {
  const candidates = LANGUAGE_CODE_CANDIDATES[String(label || '').trim()];
  if (!candidates?.length) {
    return { code: '', exact: false, reason: '이 언어의 유튜브 언어 코드를 알지 못합니다.' };
  }
  if (!supported) {
    return { code: candidates[0], exact: true, reason: '지원 언어 목록을 확인하지 못해 기본 코드를 사용했습니다.' };
  }
  const supportedSet = new Set(supported.map((x) => normalizeCode(x.code)));
  for (let i = 0; i < candidates.length; i++) {
    if (supportedSet.has(normalizeCode(candidates[i]))) {
      return {
        code: candidates[i],
        exact: i === 0,
        reason: i === 0 ? '' : `유튜브가 ${candidates[0]}를 지원하지 않아 ${candidates[i]}로 등록합니다.`,
      };
    }
  }
  return { code: '', exact: false, reason: `유튜브가 지원하지 않는 언어입니다 (${candidates.join(', ')}).` };
}

/**
 * Resolves a whole result set at once and reports collisions. Two labels can
 * legitimately collapse onto the same YouTube code (both "네덜란드어 (네덜란드)"
 * and "네덜란드어 (벨기에)" become "nl" if nl-BE is unsupported) — YouTube only
 * stores one localization per code, so the second one would silently overwrite
 * the first. We keep the first and report the rest as skipped.
 */
export function planLocalizations(results, supported = null, { defaultLanguage = '' } = {}) {
  const planned = [];
  const skipped = [];
  const usedCodes = new Map();

  for (const result of results) {
    const label = String(result?.language || '').trim();
    const requestedCode = String(result?.languageCode || '').trim();
    const title = String(result?.translatedTitle || '').trim();
    const description = String(result?.translatedDescription || '');
    // TASK CS-v2.6 — languageCode가 있으면 그것이 우선이다. 라벨 해석은 코드가
    // 없는 예전 결과(라벨만 저장된 localStorage)를 위한 하위 호환 경로다.
    const { code, exact, reason } = isValidLanguageCode(requestedCode)
      ? resolveExplicitCode(requestedCode, supported)
      : resolveLanguageCode(label, supported);
    const displayLabel = label || requestedCode;

    if (!code) {
      skipped.push({ language: displayLabel, code: '', reason: reason || '언어 코드를 찾지 못했습니다.' });
      continue;
    }
    if (!title) {
      skipped.push({ language: displayLabel, code, reason: '번역 제목이 비어 있습니다.' });
      continue;
    }
    // TASK CS-v2.6 — 원문 언어와 같은 코드의 localization은 원문 제목을 다른
    // 문장으로 덮어쓰는 셈이다. 화면에서 이미 빼지만 서버도 다시 막는다(4.2).
    if (defaultLanguage && sameLanguageCode(code, defaultLanguage)) {
      skipped.push({ language: displayLabel, code, reason: `원문 언어(${defaultLanguage})와 같은 코드라 등록하지 않습니다.` });
      continue;
    }
    // 대소문자만 다른 코드(zh-tw/zh-TW)도 유튜브에는 같은 칸이다.
    const codeKey = normalizeCode(code);
    if (usedCodes.has(codeKey)) {
      skipped.push({ language: displayLabel, code, reason: `이미 ${usedCodes.get(codeKey)}가 같은 코드(${code})를 사용합니다.` });
      continue;
    }
    usedCodes.set(codeKey, displayLabel);
    planned.push({
      language: displayLabel,
      code,
      title: Array.from(title).slice(0, 100).join(''),
      description,
      note: exact ? '' : reason,
      // TASK CS-v2.6 — 미리보기에서 설명 길이를 글자·바이트로 같이 보여 주기 위한 값.
      descriptionChars: Array.from(description).length,
      descriptionBytes: Buffer.byteLength(description, 'utf8'),
    });
  }
  return { planned, skipped };
}
