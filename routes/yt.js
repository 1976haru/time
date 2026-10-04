import { Router } from 'express';
import { Type } from '@google/genai';
import { requireGeminiClient, withRetry, isRateLimitError, isServerError } from '../lib/gemini.js';
import { logGeminiError, snippetForLog } from '../lib/geminiErrorLog.js';
import { getTodayGeminiUsage } from '../lib/geminiUsage.js';
import { getCachedTranslations, setCachedTranslations } from '../lib/ytTranslationCache.js';
import { currentKey, hasPaidKey } from '../lib/keyStore.js';
import { extractKeyless, fallbackOEmbed } from '../lib/ytKeyless.js';
import {
  buildAuthUrl,
  connectionAgeDays,
  consumeState,
  disconnect,
  exchangeCodeForTokens,
  getAccessToken,
  getAccount,
  hasClientCredentials,
  isProbablyExpired,
  listAccounts,
  readOAuthFile,
  redirectUri,
  rememberChannel,
  renameAccount,
  saveClientCredentials,
  setActiveAccount,
  TESTING_REFRESH_TOKEN_DAYS,
  youtubeApi,
} from '../lib/ytOAuth.js';
import {
  englishLanguageName,
  fetchSupportedLanguages,
  getLanguageCatalog,
  isValidLanguageCode,
  legacyLabelCodes,
  maxLanguagesPerRequest,
  planLocalizations,
  resolveLanguageCode,
  sameLanguageCode,
  sanitizeLanguageLabel,
} from '../lib/ytLanguages.js';
import { describeByteRisks, formatPublishProblems, validatePublishPayload } from '../lib/ytPublishValidation.js';

const router = Router();
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

/*
 * TASK CS-v2.2 작업 A — 화면에서 모델을 고를 수 있게 되면서 `model`이
 * 더 이상 서버 상수 하나가 아니라 요청마다 다른 사용자 입력 문자열이
 * 된다. CLAUDE.md 4.2대로 서버가 재검증한다: 영숫자·하이픈·마침표만
 * 허용하고 길이를 제한한다. 슬래시를 아예 막으므로 "../" 같은 경로
 * 탈출 문자가 들어갈 방법이 없다 — 이 값은 그대로 SDK가 구글 API URL에
 * "models/{model}:generateContent" 형태로 꽂아 넣는다(models.list()
 * 응답의 name 필드가 실제로 이 형식이라는 걸 확인함).
 *
 * 폴백 순서(요구사항 1): 요청값 -> process.env.GEMINI_MODEL -> 기본값.
 * 빈 값/미지정은 폴백이고, 형식이 잘못된 값은 폴백하지 않고 400으로
 * 거부한다 — 조용히 다른 모델로 바뀌면 사용자가 고른 것과 다른 모델로
 * 돈이 나갈 수 있다(요구사항 B.3과 같은 원칙).
 */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9.-]{1,64}$/;

function resolveModel(requestedModel) {
  const trimmed = String(requestedModel || '').trim();
  if (!trimmed) return MODEL;
  if (!MODEL_NAME_PATTERN.test(trimmed)) {
    const error = new Error(`모델 이름이 올바르지 않습니다: "${trimmed.slice(0, 80)}". 영숫자·하이픈·마침표만 64자 이내로 입력해 주세요.`);
    error.status = 400;
    throw error;
  }
  return trimmed;
}

/*
 * TASK CS-v2.2 — "이 모델이 thinkingConfig/결합 tools를 지원하는가"는
 * 계정이 아니라 모델별 속성이다(생성형 CS-v1.7/CS-v1.8 시점엔 모델이
 * 하나뿐이라 프로세스 전역 플래그 하나로 충분했다). 이제 요청마다 모델이
 * 달라질 수 있으므로 모델별로 따로 기억해야 한다 — 안 그러면 A 모델에서
 * 배운 "이 계정은 thinkingConfig를 거부한다"는 결론이 B 모델에도 잘못
 * 적용돼 조용히 최적화가 빠진다(정확성 버그는 아니지만 불필요한 비용).
 */
/*
 * TASK CS-v2.6 — 번역 대상 언어가 라벨 문자열 하나에서 {label, code}로 바뀐다.
 * 예전 클라이언트(또는 예전 localStorage에서 되살린 "이어서 번역")는 여전히
 * 라벨 문자열만 보내므로 둘 다 받는다: 문자열이면 lib/ytLanguages.js의 후보
 * 배열로 코드를 풀어 본다(못 풀어도 라벨만으로 번역은 된다 — 예전 동작).
 * 코드 형식이 틀리면 조용히 버리지 않고 400이다(resolveModel과 같은 원칙).
 */
function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function parseTargetLanguages(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const languages = [];
  for (const item of raw) {
    let label;
    let code;
    if (item && typeof item === 'object') {
      code = String(item.code || item.languageCode || '').trim();
      label = sanitizeLanguageLabel(item.label || item.language) || code;
      if (code && !isValidLanguageCode(code)) throw badRequest(`언어 코드 형식이 올바르지 않습니다: "${code.slice(0, 20)}"`);
    } else {
      label = sanitizeLanguageLabel(item);
      code = label ? resolveLanguageCode(label, null).code : '';
    }
    if (!label) continue;
    const entry = { label, code };
    const key = targetKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    languages.push(entry);
  }
  return languages;
}

/** 결과·캐시·재시도 길이 맵이 공통으로 쓰는 언어 식별자. 코드가 있으면 코드. */
function targetKey(lang) {
  return lang.code ? `code:${lang.code.toLowerCase()}` : `label:${lang.label}`;
}

function resultKey(result) {
  return targetKey({ label: result.language, code: result.languageCode || '' });
}

/*
 * 원본 언어. sourceLanguageCode가 없는 요청은 CS-v2.5 이전 클라이언트이고, 그때
 * 프롬프트는 한국어 원본 고정이었으므로 'ko'가 하위 호환 기본값이다(화면의
 * 기본값 'ja'와는 별개 — 화면은 항상 명시해서 보낸다).
 */
function parseSourceLanguage(body) {
  const code = String(body?.sourceLanguageCode || '').trim() || 'ko';
  if (!isValidLanguageCode(code)) throw badRequest(`원본 언어 코드 형식이 올바르지 않습니다: "${code.slice(0, 20)}"`);
  const label = sanitizeLanguageLabel(body?.sourceLanguageLabel) || code;
  return {
    code,
    label,
    englishName: englishLanguageName(code, label),
    isKorean: code.toLowerCase().split('-')[0] === 'ko',
  };
}

function assertNoSourceTarget(source, languages) {
  const clash = languages.filter((lang) => lang.code && sameLanguageCode(lang.code, source.code));
  if (clash.length) {
    throw badRequest(`원본 언어(${source.label}, ${source.code})와 같은 언어는 번역 대상이 될 수 없습니다: ${clash.map((x) => x.label).join(', ')}`);
  }
}

const skipThinkingConfigByModel = new Map();
const extractToolsModeByModel = new Map(); // model -> true(결합 tools 지원)/false(미지원)/undefined(아직 모름)

function cleanEnv(value = '') {
  const text = String(value).trim();
  if (!text || text.includes('여기에_')) return '';
  return text;
}

function extractVideoId(input) {
  const text = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  try {
    const u = new URL(text);
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }
    if (u.hostname.includes('youtube.com')) {
      const fromQuery = u.searchParams.get('v');
      if (/^[A-Za-z0-9_-]{11}$/.test(fromQuery || '')) return fromQuery;
      const parts = u.pathname.split('/').filter(Boolean);
      const markerIndex = parts.findIndex((p) => ['shorts', 'embed', 'live'].includes(p));
      const id = markerIndex >= 0 ? parts[markerIndex + 1] : null;
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }
  } catch { /* fall through to regex */ }
  const match = text.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  return match?.[1] || null;
}

async function extractWithYouTubeApi(videoId) {
  const key = cleanEnv(process.env.YOUTUBE_API_KEY);
  if (!key) return null;
  const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
  endpoint.searchParams.set('part', 'snippet');
  endpoint.searchParams.set('id', videoId);
  endpoint.searchParams.set('key', key);

  const response = await fetch(endpoint);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `YouTube API 오류 (${response.status})`);
  }
  const snippet = data?.items?.[0]?.snippet;
  if (!snippet) throw new Error('공개 영상 정보를 찾지 못했습니다. URL 또는 공개 상태를 확인해 주세요.');
  return {
    title: String(snippet.title || '').trim(),
    description: String(snippet.description || '').trim(),
    channelTitle: String(snippet.channelTitle || '').trim(),
    publishedAt: snippet.publishedAt || '',
    source: 'YouTube Data API',
  };
}

async function extractWithGemini(url, model = MODEL) {
  const ai = requireGeminiClient();
  const prompt = `You are extracting public metadata from one YouTube video page.
Return the exact original video title and the full original description as shown by the uploader.
Do not summarize, translate, rewrite, invent, or add commentary.
If the full description cannot be verified, return the verified portion only and set descriptionIncomplete to true.
YouTube URL: ${url}`;

  const schema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      description: { type: Type.STRING },
      channelTitle: { type: Type.STRING },
      descriptionIncomplete: { type: Type.BOOLEAN },
    },
    required: ['title', 'description'],
  };

  const callGemini = (useCombinedTools) => ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      tools: useCombinedTools ? [{ urlContext: {} }, { googleSearch: {} }] : [{ googleSearch: {} }],
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });

  const response = await withRetry(async () => {
    const useCombinedTools = extractToolsModeByModel.get(model) !== false;
    try {
      const result = await callGemini(useCombinedTools);
      if (useCombinedTools) extractToolsModeByModel.set(model, true);
      return result;
    } catch (error) {
      // TASK CS-v1.7 — a 429/5xx here means we're rate-limited or Google is
      // struggling, not that the tool combination is unsupported. Rethrowing
      // lets withRetry back off and retry once; falling through to a second
      // call instead (the old behavior) doubled the request rate at exactly
      // the moment we'd already hit the limit.
      if (isRateLimitError(error) || isServerError(error)) throw error;
      if (!useCombinedTools) throw error; // already on the fallback form — nothing left to try
      extractToolsModeByModel.set(model, false);
      return callGemini(false);
    }
  }, { label: 'yt/extract' });

  if (!response.text) throw new Error('Gemini로부터 추출 결과를 받지 못했습니다.');
  const parsed = JSON.parse(response.text);
  if (!parsed.title) throw new Error('영상 제목을 확인하지 못했습니다.');
  return {
    title: String(parsed.title).trim(),
    description: String(parsed.description || '').trim(),
    channelTitle: String(parsed.channelTitle || '').trim(),
    descriptionIncomplete: Boolean(parsed.descriptionIncomplete),
    publishedAt: '',
    source: 'Gemini URL/검색 추출',
    model, // TASK CS-v2.2 작업 A 요구사항 3 — 실제로 이 추출에 쓰인 모델
  };
}

function parseJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('빈 AI 응답입니다.');
  try { return JSON.parse(raw); } catch { /* try recovery below */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const startArray = raw.indexOf('[');
  const endArray = raw.lastIndexOf(']');
  if (startArray >= 0 && endArray > startArray) return JSON.parse(raw.slice(startArray, endArray + 1));
  const startObj = raw.indexOf('{');
  const endObj = raw.lastIndexOf('}');
  if (startObj >= 0 && endObj > startObj) return JSON.parse(raw.slice(startObj, endObj + 1));
  throw new Error('AI 응답을 JSON으로 해석하지 못했습니다.');
}

/*
 * TASK CS-v1.7 — parseJsonText() above needs the WHOLE response to be valid
 * JSON (even its bracket-matching recovery slices from the first `[`/`{` to
 * the last `]`/`}`, which is still garbage if the response was cut off mid
 * object). A response cut off by maxOutputTokens is exactly the failure mode
 * we're now trying to survive, so /translate falls back to this scanner
 * instead of failing the whole batch: walk the text once, string/escape
 * aware, and collect only the `{...}` spans whose braces actually balance.
 * A trailing object that got cut off never closes its final `}`, so it's
 * simply never emitted — no half-parsed language makes it into the result.
 */
function salvageJsonObjects(text) {
  const objects = [];
  const raw = String(text || '');
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        try { objects.push(JSON.parse(raw.slice(start, i + 1))); } catch { /* malformed fragment, skip it */ }
        start = -1;
      }
    }
  }
  return objects;
}

/*
 * TASK CS-v1.8 — intentionally duplicated from tools/yt/app.js's
 * TRANSLATE_TOKEN_BUDGET / estimateBatchSize() (same situation as
 * stripLeadingNumber(), CLAUDE.md 3.3: a static page and the server can't
 * share a module). The client sizes its batches with this exact formula so
 * a normal request never trips this check — this exists so the server
 * doesn't just trust that: CLAUDE.md 4.2 requires the server to revalidate
 * everything the client already checked, not skip it "because the client
 * already did." If you change the budget or the per-language estimate here,
 * change tools/yt/app.js's copy too, or the two will silently disagree
 * about what a safe batch looks like.
 */
const TRANSLATE_TOKEN_BUDGET = 12000;

// TASK CS-v2.1 작업 A 요구사항 3 — scope:'title'이면 언어당 출력량을 description이
// 아니라 title 길이로 추정한다. title은 description보다 30배 이상 짧아
// (실측: 4,492 vs 38,650 출력 토큰, 50개 언어 기준) 같은 예산 안에 훨씬 많은
// 언어가 들어간다 — 이게 "호출 4회 → 1회"로 줄어드는 실질적인 이유다.
// tools/yt/app.js의 estimateBatchSize()와 반드시 같은 공식을 유지한다
// (CLAUDE.md 3.3의 stripLeadingNumber() 중복과 같은 이유 — 정적 페이지와
// 서버가 모듈을 공유할 수 없다).
function estimateMaxBatchSize(scope, title, description) {
  const baseLength = Array.from(String(scope === 'title' ? title : description) || '').length;
  const perLanguageTokens = (baseLength + 100) / 2;
  return Math.max(1, Math.floor(TRANSLATE_TOKEN_BUDGET / perLanguageTokens));
}

const TRANSLATE_RESPONSE_SCHEMA_FULL = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      language: { type: Type.STRING },
      translatedTitle: { type: Type.STRING },
      translatedDescription: { type: Type.STRING },
    },
    required: ['language', 'translatedTitle', 'translatedDescription'],
  },
};

// TASK CS-v2.1 작업 A — scope:'title'용 스키마. translatedDescription을
// 아예 요청하지 않는다 — 스키마에 필드가 있으면 모델이 뭐라도 채워 넣으려
// 하고, 그만큼 출력 토큰을 쓴다. 절감의 절반은 입력(설명 미전송), 나머지
// 절반은 이 출력 스키마 축소에서 나온다(실측: 출력 38,650 -> 1,150 토큰).
const TRANSLATE_RESPONSE_SCHEMA_TITLE_ONLY = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      language: { type: Type.STRING },
      translatedTitle: { type: Type.STRING },
    },
    required: ['language', 'translatedTitle'],
  },
};

/*
 * TASK CS-v1.7 — thinkingConfig:{thinkingBudget:0} turns off "thinking" so
 * its tokens don't eat into maxOutputTokens on a plain translation, but not
 * every model/account combo recognizes the field. That support is fixed for
 * the life of this process for a given model (see skipThinkingConfigByModel's
 * TASK CS-v2.2 comment near the top of this file for why it's now keyed by
 * model), so remember it instead of re-discovering it on every call.
 *
 * TASK CS-v2.2 후속 — this used to be a message-text check
 * (/thinking/i.test(error.message)), same fragile pattern already fixed once
 * for isRateLimitError (b73e0c3): 실측(gemini-3.5-flash-lite)으로 확인됨,
 * 이 모델이 thinkingConfig를 거부할 때 실제 메시지는 "Request contains an
 * invalid argument." — "thinking"이라는 단어가 아예 없어서 그 검사로는 절대
 * 안 걸렸다. status===400이라는 사실 자체 말고는 믿을 수 있는 신호가 없으므로
 * (구글이 어떤 400 메시지를 보낼지는 문서화돼 있지 않다), 문자열을 더
 * 정교하게 매칭하려 하지 않고 그 대신 "실제로 thinkingConfig를 빼고
 * 재시도해서 되는지"로 직접 검증한다 — 아래 generateWithOptionalThinking() 참고.
 */
function isRetryableAsPlainRequest(error) {
  return Number(error?.status || error?.code || 0) === 400;
}

/*
 * TASK CS-v1.8 follow-up — quality issues found by manually diffing real
 * 50-language output against the Korean source (not theoretical):
 *   1. Fabrication: "6070" (a Korean idiom for "1960s-70s") got expanded
 *      into "60, 70, 80" in 8 languages — a fact invented mid-translation.
 *   2. Truncation: the old `.slice(0, 100)` cut Arabic mid-word through the
 *      channel name, producing garbage like "...oldpopl".
 *   3. Literal-copy: "6070"/"607080" got copied as digits by 4 languages
 *      instead of becoming a natural decade phrase (contrast the German/
 *      Russian results, which got it right unprompted).
 *   4. Missing separator: 10 languages fused "title" and "channel name"
 *      together with no separator between them, unlike the Korean source.
 *   5. Wrong-domain mistranslation: uk read a music-related word as
 *      "pop art", is read something as "song lyrics" out of context —
 *      the model was never told this is a music-playlist channel.
 * Rules 3-6 below address these directly; the "MUSIC PLAYLIST" framing
 * in the intro line addresses #5.
 *
 * TASK 후속(2026-08-17, 재조사) — 6th real issue, found via
 * .gemini_errors.log after adding per-call failure logging: this specific
 * channel's real title already contains hashtags in Korean
 * (예: "#올드팝 #7080 #추억의팝송") — not just in the description. Rule 6/7
 * (separator + [playlist]/channel-name preservation) made the model
 * faithfully translate/keep those hashtags too, and in longer-word
 * languages (Swedish, German, Finnish, Hungarian, ...) that pushed
 * translatedTitle past the 100-char hard cutoff below, silently dropping
 * the whole language into `missingLanguages` — this was never a 429 or a
 * genuine Gemini-side truncation (실측: HTTP 200, JSON parsed cleanly,
 * candidatesTokenCount far under the cap). Real registered output before
 * this fix was already inconsistent about it: 34 of the video's live
 * localizations had already stripped the hashtags themselves, only
 * zh-HK/zh-CN/ja kept them. The hashtag-exclusion rule below fixes this at
 * the source instead of continuing to filter it out after the fact.
 *
 * TASK 후속(재조사, 2차) — 해시태그를 빼고도 37/50개 언어가 여전히 100자를
 * 넘었다(실측: 스웨덴어 106, 독일어 112, 헝가리어 119, 그리스어 139).
 * 원인: "(oldpoplounge의 첫번째 플레이리스트)" 같은 괄호 안 채널명+회차
 * 표기 자체가 고유명사+숫자라 번역할 실질적 내용이 없는데도, 단어가 긴
 * 언어로 자연스럽게 옮기면 30~40자가 된다. 새 규칙(7번)이 이 부분만
 * "(<채널명> Vol. <N>)" 고정 형식으로 못박는다 — 모든 언어에서 길이가
 * 똑같아지므로(헝가리어 기준 19자 절약), 나머지 규칙(6·8·9번)은 그대로
 * 둔 채 이 특정 패턴에만 얹는다. Vol.은 음반/플레이리스트 관례로 번역
 * 없이 전 세계 통용된다는 전제.
 *
 * TASK 후속(자동 재시도) — Vol. N 규칙을 넣은 뒤에도 덴마크어·튀르키예어
 * 2개는 100자를 넘었고(실측 101~108자, 같은 입력에도 매번 달라짐 —
 * 비결정성), 90자 목표(규칙 5)를 더 조이면 나머지 48개 언어 제목이
 * 전부 불필요하게 빈약해진다(사용자 판단). 그래서 규칙을 더 조이는 대신
 * 초과한 언어만 "더 짧게 다시 써 달라"고 재요청한다 — buildLengthRetryNote()가
 * 그 요청문을 만든다. retryLengths가 없으면(평소 호출) 빈 문자열만 붙으므로
 * 최초 호출의 프롬프트는 전혀 안 바뀐다.
 */
function buildLengthRetryNote(languages, retryLengths) {
  if (!retryLengths || !retryLengths.size) return '';
  const lines = languages
    .filter((lang) => retryLengths.has(targetKey(lang)))
    .map((lang) => `- ${lang.label}: previous attempt was ${retryLengths.get(targetKey(lang))} characters`);
  if (!lines.length) return '';
  return `

LENGTH RETRY — every language in this request previously produced a translatedTitle over the 100-character hard limit (lengths below). Rewrite each one shorter while preserving the same meaning — target at most 85 Unicode characters this time, well under the limit, for extra safety margin. Do not drop or abbreviate the channel/playlist name to shorten it (the earlier rule about never truncating it still applies) — trim descriptive wording instead.
${lines.join('\n')}`;
}

/*
 * TASK CS-v2.6 — 프롬프트가 "Korean ... channel", "Translate the Korean title"로
 * 원본 언어를 한국어로 못박고 있었다. 일본어 원본(쇼와 카페 채널)에 이걸
 * 그대로 쓰면 모델이 일본어 제목을 "한국어 원문"으로 받고, 한국어 전용 규칙
 * (6070=1960·70년대, "첫번째 플레이리스트"=Vol. 1)까지 적용하려 든다. 이제
 * 원본 언어를 요청에서 받아 명시하고, 한국어 전용 규칙은 source=ko일 때만 넣는다.
 *
 * 규칙은 키를 가진 목록으로 조립하고 번호는 마지막에 매긴다: 한국어 전용
 * 규칙이 빠지면 번호가 당겨지는데, 규칙끼리 "rule 8 below"처럼 번호로 서로
 * 참조하므로 그 참조도 같이 따라가야 한다({{rule:key}}). source=ko일 때의
 * 규칙 문장과 번호는 CS-v2.5까지와 같다(2번 규칙에 "[코드]는 빼고"라는 말만
 * 붙었다 — 대상 언어 목록에 코드를 같이 적게 됐기 때문) — 그동안 실측으로
 * 다듬어 온 규칙이라(위 TASK 블록들) 손대지 않는다.
 */
function buildRuleList(entries) {
  const list = entries.filter(Boolean);
  const numberOf = new Map(list.map((rule, i) => [rule.key, i + 1]));
  return list
    .map((rule, i) => `${i + 1}. ${rule.text.replace(/\{\{rule:([A-Za-z]+)\}\}/g, (_, key) => String(numberOf.get(key)))}`)
    .join('\n');
}

function buildTranslateRules(source, scope) {
  const korean = source.isKorean;
  const full = scope === 'full';
  const hashtagExample = korean ? ', e.g. #올드팝, #7080' : '';
  // #7080은 한국식 연대 해시태그다. 다른 원본에는 중립적인 숫자 예시를 쓴다.
  const numericTag = korean ? '#7080' : '#1970';
  const ordinalFallbackRule = full ? 'tags' : 'titleHashtags';
  return buildRuleList([
    { key: 'onePerLanguage', text: 'Return exactly one object per requested target language, in the same order.' },
    { key: 'labelMatch', text: 'language must exactly match the target-language label supplied above (the label only, without the bracketed language code).' },
    {
      key: 'noFabrication',
      text: korean
        ? "Do not add any fact, year, number, or detail that is not present in the original text. Never expand \"6070\" (or similar) into \"60, 70, 80\" or introduce any decade/number that isn't literally there."
        : "Do not add any fact, year, number, or detail that is not present in the original text. Never introduce any decade/number that isn't literally there.",
    },
    korean && {
      key: 'koreanDecade',
      text: `When "6070" (or similar Korean decade shorthand like "7080", "8090") appears${full ? ' as descriptive text' : ''} — not inside a "#" hashtag — it means "the 1960s and 1970s" ("60년대와 70년대"), a common Korean way to write two consecutive decades together. Render it as a natural decade expression in the target language instead of copying the digits unchanged — for example "60s & 70s" (English), "60er & 70er" (German), "60-70-е" (Russian). Do not leave it as "6070" or "607080".`,
    },
    { key: 'length', text: 'translatedTitle must be natural and clickable, targeting at most 90 Unicode characters including spaces — leave headroom, do not write up to the limit. Never cut, abbreviate, or truncate the channel/playlist name to make a title fit a length target; if a translation genuinely cannot fit within the limit without cutting the channel name, shorten the rest of the title instead — the channel name must always appear complete.' },
    { key: 'separator', text: 'If the original title has a structural separator between the main title and the channel/playlist name (such as "|", "-", "ㅣ"), keep an equivalent separator in the translation. Do not merge the two parts together with no separator between them.' },
    korean && {
      key: 'koreanOrdinal',
      text: `If the parenthetical channel/playlist attribution at the end of the title combines a channel name with an ordinal/sequence number (e.g. Korean "(oldpoplounge의 첫번째 플레이리스트)", meaning "(oldpoplounge's first playlist)"), do NOT translate that parenthetical at all. Instead render it in this exact fixed, language-invariant format in every target language: "(<channel name> Vol. <N>)" — keep the channel name exactly as given, convert the Korean ordinal word to its Arabic numeral N (첫번째=1, 두번째=2, 세번째=3, 네번째=4, 다섯번째=5, 여섯번째=6, 일곱번째=7, 여덟번째=8, 아홉번째=9, 열번째=10, and so on), and use the literal abbreviation "Vol." unchanged — never translate "Vol." into another word. Example: "(oldpoplounge의 첫번째 플레이리스트)" becomes "(oldpoplounge Vol. 1)" in every single language, identically. This overrides rule {{rule:${ordinalFallbackRule}}} below for this specific parenthetical only. If the title's parenthetical does not match this "channel name + ordinal" pattern, ignore this rule and follow rule {{rule:${ordinalFallbackRule}}} instead.`,
    },
    { key: 'tags', text: 'Preserve tags such as [playlist], [Playlist], and emojis.' },
    {
      key: 'titleHashtags',
      text: full
        ? `If the original title itself contains hashtags (tokens starting with "#"${hashtagExample}), do NOT include them in translatedTitle at all — omit them entirely, even numeric-looking ones like ${numericTag}. Do not translate them into words either, just remove them. This rule is only about the TITLE; hashtags inside the description are a separate matter (see rule {{rule:descriptionHashtags}} below). Hashtags repeated inside a translated title just add unreadable duplicate text in the target language, and the same hashtags already appear in the description.`
        : `If the original title contains hashtags (tokens starting with "#"${hashtagExample}), do NOT include them in translatedTitle at all — omit them entirely, even numeric-looking ones like ${numericTag}. Do not translate them into words either, just remove them. Hashtags repeated inside a translated title just add unreadable duplicate text in the target language, and no description is being translated in this request for them to belong to anyway.`,
    },
    full && { key: 'descriptionHashtags', text: `Translate normal hashtags naturally, but keep numeric hashtags such as ${numericTag} unchanged.` },
    full && { key: 'timestamps', text: 'Preserve timestamps and track-list song titles at the end of the description exactly as written. Do not translate those lines.' },
    { key: 'properNames', text: 'Keep URLs, email addresses, credits, handles, and proper names unchanged unless a standard localized form is clearly appropriate.' },
    { key: 'noExtras', text: 'Do not add explanations, quotation marks, or extra marketing claims.' },
  ]);
}

function buildPromptIntro(source) {
  return `You are a professional YouTube metadata localization translator for a ${source.englishName} YouTube MUSIC PLAYLIST channel. Every video is a music playlist (mood/genre/era-themed background music). Use that context to resolve ambiguous words — e.g. a word that could mean "pop art" or "pop music" always means MUSIC here; a word that could mean "lyrics" or general "text" in a title refers to song content, not literature or visual art.

The source metadata language is ${source.englishName} (${source.code}).`;
}

function formatTargetList(languages) {
  return languages.map((lang, i) => `${i + 1}. ${lang.label}${lang.code ? ` [${lang.code}]` : ''}`).join('\n');
}

function buildTranslatePromptFull(source, title, description, languages, retryLengths) {
  return `${buildPromptIntro(source)}

Translate the ${source.englishName} title and description into every target language listed below.

Target languages:
${formatTargetList(languages)}

Rules:
${buildTranslateRules(source, 'full')}
${buildLengthRetryNote(languages, retryLengths)}

Original title:
${title}

Original description:
${description}`;
}

/*
 * TASK CS-v2.1 작업 A 요구사항 2 — scope:'title'일 때 쓰는 프롬프트. description을
 * 아예 프롬프트 문자열에 넣지 않는다: 보내고 결과만 버리면 입력 토큰은 그대로
 * 나가므로, 실제로 절감하려면 안 보내야 한다. "손대지 말 것"대로 제목 관련
 * 규칙(조작 방지, 6070 표기, 길이·구분자)은 buildTranslatePromptFull과 전부
 * 동일하게 유지하고, description 전용 규칙(해시태그 번역, 타임스탬프 보존)만
 * 뺐다 — 대상이 없는 규칙을 프롬프트에 남겨봐야 토큰만 쓰고 아무 효과가 없다.
 */
function buildTranslatePromptTitleOnly(source, title, languages, retryLengths) {
  return `${buildPromptIntro(source)}

Translate the ${source.englishName} title into every target language listed below. Only the title is provided — no description.

Target languages:
${formatTargetList(languages)}

Rules:
${buildTranslateRules(source, 'title')}
${buildLengthRetryNote(languages, retryLengths)}

Original title:
${title}`;
}

/*
 * TASK CS-v1.8 — do NOT add `tools: [{ googleSearch: {} }]` or
 * `{ urlContext: {} }` to this config, ever. Grounding is billed per
 * request on top of token cost (separate from maxOutputTokens/thinking),
 * and translation never needs to look anything up — it's given the full
 * title/description text already. extractWithGemini() above uses both
 * because it genuinely needs to fetch the page; that's a free-tier, once-
 * per-video call. This function runs on the paid tier and can be called
 * many times per video (one per batch), so an unnecessary grounding charge
 * here would multiply, not just add once.
 *
 * generateWithOptionalThinking() is shared by generateTranslation() and
 * /regenerate below — both hit the same paid account, so "does this
 * model accept thinkingConfig" (skipThinkingConfigByModel) only needs
 * discovering once per model, not once per endpoint. Measured directly:
 * /regenerate without any config at all (i.e. what it looked like before
 * this task) spent 904 thoughtsTokenCount to produce a 17-token title
 * rewrite — thinking was silently the majority of every regenerate call's
 * cost.
 */
async function generateWithOptionalThinking(ai, { contents, config }, { label, context, model = MODEL }) {
  const call = (includeThinking) => ai.models.generateContent({
    model,
    contents,
    config: { ...config, ...(includeThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
  });
  const alreadySkipping = skipThinkingConfigByModel.get(model) === true;
  try {
    return await withRetry(() => call(!alreadySkipping), { label, tier: 'paid', context });
  } catch (error) {
    // TASK CS-v2.2 후속 — 이미 thinkingConfig 없이 보낸 상태에서 난 400은
    // thinkingConfig 문제일 수가 없으니 그대로 던진다(무한 재시도 방지).
    if (alreadySkipping || !isRetryableAsPlainRequest(error)) throw error;
    try {
      const retryResult = await withRetry(() => call(false), { label, tier: 'paid', context });
      // 빼고 보냈더니 성공했다 — 이 모델이 thinkingConfig를 거부한다는 게
      // 문자열 매칭이 아니라 실제 재시도로 증명됐다. 다음부터는 처음부터 뺀다.
      skipThinkingConfigByModel.set(model, true);
      return retryResult;
    } catch (retryError) {
      // 빼고 보냈는데도 또 400이면 thinkingConfig 문제가 아니라 이 모델이
      // 이 요청 자체(스키마, config 조합 등)를 거부하는 다른 이유다. 원문
      // JSON만 보여주면 사용자가 뭘 해야 할지 모르니 다음 행동을 붙여준다.
      if (isRetryableAsPlainRequest(retryError)) {
        const friendly = new Error(`이 모델("${model}")이 요청 형식을 거부했습니다. 다른 모델을 선택해 보세요. (원본: ${retryError.message})`);
        friendly.status = 400;
        throw friendly;
      }
      throw retryError;
    }
  }
}

async function generateTranslation(ai, prompt, scope, languageCount, model = MODEL) {
  // TASK CS-v1.8 — translate is one of the two paid-tier call sites (see
  // lib/keyStore.js's currentKey('paid')); everything else in this file
  // stays on the free tier.
  // TASK CS-v2.1 — maxOutputTokens stays 16384 for both scopes. It's a cap,
  // not a target: Gemini stops when it's actually done, so the token
  // savings come entirely from the smaller prompt/schema above, not from
  // shrinking this ceiling. Lowering it wouldn't save anything and would
  // only risk truncating a legitimately long scope:'full' batch.
  const schema = scope === 'title' ? TRANSLATE_RESPONSE_SCHEMA_TITLE_ONLY : TRANSLATE_RESPONSE_SCHEMA_FULL;
  return generateWithOptionalThinking(ai, {
    contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 16384 },
  }, { label: 'yt/translate', context: { scope, languageCount }, model }); // TASK 후속 — .gemini_errors.log에 실릴 필드
}

/*
 * TASK CS-v2.2 작업 B — 실측(2026-08-17, 실제 계정으로 ai.models.list() 직접
 * 호출): supportedActions에 "generateContent"가 있다고 텍스트 모델인
 * 것은 아니다. TTS 모델(gemini-2.5-flash-preview-tts 등)도 generateContent를
 * 지원한다고 나온다 — 추측이 아니라 실제 응답을 보고 확인한 사실이다.
 * 그래서 supportedActions 확인(임베딩·비디오·라이브 계열 제거)에 더해
 * 이름 패턴으로 TTS·이미지 생성 계열을 추가로 걸러낸다. 지시서가 명시한
 * 4개 계열(임베딩·이미지·TTS·비디오)만 제외하고, lyria(음악 생성)처럼
 * 지시서에 없는 계열은 임의로 더 빼지 않는다 — 목록을 부풀리는 쪽이,
 * 실제로 쓸 수 있는 걸 조용히 숨기는 쪽보다 안전하다(요구사항 B.3의
 * "조용히 갈아타지 말 것"과 같은 원칙).
 */
const MODEL_LIST_EXCLUDE_PATTERN = /embed|image|tts|veo|video/i;

// TASK CS-v2.2 — 이름만으로는 안 걸러진 실제 사례: "nano-banana-pro-preview"는
// 이름에 image/tts 등 키워드가 전혀 없지만 description이 "Gemini 3 Pro Image
// Preview"라 실제로는 이미지 생성 모델이다(실측 확인). name과 description을
// 같이 검사해야 이런 코드네임 모델도 걸러진다.
function isTextGenerationModel(model) {
  const actions = Array.isArray(model?.supportedActions) ? model.supportedActions : [];
  if (!actions.includes('generateContent')) return false;
  const haystack = `${model?.name || ''} ${model?.description || ''}`;
  return !MODEL_LIST_EXCLUDE_PATTERN.test(haystack);
}

/** 요구사항 B.1/B.3 공용 — 정상 목록 조회와 404 에러 응답에 실릴 "사용 가능한 모델" 둘 다 이 함수를 쓴다. */
async function listTextModels() {
  const ai = requireGeminiClient('paid'); // TASK CS-v2.2 — /translate·/regenerate가 실제로 과금되는 슬롯과 동일하게 조회한다
  const pager = await withRetry(() => ai.models.list({ config: { pageSize: 200 } }), { label: 'yt/list-models', tier: 'paid' });
  const items = [];
  for await (const item of pager) items.push(item);
  return items
    .filter(isTextGenerationModel)
    .map((item) => ({
      name: String(item.name || '').replace(/^models\//, ''),
      displayName: item.displayName || '',
      description: item.description || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

router.get('/models', async (req, res, next) => {
  try {
    const models = await listTextModels();
    res.json({ models, defaultModel: MODEL });
  } catch (error) {
    next(error);
  }
});

/*
 * TASK CS-v2.6 — 번역 화면의 언어 목록. 실패해도 절대 에러로 끝나지 않는다:
 * API 키가 없거나 오프라인이면 내장 대체 목록(source:'fallback')을 돌려줘
 * 화면이 계속 동작하게 한다. API 키(YOUTUBE_API_KEY)를 먼저 쓰고, 없거나
 * 실패하면 지금 선택된 OAuth 계정 토큰으로 한 번 더 시도한다. 키/토큰 값은
 * 응답에도 로그에도 싣지 않는다(3.5).
 */
router.get('/languages', async (req, res, next) => {
  try {
    const { languages, source } = await getLanguageCatalog([
      { apiKey: cleanEnv(process.env.YOUTUBE_API_KEY) },
      async () => {
        if (!hasClientCredentials()) return null;
        const account = getAccount('');
        return account.refreshToken ? { accessToken: await getAccessToken(account.id) } : null;
      },
    ]);
    res.json({
      source,
      count: languages.length,
      languages,
      legacyLabelCodes: legacyLabelCodes(languages),
      maxLanguagesPerRequest: maxLanguagesPerRequest(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/status', (req, res) => {
  const hasGemini = Boolean(currentKey());
  res.json({
    ok: true,
    model: MODEL,
    geminiConfigured: hasGemini,
    youtubeApiConfigured: Boolean(cleanEnv(process.env.YOUTUBE_API_KEY)),
    mode: hasGemini ? 'gemini' : 'keyless',
    // TASK CS-v1.7 — reference-only: today's Gemini usage across all 5 tools
    // that share this key (lib/geminiUsage.js), not just this one. Doesn't
    // gate anything; the account-wide truth is Google AI Studio's dashboard.
    geminiUsageToday: getTodayGeminiUsage(),
    // TASK CS-v1.8 — which key /translate and /regenerate actually charge
    // against right now. currentKey('paid') silently falls back to the free
    // key when unset, which is correct for actually running the call, but
    // the UI needs to know when that fallback is happening so it can be
    // honest about where the money is (or isn't) going.
    paidKeyConfigured: hasPaidKey(),
    translationTier: hasPaidKey() ? 'paid' : 'free',
  });
});

router.post('/extract', async (req, res, next) => {
  try {
    const url = String(req.body?.url || '').trim();
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: '올바른 YouTube URL 또는 11자리 비디오 ID를 입력해 주세요.' });
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const hasGemini = Boolean(currentKey());
    const model = resolveModel(req.body?.model); // TASK CS-v2.2 작업 A

    let result;
    let apiError = '';
    if (cleanEnv(process.env.YOUTUBE_API_KEY)) {
      try {
        result = await extractWithYouTubeApi(videoId);
      } catch (error) {
        apiError = error.message;
      }
    }

    if (!result) {
      if (hasGemini) {
        // TASK CS-v1.7 — title/description are sitting right there in the
        // watch page (lib/ytKeyless.js already does this for the no-key
        // path), so try that free, unofficial parse before spending a
        // urlContext+googleSearch Gemini call on it. Only accept it when
        // BOTH fields came back non-empty; a partial result (page layout
        // Google changed, og:description missing, etc.) falls straight
        // through to the exact same Gemini -> oEmbed chain as before, so
        // accuracy never regresses, only the common case gets cheaper.
        let keylessResult = null;
        try {
          const candidate = await extractKeyless(canonicalUrl);
          if (candidate?.title && candidate?.description) keylessResult = candidate;
        } catch { /* unofficial parse failed — Gemini below is still the fallback */ }

        if (keylessResult) {
          result = keylessResult;
        } else {
          try {
            result = await extractWithGemini(canonicalUrl, model);
          } catch (geminiError) {
            const fallback = await fallbackOEmbed(canonicalUrl).catch(() => null);
            if (!fallback) throw geminiError;
            result = fallback;
            result.warning = `설명 추출 실패: ${geminiError.message}`;
          }
        }
      } else {
        try {
          result = await extractKeyless(canonicalUrl);
        } catch (pageError) {
          const fallback = await fallbackOEmbed(canonicalUrl).catch(() => null);
          if (!fallback) throw pageError;
          result = fallback;
          result.warning = `설명 추출 실패(비공식 파싱): ${pageError.message}`;
        }
      }
    }

    if (apiError && result) {
      result.warning = `YouTube API 사용 실패 후 대체 추출: ${apiError}`;
    }
    res.json({ ...result, videoId, url: canonicalUrl });
  } catch (error) {
    next(error);
  }
});

router.post('/translate', async (req, res, next) => {
  try {
    // TASK CS-v1.8 — currentKey('paid') falls back to the free key when no
    // paid key is configured (the common case), so this still passes with
    // just a free key exactly like before. It only differs from the old
    // currentKey() check for the edge case of a paid key with no free key.
    if (!currentKey('paid')) {
      const error = new Error('무료 Gemini 키를 설정하면 번역할 수 있습니다. 상단 배지에서 키를 입력해 주세요.');
      error.status = 400;
      error.needsKey = true;
      throw error;
    }
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '');
    const languages = parseTargetLanguages(req.body?.languages); // TASK CS-v2.6 — [{label, code}]
    const source = parseSourceLanguage(req.body); // TASK CS-v2.6
    // TASK CS-v2.0 작업 A 요구사항 4 — forcePaid는 "사용자가 비용을 감수하고
    // 누른 버튼"의 신호다. effectiveTier()의 자동 판단(유료 키가 있으면
    // paid)은 그대로 두되, 유료 키가 실제로 없는데 forcePaid가 오면 무료로
    // 조용히 폴백하지 않고 여기서 즉시 거부한다 — 폴백되면 방금 쓴 무료
    // 한도를 또 그대로 소진해 같은 429가 나고, 사용자는 "유료를 눌렀는데
    // 왜 안 되지"라고 오해한다.
    const forcePaid = Boolean(req.body?.forcePaid);
    if (forcePaid && !hasPaidKey()) {
      return res.status(400).json({
        error: '유료 키가 설정되어 있지 않아 유료로 이어서 번역할 수 없습니다. 상단 배지에서 유료 키를 먼저 설정해 주세요.',
      });
    }
    // TASK CS-v2.1 작업 A 요구사항 1 — 명시되지 않으면 'title'이 기본값이다.
    // 'full'이 아닌 모든 값(오타, 누락 포함)도 안전하게 'title'로 떨어진다 —
    // CLAUDE.md의 "조용한 오동작보다 안전한 기본값" 관행(예: social-studio의
    // VALID_MODES 기본값 'local')과 같은 이유다.
    const scope = req.body?.scope === 'full' ? 'full' : 'title';
    const model = resolveModel(req.body?.model); // TASK CS-v2.2 작업 A — 400이면 여기서 바로 throw됨
    if (!title) return res.status(400).json({ error: '번역할 제목이 없습니다.' });
    if (!languages.length) return res.status(400).json({ error: '번역 언어를 하나 이상 선택해 주세요.' });
    // TASK CS-v1.7 — was `> 10`, hardcoded back when the client always sent
    // fixed batches of 8. tools/yt/app.js now sizes a batch to the
    // description length (estimateBatchSize()) and can legitimately send all
    // 50 languages in one call for a short description; capping at the full
    // language-list size just guards against a malformed/huge payload, not
    // against a normal batch.
    // TASK CS-v2.6 — 50(옛 정적 목록 크기) 고정값이었다. 이제 카탈로그 크기가 상한이다.
    const maxLanguages = maxLanguagesPerRequest();
    if (languages.length > maxLanguages) return res.status(400).json({ error: `한 번에 최대 ${maxLanguages}개 언어까지 처리할 수 있습니다.` });
    // TASK CS-v2.6 — 원본과 같은 언어로의 "번역"은 화면에서 이미 빼지만 서버도 막는다(4.2).
    assertNoSourceTarget(source, languages);

    // TASK CS-v1.8 — cache lookup happens before the batch-size check below:
    // a cached language costs no output tokens, so only the ones we'd
    // actually send to Gemini should count against that budget. This also
    // means a fully-cached request never even builds a Gemini client.
    const { hit: cachedResults, miss: languagesToFetch } = getCachedTranslations({ model, title, description, languages, scope, sourceLanguage: source.code });

    if (languagesToFetch.length > 0) {
      // TASK CS-v1.8 — was count-only. tools/yt/app.js's estimateBatchSize()
      // sizes batches on the client, but nothing enforced that server-side,
      // so "description 4000자 × 50개 언어" sailed straight through and blew
      // past maxOutputTokens: 16384, getting silently cut off. Reject before
      // spending the call, and hand back the batch size we'd actually
      // accept so the caller can re-split and retry.
      const recommendedBatchSize = estimateMaxBatchSize(scope, title, description);
      if (languagesToFetch.length > recommendedBatchSize) {
        const basisLabel = scope === 'title' ? `제목 길이(${Array.from(title).length}자)` : `설명 길이(${Array.from(description).length}자)`;
        return res.status(400).json({
          error: `${basisLabel} 기준으로 한 번에 최대 ${recommendedBatchSize}개 언어까지 처리할 수 있습니다(캐시에 없는 ${languagesToFetch.length}개 기준). 더 작은 묶음으로 나눠 보내 주세요.`,
          recommendedBatchSize,
        });
      }
    }

    let fetchedResults = [];
    let truncated = false;
    let missingLanguages = [];
    let missingLanguageCodes = []; // TASK CS-v2.6 — missingLanguages(라벨)와 같은 순서의 코드. 화면은 코드로 언어를 식별한다.
    let oversizedTitles = []; // TASK 후속(재조사) — [{language, length}], 응답에도 실어 화면에 이유를 보여준다

    if (languagesToFetch.length > 0) {
      let response;
      try {
        const ai = requireGeminiClient('paid');
        const prompt = scope === 'title'
          ? buildTranslatePromptTitleOnly(source, title, languagesToFetch)
          : buildTranslatePromptFull(source, title, description, languagesToFetch);
        response = await generateTranslation(ai, prompt, scope, languagesToFetch.length, model);
      } catch (geminiError) {
        // TASK CS-v2.0 작업 A 요구사항 1 — 429는 요청 전체를 그냥 끝내지
        // 않는다. requireGeminiClient가 던지는 일일 상한(dailyLimitReached)과
        // withRetry가 재시도를 다 쓰고 던지는 일반 429를 여기서 함께 받아,
        // "아직 캐시에 없어서 이번에 실패한" languagesToFetch를
        // missingLanguages로, 캐시에서는 이미 맞춘 cachedResults를 results로
        // 돌려준다 — 화면이 "유료로 이어서" 선택지를 띄우는 데 필요한
        // 정보다. dailyLimitReached는 우리 앱 자체의 .gemini_limits.json
        // 상한이라 quotaScope와 별개 필드로 구분해 알린다(요구사항 5) — 이
        // 경우 유료로 다시 눌러도 똑같이 즉시 막히므로 화면에서 그 사실을
        // 따로 표시할 수 있어야 한다.
        if (Number(geminiError?.status) === 429) {
          const byLanguage = new Map();
          for (const result of cachedResults) byLanguage.set(resultKey(result), result);
          const partialResults = languages.map((lang) => byLanguage.get(targetKey(lang))).filter(Boolean);
          return res.status(429).json({
            error: geminiError.message,
            quotaExhausted: true,
            quotaScope: geminiError.dailyLimitReached ? 'daily' : (geminiError.quotaScope || 'unknown'),
            dailyLimitReached: Boolean(geminiError.dailyLimitReached),
            missingLanguages: languagesToFetch.map((lang) => lang.label),
            missingLanguageCodes: languagesToFetch.map((lang) => lang.code), // TASK CS-v2.6 — missingLanguages와 같은 순서
            paidKeyConfigured: hasPaidKey(),
            results: partialResults,
            fromCache: cachedResults.map((result) => result.language),
            scope, // TASK CS-v2.1 작업 A 요구사항 4 — 실패 응답에도 실제 적용된 scope를 담는다
          });
        }
        // TASK CS-v2.2 작업 B 요구사항 3 — 모델이 없거나(오타) 은퇴됐으면
        // Gemini가 404를 준다(실측 확인: error.status===404, 메시지가
        // "... is not found ... Call ModelService.ListModels ..."). 여기서
        // 조용히 다른 모델로 갈아타지 않는다 — 사용자가 고른 모델과 다른
        // 것으로 돈이 나가면 안 된다는 게 지시서의 명시적 요구사항이다.
        // 대신 실제 사용 가능한 목록을 같이 돌려줘 화면이 바로 골라 쓰게 한다.
        if (Number(geminiError?.status) === 404) {
          let availableModels = [];
          try { availableModels = await listTextModels(); } catch { /* 목록 조회 자체가 실패해도 404 사실은 그대로 알린다 */ }
          return res.status(404).json({
            error: `모델 "${model}"을(를) 사용할 수 없습니다. 목록에서 다른 모델을 선택해 주세요.`,
            modelNotFound: true,
            requestedModel: model,
            availableModels,
          });
        }
        throw geminiError;
      }

      let parsed;
      try {
        parsed = parseJsonText(response.text);
        if (!Array.isArray(parsed)) throw new Error('번역 결과 형식이 올바르지 않습니다.');
      } catch (parseError) {
        // TASK CS-v1.7 — response.text failed to parse whole; see if it was
        // just cut off mid-array and we can still salvage the complete
        // objects at the front of it instead of failing every language in
        // this batch over one that ran long.
        const salvaged = salvageJsonObjects(response.text);
        if (!salvaged.length) throw parseError;
        parsed = salvaged;
        truncated = true;
        // TASK CS-v1.8 task D — a truncated batch is salvaged, not
        // re-requested. This request makes exactly one generateContent call
        // regardless of truncation; the missing languages are reported via
        // `missingLanguages` and only re-fetched if/when the caller
        // explicitly asks again (tools/yt/app.js's "이어서 번역"), which
        // itself sends each pending language through exactly one fresh
        // call. So "재요청은 묶음당 1회까지만" holds by construction — there
        // is no automatic retry-on-truncation loop here to bound.
      }
      fetchedResults = parsed.map((item, index) => ({
        language: languagesToFetch[index]?.label || String(item.language || ''),
        languageCode: languagesToFetch[index]?.code || '', // TASK CS-v2.6 — planLocalizations()가 라벨보다 먼저 쓴다
        translatedTitle: String(item.translatedTitle || '').trim(),
        translatedDescription: String(item.translatedDescription || '').trim(),
      }));

      // TASK CS-v1.8 follow-up — was `.slice(0, 100)` above, which silently
      // cut the title at exactly 100 Unicode characters regardless of what
      // was there. Measured real damage: an Arabic title got cut mid-word
      // through the channel name, producing "...oldpopl" instead of the
      // actual channel name. The prompt now asks for <=90 chars with an
      // explicit "never truncate the channel name" rule, but if the model
      // still returns something over the hard 100-char cap, drop that
      // language instead of mangling it — it comes back via
      // `missingLanguages` for the caller to retry, same as a truncated
      // batch already does, rather than shipping a broken channel name.
      //
      // TASK 후속(2026-08-17, 재조사) — 요구사항 2: 지금까지는 이 filter가
      // 조용히 지워서 "missing"으로만 보였다. 100자 상한은 유튜브 자체
      // 상한이라 늘릴 수 없으므로(사용자 확인) 필터 자체는 그대로 두되,
      // 무엇이 몇 자였는지는 남긴다 — 원인 파악이 안 됐던 근본 이유가
      // 바로 이 "조용함"이었다.
      oversizedTitles = fetchedResults
        .filter((r) => Array.from(r.translatedTitle).length > 100)
        .map((r) => ({ language: r.language, languageCode: r.languageCode, length: Array.from(r.translatedTitle).length }));
      fetchedResults = fetchedResults.filter((r) => Array.from(r.translatedTitle).length <= 100);

      // TASK 후속(자동 재시도) — 100자를 넘은 언어만 골라 "더 짧게 다시
      // 써 달라"고 최대 2회까지 재요청한다. 규칙(90자 목표)을 더 조이지
      // 않는 이유: 50개 중 1~2개만 걸리는 드문 케이스인데 규칙을 조이면
      // 나머지 48개 언어 전부가 불필요하게 빈약해지고, 그마저도 비결정성
      // 때문에(같은 입력에 101자/108자로 매번 다름) 확률적으로 또 넘칠 수
      // 있다(사용자 확인). 재시도 호출도 generateTranslation()을 그대로
      // 타므로 withRetry() -> recordGeminiUsage()가 평소와 동일하게 집계한다
      // (요구사항 3) — 별도 카운팅 코드가 필요 없다.
      const MAX_OVERSIZE_RETRIES = 2;
      let oversizedRetryRounds = 0;
      let stillOversized = oversizedTitles;
      while (stillOversized.length > 0 && oversizedRetryRounds < MAX_OVERSIZE_RETRIES) {
        oversizedRetryRounds += 1;
        const retryLanguages = stillOversized.map((o) => ({ label: o.language, code: o.languageCode || '' }));
        const retryLengths = new Map(retryLanguages.map((lang, i) => [targetKey(lang), stillOversized[i].length]));

        let retryResponse;
        try {
          const retryAi = requireGeminiClient('paid');
          const retryPrompt = scope === 'title'
            ? buildTranslatePromptTitleOnly(source, title, retryLanguages, retryLengths)
            : buildTranslatePromptFull(source, title, description, retryLanguages, retryLengths);
          retryResponse = await generateTranslation(retryAi, retryPrompt, scope, retryLanguages.length, model);
        } catch {
          // 429/서버 오류 등 — 재시도를 그만두고 남은 언어는 그대로 초과
          // 목록에 남긴다. 원래 있던 primary 결과는 이미 fetchedResults에
          // 들어 있으니 이 요청 전체를 실패시키지 않는다.
          break;
        }

        let retryParsed;
        try {
          retryParsed = parseJsonText(retryResponse.text);
          if (!Array.isArray(retryParsed)) throw new Error('재시도 응답 형식이 올바르지 않습니다.');
        } catch {
          const salvaged = salvageJsonObjects(retryResponse.text);
          if (!salvaged.length) break;
          retryParsed = salvaged;
        }

        const retryResults = retryParsed.map((item, index) => ({
          language: retryLanguages[index]?.label || String(item.language || ''),
          languageCode: retryLanguages[index]?.code || '',
          translatedTitle: String(item.translatedTitle || '').trim(),
          translatedDescription: String(item.translatedDescription || '').trim(),
        }));

        const respondedLanguages = new Set();
        const nextOversized = [];
        for (const r of retryResults) {
          respondedLanguages.add(resultKey(r));
          const len = Array.from(r.translatedTitle).length;
          if (len > 100) {
            nextOversized.push({ language: r.language, languageCode: r.languageCode, length: len });
          } else {
            fetchedResults.push(r);
          }
        }
        // 재시도 응답에 아예 안 실린 언어(모델이 빠뜨림)도 여전히 초과
        // 목록에 남긴다 — 실제 새 길이를 모르니 이전 길이를 그대로 보고한다.
        for (const lang of retryLanguages) {
          if (!respondedLanguages.has(targetKey(lang))) {
            nextOversized.push({ language: lang.label, languageCode: lang.code, length: retryLengths.get(targetKey(lang)) });
          }
        }
        stillOversized = nextOversized;
      }
      oversizedTitles = stillOversized; // 재시도로도 못 줄인 것만 최종 보고

      // TASK CS-v1.8 follow-up — was gated on `truncated`, i.e. only computed
      // when parseJsonText() needed salvageJsonObjects() to recover a
      // malformed/cut-off response. Measured a real case this missed: a
      // batch that parsed as perfectly valid JSON (so `truncated` stayed
      // false) but the model's array simply had fewer objects than
      // languages requested — 4 of 10 requested languages silently
      // vanished with no signal at all, not even in this field. A language
      // is "missing" whenever it isn't in the final fetchedResults, for
      // whatever reason (truncation, an oversized title dropped just
      // above, or the model just not generating an entry for it) — compute
      // that unconditionally instead of only checking it in the one case
      // we happened to already have a name for.
      const recoveredLanguages = new Set(fetchedResults.map(resultKey));
      const missingEntries = languagesToFetch.filter((lang) => !recoveredLanguages.has(targetKey(lang)));
      missingLanguages = missingEntries.map((lang) => lang.label);
      missingLanguageCodes = missingEntries.map((lang) => lang.code);

      // TASK 후속 — 429/서버오류(lib/gemini.js가 남김)와 구분되는 세 번째
      // 실패 유형: 호출 자체는 성공했지만 응답이 요청한 언어를 다 못
      // 채웠다(파싱 실패 후 salvage든, 그냥 개수가 모자라든). quota/server와
      // 같은 파일·같은 형식으로 남겨야 "오늘 실패의 대부분이 어느
      // 유형인지"를 한 파일에서 볼 수 있다.
      // TASK 후속(재조사) — 실측 결과 오늘 실패의 실제 원인은 429가 아니라
      // 이 100자 필터였다(스웨덴어 139자 등, HTTP 200/파싱 정상/토큰 여유
      // 충분한데도 missing 처리됨). missingLanguages 전부가 100자 초과
      // 때문이면 type을 'oversized'로 더 구체적으로 남긴다 — 'truncated'는
      // "무엇 때문인지 모르겠지만 모자람"이라는 뜻이 강해서, 원인이 이미
      // 명확한 이 경우를 뭉뚱그리면 다음에 또 헷갈린다.
      if (missingLanguages.length > 0) {
        const allMissingAreOversized = oversizedTitles.length > 0 && oversizedTitles.length === missingLanguages.length;
        logGeminiError({
          label: 'yt/translate',
          tier: hasPaidKey() ? 'paid' : 'free',
          scope,
          languageCount: languagesToFetch.length,
          status: 200,
          type: allMissingAreOversized ? 'oversized' : 'truncated',
          missingCount: missingLanguages.length,
          oversizedTitles: oversizedTitles.length ? oversizedTitles : undefined,
          // TASK 후속(재조사) — parsedTruncated: JSON 자체가 중간에 끊겨
          // salvage가 필요했는지(=진짜 maxOutputTokens 잘림) 아니면
          // 문법적으로 멀쩡한 JSON인데 모델이 그냥 일부 언어만 생성했는지
          // 구분한다. responseLength/usageMetadata는 "잘려서" 짧은 건지
          // "thinking이 출력 예산을 다 먹어서" 짧은 건지(CS-v1.8이 이미
          // 확인한 바 있는 현상 — /regenerate가 thinkingConfig 없이 904
          // thoughtsTokenCount를 쓴 전례가 있다) 가늠하는 데 쓴다.
          parsedTruncated: truncated,
          responseLength: String(response.text || '').length,
          usageMetadata: response.usageMetadata || null,
          responseSnippet: snippetForLog(response.text),
        });
      }

      // TASK CS-v1.8 — cache whatever actually came back, salvaged partial
      // batch included, so the languages that DID complete never cost a
      // second call just because one language in the same batch got cut off.
      if (fetchedResults.length) {
        setCachedTranslations({ model, title, description, results: fetchedResults, scope, sourceLanguage: source.code });
      }
    }

    const byLanguage = new Map();
    for (const result of cachedResults) byLanguage.set(resultKey(result), result);
    for (const result of fetchedResults) byLanguage.set(resultKey(result), result);
    const results = languages.map((lang) => byLanguage.get(targetKey(lang))).filter(Boolean);

    res.json({
      results,
      model, // TASK CS-v2.2 작업 A 요구사항 3 — 요청값이 아니라 서버가 실제로 적용한 값(폴백 포함)
      truncated,
      missingLanguages,
      missingLanguageCodes,
      sourceLanguageCode: source.code, // TASK CS-v2.6 — 서버가 실제로 프롬프트에 명시한 원본 언어
      oversizedTitles, // TASK 후속(재조사) — [{language, length}], 100자 초과로 제외된 언어와 실제 길이. 화면이 "○○ N자 → 100자 초과" 로 보여줄 수 있게.
      fromCache: cachedResults.map((result) => result.language),
      scope, // TASK CS-v2.1 작업 A 요구사항 4 — 요청값과 다를 수 있으므로(향후 검증 실패 등) 실제 적용값을 응답에 담는다
    });
  } catch (error) {
    next(error);
  }
});

router.post('/regenerate', async (req, res, next) => {
  try {
    if (!currentKey('paid')) {
      const error = new Error('무료 Gemini 키를 설정하면 재생성할 수 있습니다.');
      error.status = 400;
      error.needsKey = true;
      throw error;
    }
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '');
    // TASK CS-v2.6 — /translate와 같은 형태로 대상 언어(label+code)와 원본 언어를 받는다.
    const [target] = parseTargetLanguages([
      req.body?.languageCode ? { label: req.body?.language, code: req.body.languageCode } : req.body?.language,
    ]);
    const source = parseSourceLanguage(req.body);
    const field = req.body?.field === 'description' ? 'description' : 'title';
    const model = resolveModel(req.body?.model); // TASK CS-v2.2 작업 A
    if (!target) return res.status(400).json({ error: '대상 언어가 없습니다.' });
    assertNoSourceTarget(source, [target]);
    const ai = requireGeminiClient('paid'); // TASK CS-v1.8 — the other paid-tier call site, alongside /translate

    const language = `${target.label}${target.code ? ` [${target.code}]` : ''}`;
    const sourceNote = `The original is written in ${source.englishName} (${source.code}).`;
    const prompt = field === 'title'
      ? `Translate and rewrite this YouTube title naturally in ${language}. ${sourceNote} Maximum 100 Unicode characters. Preserve [playlist] and emojis. Return only the title, with no quotes or explanation.\n\nOriginal title:\n${title}`
      : `Translate and rewrite this YouTube description naturally in ${language}. ${sourceNote} Translate normal hashtags, preserve emojis, URLs, timestamps, and track-list song-title lines exactly. Return only the description, with no explanation.\n\nOriginal description:\n${description}`;

    let response;
    try {
      // TASK CS-v1.8 — this used to call generateContent with no config at
      // all, which meant no thinkingConfig either; measured that costing ~53x
      // the actual output in thinking tokens (see generateWithOptionalThinking's
      // doc comment above). maxOutputTokens: 4096 is generous for a single
      // title/description rewrite while still bounding the worst case.
      response = await generateWithOptionalThinking(ai, {
        contents: prompt,
        config: { maxOutputTokens: 4096 },
      }, { label: 'yt/regenerate', model });
    } catch (geminiError) {
      // TASK CS-v2.2 작업 B 요구사항 3 — /translate와 같은 원칙: 404면
      // 조용히 다른 모델로 갈아타지 않고 사용 가능한 목록과 함께 알린다.
      if (Number(geminiError?.status) === 404) {
        let availableModels = [];
        try { availableModels = await listTextModels(); } catch { /* 목록 조회 실패해도 404 사실은 그대로 알린다 */ }
        return res.status(404).json({
          error: `모델 "${model}"을(를) 사용할 수 없습니다. 목록에서 다른 모델을 선택해 주세요.`,
          modelNotFound: true,
          requestedModel: model,
          availableModels,
        });
      }
      throw geminiError;
    }
    const text = String(response.text || '').trim();
    if (!text) throw new Error('재생성 결과가 비어 있습니다.');
    res.json({ text: field === 'title' ? text.slice(0, 100) : text, model });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------ *
 * TASK CS-v1.6 — 유튜브 자동 등록 (videos.update: localizations)
 *
 * What YouTube actually offers here, and what it doesn't:
 *   - A video resource can carry a `localizations` map keyed by BCP-47 code.
 *     Viewers whose YouTube UI language matches a key see that localized
 *     title/description instead of the original. This is the feature the user
 *     saw; it is *not* YouTube auto-translating anything — we supply the text,
 *     which is exactly what this tool already produces.
 *   - Setting it requires `snippet.defaultLanguage` (the language the original
 *     title/description are written in) to be set on the same video.
 *   - videos.update is a full replace of every part named in `part`. Any
 *     property with an existing value that we omit gets DELETED. So every
 *     write below is strictly read-modify-write: videos.list first, keep the
 *     existing title/description/categoryId/tags and existing localizations,
 *     then merge ours on top. Never construct a snippet from scratch.
 *   - Quota: videos.update costs 50 units, videos.list 1, regardless of how
 *     many languages ride along in one call. The default daily quota is
 *     10,000 units, so ~190 videos/day — far past this channel's 12/week.
 * ------------------------------------------------------------------ */

/*
 * TASK CS-v2.4 — 상태 응답이 계정 목록을 통째로 싣는다. refresh token은 절대
 * 서버 밖으로 내보내지 않는다: 그 행이 실제로 연결돼 있는지는 `hasToken`
 * 불리언 하나로만 알린다. CLAUDE.md 3.5가 Gemini 키에 그은 선인데, 살아 있는
 * 채널에 쓰기 권한을 주는 OAuth refresh token은 최소한 그만큼은 지켜야 한다.
 */
function oauthStatePayload(port) {
  const file = readOAuthFile();
  return {
    hasClient: hasClientCredentials(),
    activeAccountId: file.activeAccountId || '',
    accounts: listAccounts().map((account) => ({
      id: account.id,
      label: account.label,
      channelTitle: account.channelTitle || '',
      channelId: account.channelId || '',
      connectedAt: account.connectedAt || '',
      connectionAgeDays: connectionAgeDays(account),
      probablyExpired: isProbablyExpired(account),
      hasToken: Boolean(account.refreshToken),
    })),
    testingTokenDays: TESTING_REFRESH_TOKEN_DAYS,
    redirectUri: redirectUri(port),
    clientIdPreview: file.clientId ? `${String(file.clientId).slice(0, 14)}…` : '',
  };
}

router.get('/oauth/status', (req, res) => {
  res.json(oauthStatePayload(req.socket.localPort));
});

router.post('/oauth/credentials', (req, res, next) => {
  try {
    saveClientCredentials(req.body?.clientId, req.body?.clientSecret);
    res.json({ ok: true, ...oauthStatePayload(req.socket.localPort) });
  } catch (error) { next(error); }
});

router.get('/oauth/start', (req, res, next) => {
  try {
    res.redirect(buildAuthUrl(req.socket.localPort, {
      label: String(req.query.label || ''),
      reconnectId: String(req.query.reconnect || ''),
    }));
  } catch (error) { next(error); }
});

router.post('/oauth/active', (req, res, next) => {
  try {
    setActiveAccount(req.body?.accountId);
    res.json({ ok: true, ...oauthStatePayload(req.socket.localPort) });
  } catch (error) { next(error); }
});

router.post('/oauth/rename', (req, res, next) => {
  try {
    renameAccount(req.body?.accountId, req.body?.label);
    res.json({ ok: true, ...oauthStatePayload(req.socket.localPort) });
  } catch (error) { next(error); }
});

// 콜백 페이지는 채널 이름·계정 별명을 그대로 HTML에 심는다. 둘 다 사용자가
// 정하거나 유튜브에서 온 문자열이므로 이스케이프한다.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * Google redirects the user's browser here after consent. This renders a plain
 * HTML page (not JSON) because a human is looking at it — it tells the opener
 * window to refresh its status and then closes itself.
 */
router.get('/oauth/callback', async (req, res) => {
  const page = (title, body, ok = true) => `<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<title>${title}</title><style>body{font-family:"Malgun Gothic",system-ui,sans-serif;background:#0f1420;color:#e8edf7;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px}
h1{font-size:20px;margin:0 0 10px;color:${ok ? '#5eead4' : '#fca5a5'}}p{color:#98a2b3;line-height:1.7;margin:0}</style></head>
<body><div><h1>${title}</h1><p>${body}</p></div>
<script>try{window.opener&&window.opener.postMessage({type:'creator-studio:yt-oauth'},'*');}catch(e){}
setTimeout(function(){window.close();},${ok ? 1800 : 6000});</script></body></html>`;

  try {
    if (req.query.error) throw new Error(`구글에서 권한을 거부했습니다: ${req.query.error}`);
    const pending = consumeState(req.query.state);
    if (!pending) throw new Error('요청 검증에 실패했습니다(state 불일치). 연결을 처음부터 다시 시도해 주세요.');
    const { accountId } = await exchangeCodeForTokens(req.query.code, req.socket.localPort, pending);

    let channelTitle = '';
    let duplicateOf = null;
    try {
      const channels = await youtubeApi('channels', { query: { part: 'snippet', mine: 'true' }, accountId });
      const channel = channels?.items?.[0];
      if (channel) {
        channelTitle = channel.snippet?.title || '';
        ({ duplicateOf } = rememberChannel(accountId, { channelId: channel.id, channelTitle }));
      }
    } catch { /* the connection itself succeeded; the channel name is a nicety */ }

    // TASK CS-v2.4 — 같은 채널이 두 번 등록되면 사용자는 "일본 채널을 추가했다"고
    // 믿는데 실제로는 한국 채널이 하나 더 생긴 것이라, 그 행을 골라 등록하면
    // 한국 채널에 일본어 제목이 올라간다. 조용히 성공으로 보이면 안 된다.
    if (duplicateOf) {
      return res.send(page(
        '이미 등록된 채널입니다',
        `${escapeHtml(duplicateOf.label)}의 연결을 갱신했습니다.<br />` +
        '다른 채널을 추가하시려면 구글 계정 선택 화면에서 <b>다른 계정</b>을 골라 주세요.',
        true
      ));
    }

    res.send(page('연결되었습니다', `${channelTitle ? `채널: ${escapeHtml(channelTitle)}<br />` : ''}이 창은 곧 자동으로 닫힙니다.`));
  } catch (error) {
    res.status(400).send(page('연결하지 못했습니다', String(error.message || error), false));
  }
});

router.post('/oauth/disconnect', (req, res, next) => {
  try {
    const { removed, activeAccountId } = disconnect(req.body?.accountId);
    res.json({ ok: true, removed, activeAccountId, ...oauthStatePayload(req.socket.localPort) });
  } catch (error) { next(error); }
});

/** The authorized account's own uploads — so the user picks a video instead of pasting an ID. */
router.get('/my-videos', async (req, res, next) => {
  try {
    const account = getAccount(req.query.accountId);
    const channels = await youtubeApi('channels', { query: { part: 'contentDetails,snippet', mine: 'true' }, accountId: account.id });
    const channel = channels?.items?.[0];
    const uploadsId = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) throw Object.assign(new Error('연결된 계정에서 채널을 찾지 못했습니다.'), { status: 404 });
    rememberChannel(account.id, { channelId: channel.id, channelTitle: channel.snippet?.title });

    const items = await youtubeApi('playlistItems', {
      query: {
        part: 'snippet,contentDetails',
        playlistId: uploadsId,
        maxResults: Math.min(50, Math.max(1, Number(req.query.maxResults) || 25)),
        pageToken: req.query.pageToken || '',
      },
      accountId: account.id,
    });
    res.json({
      accountId: account.id,
      accountLabel: account.label,
      channelTitle: channel.snippet?.title || '',
      nextPageToken: items.nextPageToken || '',
      videos: (items.items || []).map((item) => ({
        videoId: item.contentDetails?.videoId || '',
        title: item.snippet?.title || '',
        publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || '',
        thumbnail: item.snippet?.thumbnails?.default?.url || '',
      })).filter((v) => v.videoId),
    });
  } catch (error) { next(error); }
});

/**
 * Current localizations already on a video — lets the user see what will be
 * added vs overwritten before publishing, AND (TASK CS-v2.0 작업 B) lets the
 * client re-read this same endpoint right after a publish to confirm what
 * actually landed. videos.list costs 1 unit regardless of how many
 * localizations come back, vs videos.update's 50 — a second read right after
 * every publish is negligible against the 10,000/day default (CLAUDE.md 4.4).
 */
router.get('/localizations', async (req, res, next) => {
  try {
    const videoId = extractVideoId(String(req.query.videoId || ''));
    if (!videoId) throw Object.assign(new Error('영상 ID를 확인하지 못했습니다.'), { status: 400 });
    const account = getAccount(req.query.accountId);
    const data = await youtubeApi('videos', { query: { part: 'snippet,localizations', id: videoId }, accountId: account.id });
    const video = data?.items?.[0];
    if (!video) throw Object.assign(new Error('영상을 찾지 못했습니다.'), { status: 404 });
    res.json({
      videoId,
      title: video.snippet?.title || '',
      channelId: video.snippet?.channelId || '',
      defaultLanguage: video.snippet?.defaultLanguage || '',
      existing: Object.entries(video.localizations || {}).map(([code, value]) => ({ code, title: value?.title || '' })),
    });
  } catch (error) { next(error); }
});

/**
 * dryRun=true resolves language codes and reports exactly what would be
 * written, without touching YouTube at all beyond a read — the same
 * "미리보기 → 적용" shape the timeline rename tool already uses, and for the
 * same reason: this writes to a live public channel.
 */
router.post('/publish-localizations', async (req, res, next) => {
  try {
    const videoId = extractVideoId(String(req.body?.videoId || ''));
    if (!videoId) throw Object.assign(new Error('영상 URL 또는 11자리 영상 ID를 입력해 주세요.'), { status: 400 });
    const defaultLanguage = String(req.body?.defaultLanguage || 'ko').trim() || 'ko';
    // TASK CS-v2.6 — 선택지가 3개 고정에서 카탈로그 전체로 넓어졌으므로 형식을 검사한다.
    if (!isValidLanguageCode(defaultLanguage)) throw Object.assign(new Error(`원문 언어 코드 형식이 올바르지 않습니다: "${defaultLanguage.slice(0, 20)}"`), { status: 400 });
    const dryRun = Boolean(req.body?.dryRun);
    const translations = Array.isArray(req.body?.translations) ? req.body.translations : [];
    if (!translations.length) throw Object.assign(new Error('등록할 번역 결과가 없습니다.'), { status: 400 });

    const account = getAccount(req.body?.accountId);
    const accessToken = await getAccessToken(account.id);
    const supported = await fetchSupportedLanguages({ accessToken });
    const { planned, skipped } = planLocalizations(translations, supported, { defaultLanguage });

    const listed = await youtubeApi('videos', { query: { part: 'snippet,localizations', id: videoId }, accountId: account.id });
    const video = listed?.items?.[0];
    if (!video) throw Object.assign(new Error('영상을 찾지 못했습니다. 비공개/삭제된 영상이거나 ID가 틀렸을 수 있습니다.'), { status: 404 });

    // TASK CS-v2.4 — 소유권 검사는 이제 "선택한 계정"의 채널과 대조한다. 계정이
    // 하나뿐이던 v1.6에서는 거의 형식적인 검사였지만, 다계정에서는 계정을 잘못
    // 고르는 일이 실제로 일어난다 — 그리고 그 결과가 내 다른 채널에 대한 잘못된
    // 쓰기다. 그래서 고칠 방법("계정을 바꾸세요")이 메시지에서 바로 보여야 한다.
    const myChannelId = account.channelId;
    if (myChannelId && video.snippet?.channelId && video.snippet.channelId !== myChannelId) {
      throw Object.assign(
        new Error(`선택한 계정 "${account.label}"의 채널 영상이 아닙니다. 계정 목록에서 이 영상이 올라간 채널을 고른 뒤 다시 시도해 주세요.`),
        { status: 403 }
      );
    }

    const existing = video.localizations || {};
    const overwriting = planned.filter((p) => existing[p.code]).map((p) => p.code);

    // Read-modify-write: everything already on the video is carried over
    // verbatim, because videos.update deletes any omitted property.
    //
    // TASK CS-v2.1 작업 D — item.description이 비어 있으면(scope:'title'로
    // 번역된 언어) description 필드를 아예 뺀다. 실제 API로 확인한 결과
    // (2026-08-17, 테스트 영상 h28QuWIhr0w에 title만 있고 description
    // 필드 자체가 없는 localization을 실제로 등록 후 유튜브 화면에서
    // hl=sw로 직접 확인): description을 생략하면 유튜브가 그 언어를 볼 때
    // 원문(기본 언어) 설명을 그대로 보여준다 — 빈 설명으로 보이지 않는다.
    // 그래서 빈 문자열을 명시적으로 넣지 않는다: 빈 문자열을 넣으면 그
    // 값 자체가 "설명은 빈 문자열"로 저장되어 원문 폴백이 안 될 수 있다
    // (이 자리에서 굳이 확인하지 않음 — 생략이 이미 검증된 안전한 선택).
    const localizations = { ...existing };
    for (const item of planned) {
      const entry = { title: item.title };
      if (item.description) entry.description = item.description;
      localizations[item.code] = entry;
    }
    const snippet = {
      title: video.snippet?.title || '',
      description: video.snippet?.description || '',
      categoryId: video.snippet?.categoryId || '10',
      defaultLanguage,
    };
    if (Array.isArray(video.snippet?.tags) && video.snippet.tags.length) snippet.tags = video.snippet.tags;

    // TASK CS-v2.3 — 유튜브에 보내기 전 서버가 직접 길이를 센다. `localizations`는
    // existing(예전 등록분) + planned(이번 등록분)를 이미 합친 맵이라, 예전에
    // 등록됐지만 지금 기준으로 초과인 언어도 여기서 같이 걸린다(요구사항 3).
    const problems = validatePublishPayload({ snippet, localizations });
    // TASK CS-v2.6 — 바이트는 차단하지 않고 측정만 한다(describeByteRisks() 주석 참고).
    const byteRisks = describeByteRisks({
      snippet,
      localizations,
      plannedCodes: planned.map((p) => p.code),
      // 처음 설정하는 경우(빈 값)도 '바꾸는' 것이다 — 어느 쪽이든 snippet을 새 값으로 보낸다.
      defaultLanguageChanging: (video.snippet?.defaultLanguage || '') !== defaultLanguage,
    });

    if (dryRun) {
      return res.json({
        dryRun: true,
        accountId: account.id,
        accountLabel: account.label,
        videoId,
        videoTitle: video.snippet?.title || '',
        currentDefaultLanguage: video.snippet?.defaultLanguage || '',
        defaultLanguage,
        planned,
        skipped,
        overwriting,
        existingCount: Object.keys(existing).length,
        problems,
        byteRisks,
      });
    }

    if (!planned.length) throw Object.assign(new Error('등록 가능한 언어가 하나도 없습니다.'), { status: 400 });

    // 미리보기와 똑같은 검증을 적용 직전에 한 번 더 돈다(4.1 — 적용 시점에
    // "계획"은 다시 계산하지 않지만, 계획을 보낼지 말지의 안전 검증은 항상
    // 다시 한다). 넘는 게 있으면 유튜브에 아예 보내지 않는다 — 40개 중
    // 하나가 초과라고 전체 PUT이 거부되는 것보다, 어떤 언어의 어떤 필드가
    // 몇 자인지 먼저 알려주고 사용자가 고치게 하는 편이 낫다.
    if (problems.length) {
      throw Object.assign(new Error(formatPublishProblems(problems)), { status: 422, problems });
    }

    const updated = await youtubeApi('videos', {
      method: 'PUT',
      query: { part: 'snippet,localizations' },
      body: { id: videoId, snippet, localizations },
      accountId: account.id,
    });

    res.json({
      ok: true,
      accountId: account.id,
      accountLabel: account.label,
      videoId,
      videoTitle: updated?.snippet?.title || video.snippet?.title || '',
      defaultLanguage,
      publishedCount: planned.length,
      published: planned.map((p) => ({ language: p.language, code: p.code, note: p.note })),
      skipped,
      overwriting,
      totalLocalizations: Object.keys(updated?.localizations || localizations).length,
      quotaNote: 'videos.update 1회 = 50 유닛 (기본 일일 한도 10,000 유닛)',
    });
  } catch (error) { next(error); }
});

export default router;
