/*
 * TASK CS-v2.3 — "The request metadata is invalid."는 videos.update에 실려간
 * 40개 언어 중 하나가 유튜브 길이 제한을 넘으면 나는데, 나머지 39개가
 * 멀쩡해도 요청 전체가 거부된다(routes/yt.js의 videos.update는 한 번의 PUT).
 * 그래서 보내기 전에 서버가 직접 세어서 막는다 — 유튜브 문서가 명시하는
 * 제한(title 100자, description 5000자, tags 합계 500자)을 그대로 따른다.
 *
 * 길이는 Array.from()으로 센다. JS 문자열의 .length는 UTF-16 코드 유닛
 * 개수라 이모지·일부 한자처럼 서로게이트 쌍으로 인코딩되는 문자를 2로
 * 세어 실제보다 길게 나온다 — lib/ytLanguages.js의 planLocalizations()가
 * title을 자를 때 이미 같은 방식(Array.from(title).slice(0,100))을 쓰고
 * 있어서, 자르는 기준과 검증하는 기준이 어긋나지 않게 맞췄다.
 */

export const YT_LIMITS = Object.freeze({
  title: 100,
  description: 5000,
  tagsTotal: 500,
});

function charLength(text) {
  return Array.from(String(text ?? '')).length;
}

/** snippet.title / snippet.description / snippet.tags(합계) 검증. */
export function validateSnippetLimits(snippet) {
  const problems = [];
  const title = charLength(snippet?.title);
  if (title > YT_LIMITS.title) {
    problems.push({ field: 'snippet.title', length: title, limit: YT_LIMITS.title });
  }
  const description = charLength(snippet?.description);
  if (description > YT_LIMITS.description) {
    problems.push({ field: 'snippet.description', length: description, limit: YT_LIMITS.description });
  }
  if (Array.isArray(snippet?.tags) && snippet.tags.length) {
    // 유튜브는 tags를 콤마로 이어붙인 하나의 문자열로 취급해 500자를 센다.
    const tagsTotal = charLength(snippet.tags.join(','));
    if (tagsTotal > YT_LIMITS.tagsTotal) {
      problems.push({ field: 'snippet.tags', length: tagsTotal, limit: YT_LIMITS.tagsTotal });
    }
  }
  return problems;
}

/**
 * localizations 맵(코드 -> {title, description?}) 전체를 검증한다.
 * 새로 등록하려는 항목(planned)과 기존에 이미 올라가 있던 항목(existing) 모두
 * 같은 맵으로 합쳐 넣어 호출해야 한다 — read-modify-write라 existing도 그대로
 * 다시 전송되기 때문에(CLAUDE.md 4.3), 예전에 등록된 것 중 지금 기준으로
 * 문제가 되는 항목도 여기서 걸러야 한다.
 */
export function validateLocalizationLimits(localizations) {
  const problems = [];
  for (const [code, entry] of Object.entries(localizations || {})) {
    const title = charLength(entry?.title);
    if (title > YT_LIMITS.title) {
      problems.push({ field: `localizations.${code}.title`, length: title, limit: YT_LIMITS.title, code });
    }
    if (entry?.description !== undefined) {
      const description = charLength(entry.description);
      if (description > YT_LIMITS.description) {
        problems.push({ field: `localizations.${code}.description`, length: description, limit: YT_LIMITS.description, code });
      }
    }
  }
  return problems;
}

export function validatePublishPayload({ snippet, localizations }) {
  return [...validateSnippetLimits(snippet), ...validateLocalizationLimits(localizations)];
}

/*
 * TASK CS-v2.6 — 설명의 UTF-8 바이트 길이. 차단하지 않고 측정·경고만 한다.
 *
 * 문서(https://developers.google.com/youtube/v3/docs/videos, 2026-10 확인):
 *   - snippet.description: "maximum length of 5000 bytes" — 문서상 제한.
 *   - localizations.(key).description: "The localized video description." —
 *     길이 제한이 적혀 있지 않다. snippet 제한을 여기에 옮겨 적용할 근거가 없다.
 * 실측(2026-10-04, oldpoplounge 영상 -7E9P7E9E3c, videos.list 읽기만):
 *   유튜브에 이미 저장된 값이 snippet.description 5,148바이트, localizations.th
 *   8,867바이트, ru 6,709바이트였다. 이 영상의 localizations는 이 도구가
 *   part=snippet,localizations로 올린 것이라, 5,000바이트 초과 설명이 그 경로로
 *   받아들여진 정황이 강하다 — 다만 그때도 원문 설명이 지금과 같은 길이였는지는
 *   확인할 수 없어 "실측 확정"이 아니라 "정황"이다. 실제 쓰기로 검증한 적은 없다.
 *
 * 그래서 문서상 제한(snippet)과 문서에 없는 항목(localizations)을 구분해서
 * 보여 준다. 이 측정이 등록을 막는 일은 없다 — 막는 건 위의 글자 수 검증
 * (CS-v2.3)뿐이다. 실제로 바이트 때문에 거부되는 쓰기 사례가 나오면 그 근거로
 * problems로 올릴지 정하면 된다.
 */
export function utf8ByteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * @param {object} args
 * @param {object} args.snippet         이번 PUT에 실릴 snippet(원문 설명 포함)
 * @param {object} args.localizations   existing + planned 병합 맵
 * @param {string[]} args.plannedCodes  이번에 새로 보내는 코드
 * @param {boolean} args.defaultLanguageChanging  snippet.defaultLanguage를 바꾸는지
 * @returns {Array<{field, code?, origin, bytes, chars, limit, basis, note}>}
 *   origin: 'snippet' | 'planned'(이번에 보냄) | 'existing'(이미 유튜브에 있음, 그대로 재전송)
 *   basis : 'documented'(문서상 제한) | 'undocumented'(문서에 제한 없음, 참고용)
 */
export function describeByteRisks({ snippet, localizations, plannedCodes = [], defaultLanguageChanging = false }) {
  const limit = YT_LIMITS.description;
  const risks = [];
  const snippetBytes = utf8ByteLength(snippet?.description);
  if (snippetBytes > limit) {
    risks.push({
      field: 'snippet.description',
      origin: 'snippet',
      bytes: snippetBytes,
      chars: charLength(snippet?.description),
      limit,
      basis: 'documented',
      note: defaultLanguageChanging
        ? '원문 언어(defaultLanguage)를 바꾸려면 snippet을 다시 보내야 하는데, 이 원문 설명이 문서상 한도(5000바이트)를 넘습니다. 유튜브가 이 요청을 거부할 수 있습니다.'
        : '등록은 part=snippet,localizations로 이 원문 설명을 그대로 다시 보냅니다. 유튜브가 이미 받아 준 값이지만 문서상 한도(5000바이트)는 넘습니다.',
    });
  }
  const planned = new Set(plannedCodes.map((code) => String(code).toLowerCase()));
  for (const [code, entry] of Object.entries(localizations || {})) {
    if (entry?.description === undefined) continue;
    const bytes = utf8ByteLength(entry.description);
    if (bytes <= limit) continue;
    const isPlanned = planned.has(code.toLowerCase());
    risks.push({
      field: `localizations.${code}.description`,
      code,
      origin: isPlanned ? 'planned' : 'existing',
      bytes,
      chars: charLength(entry.description),
      limit,
      basis: 'undocumented',
      note: isPlanned
        ? '문서에는 번역 설명의 길이 제한이 없습니다(원문 설명의 5000바이트를 참고로 표시).'
        : '이미 유튜브에 저장돼 있는 값입니다(그대로 다시 보냄).',
    });
  }
  return risks;
}

const FIELD_LABELS = {
  'snippet.title': '영상 제목(snippet.title)',
  'snippet.description': '영상 설명(snippet.description)',
  'snippet.tags': '태그 전체 합계(snippet.tags)',
};

function fieldLabel(field) {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const m = /^localizations\.([^.]+)\.(title|description)$/.exec(field);
  if (m) return `${m[2] === 'title' ? '번역 제목' : '번역 설명'} (localizations.${m[1]}.${m[2]})`;
  return field;
}

/** problems[] -> 사람이 읽는 한 줄 요약. 프런트가 error.message로 그대로 보여준다. */
export function formatPublishProblems(problems) {
  return problems
    .map((p) => `${fieldLabel(p.field)}이(가) ${p.length}자로 유튜브 제한(${p.limit}자)을 넘습니다`)
    .join(' / ');
}
