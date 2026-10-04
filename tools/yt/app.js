/*
 * TASK CS-v2.6 — 번역 대상 언어는 더 이상 이 파일의 하드코딩 라벨 50개가 아니다.
 * 그 배열에는 '한국어'가 없어서(원문이 한국어라는 전제) 일본어 원본 채널이
 * 한국어 번역을 만들 수 없었다. 이제 GET /api/yt/languages가 주는 카탈로그
 * ({code, label}, 1순위는 유튜브 i18nLanguages 공식 목록, 실패하면 서버 내장
 * 대체 목록)로 화면을 그리고, 언어의 식별자는 라벨이 아니라 코드다.
 *
 * EMERGENCY_CATALOG는 서버에 아예 닿지 못했을 때 화면이 비지 않게 하는
 * 최소한이다(정식 대체 목록은 lib/ytLanguages.js의 FALLBACK_LANGUAGE_CATALOG).
 * 서버가 없으면 번역 자체가 안 되므로 여기를 크게 키울 이유가 없다.
 */
const EMERGENCY_CATALOG = [
  { code: 'ja', label: '일본어' }, { code: 'ko', label: '한국어' }, { code: 'en', label: '영어' },
  { code: 'zh-CN', label: '중국어(간체)' }, { code: 'zh-TW', label: '중국어(번체)' }, { code: 'id', label: '인도네시아어' },
  { code: 'th', label: '태국어' }, { code: 'vi', label: '베트남어' }, { code: 'es-419', label: '스페인어(라틴 아메리카)' },
  { code: 'pt', label: '포르투갈어(브라질)' }, { code: 'fr', label: '프랑스어' },
];

// 원본 언어 선택에서 맨 위에 고정하는 언어(두 채널 + 영어).
const PINNED_SOURCE_CODES = ['ja', 'ko', 'en'];
// 원본이 이 언어면 짝 언어를 대상에 자동으로 넣는다 — 일본 채널의 한국어,
// 한국 채널의 일본어는 이 프로젝트에서 빠지면 안 되는 대상이다.
const PARTNER_LANGUAGE = { ja: 'ko', ko: 'ja' };

/*
 * 프리셋은 "후보 코드 배열"의 목록이다(앞쪽 우선). 공식 목록의 실제 코드가
 * 지역형(en-US, zh-Hant …)일 수도, 기본형(en, zh-TW …)일 수도 있어서 카탈로그에
 * 실제로 있는 첫 후보를 쓴다. 원본 언어는 건너뛴다 — 그래서 CORE에 ko와 ja가
 * 둘 다 있어도 일본어 원본이면 [한국어, 영어, …], 한국어 원본이면 [일본어,
 * 영어, …]로 10개가 된다(지시서의 일본채널/한국채널 핵심 10개).
 */
const CORE_PRESET = [
  ['ko'], ['ja'], ['en', 'en-US'], ['zh-CN', 'zh-Hans'], ['zh-TW', 'zh-Hant'], ['id'], ['th'], ['vi'],
  ['es-419', 'es', 'es-ES'], ['pt-BR', 'pt'], ['fr', 'fr-FR'],
];
const CORE_PRESET_SIZE = 10;
const ASIA_PRESET = [
  ['ko'], ['ja'], ['zh-CN', 'zh-Hans'], ['zh-TW', 'zh-Hant'], ['zh-HK'], ['th'], ['vi'], ['id'], ['ms'], ['fil', 'tl'],
  ['hi'], ['bn'], ['km'], ['lo'], ['my'], ['mn'], ['ne'], ['si'], ['ta'], ['te'], ['ur'],
];
const GLOBAL_PRESET = [
  ['en', 'en-US'], ['en-GB'], ['es-419'], ['es', 'es-ES'], ['pt-BR', 'pt'], ['pt-PT'], ['fr', 'fr-FR'], ['fr-CA'],
  ['de', 'de-DE'], ['it'], ['nl'], ['ru'], ['uk'], ['pl'], ['tr'], ['ar'], ['fa'], ['iw', 'he'], ['hi'], ['id'],
  ['sv'], ['no', 'nb'], ['da'], ['fi'], ['el'], ['cs'], ['hu'], ['ro'], ['ja'], ['ko'], ['zh-CN', 'zh-Hans'], ['zh-TW', 'zh-Hant'],
];

const state = {
  // TASK CS-v2.6 — 언어 카탈로그와 원본 언어. selected/descriptionScope는 이제
  // 라벨이 아니라 코드의 Set이다. catalogReady 전에는 비어 있고, 저장돼 있던
  // 선택(restoredSelection)은 카탈로그가 도착한 뒤 applyCatalog()가 옮겨 담는다
  // — 예전 저장분(라벨)을 코드로 풀려면 서버의 legacyLabelCodes가 필요하기 때문.
  catalog: [],
  catalogSource: 'loading', // 'youtube' | 'fallback' | 'emergency' | 'loading'
  catalogReady: false,
  legacyLabelCodes: {},
  restoredSelection: null,
  sourceLanguage: 'ja',
  selected: new Set(),
  results: [],
  // TASK CS-v1.8 — which title+description state.results was generated for.
  // "이어서 번역"/hasResultFor() trust state.results as "already translated",
  // but unlike the server cache (keyed by title+description+language, so an
  // edit is automatically a cache miss) a plain in-memory array has no such
  // check. Without this, editing the title after translating and then
  // hitting "이어서 번역" would treat the pre-edit translations as done and
  // leave them stale instead of re-fetching for the new text.
  resultsSourceKey: null,
  sourceMeta: null,
  translating: false,
  geminiConfigured: false,
  // TASK CS-v2.1 작업 C — 설명까지 번역할 언어. state.selected의 부분집합
  // (그 안에서만 의미가 있다). 기본값은 비어있음 = 전 언어 제목만.
  descriptionScope: new Set(),
  // TASK CS-v2.1 후속 버그 [1] — 언어별 연속 실패 횟수. missingLanguages에
  // 나올 때마다 늘고, 그 언어가 실제로 성공하면(upsertResults) 0으로
  // 돌아간다(Map에서 삭제). 새로고침 시 초기화되는 건 의도됨 — 세션을
  // 새로 시작하면 "몇 번 실패했었는지"보다 "지금 다시 해보자"가 맞다.
  languageFailCounts: new Map(),
  // TASK CS-v1.8 follow-up — drives the confirm-box/regenerate-button
  // wording: "비용이 발생합니다" only makes sense when a paid key is
  // actually configured. Set from /api/yt/status in loadStatus().
  paidKeyConfigured: false,
  // TASK CS-v2.2 작업 A/C — 번역·재생성·추출에 실제로 보낼 모델. null이면
  // 아직 아무것도 정해지지 않은 상태(restoreLocal()이 저장된 값을 채우고,
  // 그래도 비어 있으면 loadStatus()가 서버 기본값으로 채운다). 서버가
  // 검증/폴백하므로(routes/yt.js resolveModel) 여기서 잘못된 값을 보내도
  // 서버가 막아준다 — 클라이언트는 UX용 확인일 뿐 최종 방어선이 아니다.
  model: null,
  // TASK CS-v2.2 작업 B.2 — GET /api/yt/models 결과. 비어 있으면(조회
  // 실패) 드롭다운 대신 자유 입력 칸으로 폴백한다.
  modelList: [],
};

// TASK CS-v2.2 — /api/yt/status 응답 전체를 기억해 둔다. 배지 줄은
// loadStatus()·loadModelList() 양쪽에서 다시 그려야 하는데(모델 목록이
// status보다 늦게 도착할 수 있음), 매번 다시 fetch하지 않고 마지막으로
// 받은 status를 재사용해 다시 그린다.
let lastStatus = null;

const $ = (id) => document.getElementById(id);

function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.add('hidden'), 1900);
}

function setError(id, message = '') {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `요청 실패 (${response.status})`);
    // TASK CS-v2.0 — /api/yt/translate의 429 응답은 error 문자열 말고도
    // quotaExhausted/missingLanguages/paidKeyConfigured/quotaScope/results 같은
    // 구조화된 필드를 함께 보낸다(routes/yt.js). 여기서 실려 보내야 호출부가
    // error.message 말고 이 필드들도 읽을 수 있다.
    Object.assign(error, data);
    throw error;
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function applyTranslateGate() {
  const gate = $('translateGate');
  $('translateBtn').disabled = !state.geminiConfigured;
  if (state.geminiConfigured) {
    gate.classList.add('hidden');
    return;
  }
  gate.innerHTML = '무료 Gemini 키를 설정하면 번역할 수 있습니다. 상단 앱 셸의 키 배지에서 입력하세요 (무료, 결제 등록 불필요). ' +
    '<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">키 발급받기</a>';
  gate.classList.remove('hidden');
}

/** e.g. 45230 -> "약 4.5만", 3000 -> "3,000" — Korean "만" (10,000) grouping for the cost badge. */
function formatTokensMan(tokens) {
  if (!tokens) return '0';
  if (tokens < 10000) return tokens.toLocaleString('ko-KR');
  return `약 ${(tokens / 10000).toFixed(1)}만`;
}

/*
 * TASK CS-v2.2 작업 C 요구사항 1 — 상단 배지의 모델 "표시"를 실제로 고를 수
 * 있는 컨트롤로 바꾼다. state.modelList가 비어 있으면(목록 조회 실패 —
 * 요구사항 B.2 "네트워크 문제로 화면이 막히면 안 된다") select 대신 자유
 * 입력 칸으로 폴백한다. 목록에 현재 state.model이 없는 드문 경우(예:
 * localStorage에 저장된 값이 그 사이 은퇴됨)도 select 맨 위에 실제 값을
 * 그대로 보여준다 — 조용히 다른 값으로 바뀐 것처럼 보이면 안 된다.
 */
function buildModelControlHtml() {
  const current = state.model || '';
  if (state.modelList.length) {
    const hasCurrent = state.modelList.some((m) => m.name === current);
    const currentOptionHtml = hasCurrent ? '' : `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (목록에 없음)</option>`;
    const optionsHtml = state.modelList.map((m) => {
      const label = m.displayName ? `${m.displayName} (${m.name})` : m.name;
      return `<option value="${escapeHtml(m.name)}" ${m.name === current ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    return `<select id="modelSelect" class="model-select" title="번역·재생성·추출에 사용할 Gemini 모델">${currentOptionHtml}${optionsHtml}</select>`;
  }
  return `<input id="modelInput" class="model-input" type="text" value="${escapeHtml(current)}" placeholder="예: gemini-3.5-flash" title="모델 목록을 불러오지 못해 직접 입력합니다" />`;
}

function wireModelControl() {
  const select = $('modelSelect');
  if (select) select.addEventListener('change', () => onModelChange(select.value));
  const input = $('modelInput');
  if (input) input.addEventListener('change', () => onModelChange(input.value.trim()));
}

function renderStatusBadges() {
  const status = lastStatus;
  if (!status) return;
  const usage = status.geminiUsageToday;
  // TASK CS-v1.7 — reference-only badge: this PC's 5 tools combined, today.
  // Doesn't gate anything (lib/geminiUsage.js is display-only by design);
  // the actual limit is whatever Google AI Studio's dashboard says.
  const usageBadge = usage
    ? `<span class="badge" title="오늘 이 PC의 5개 도구 합산 호출 수 · 참고용, 실제 한도는 Google AI Studio 대시보드 기준">오늘 Gemini 호출 ${usage.total}회${usage.failed ? ` (실패 ${usage.failed})` : ''}</span>`
    : '';
  // TASK CS-v1.8 — this tool's 번역/재생성 calls go through the paid slot
  // whenever a paid key is configured (lib/keyStore.js's currentKey('paid')
  // fallback), so make that visible right where the cost is actually incurred.
  const tierBadge = status.paidKeyConfigured
    ? `<span class="badge warn" title="이 화면의 번역·재생성 호출만 유료 키로 나갑니다. 다른 4개 도구는 무료 키를 그대로 씁니다.">번역: 유료 키 사용 중</span>`
    : `<span class="badge" title="유료 키를 설정하지 않아 무료 키로 동작합니다.">번역: 무료 키 사용 중</span>`;
  // TASK CS-v1.8 task D.7 — cost only stays managed if it's visible.
  // TASK CS-v1.8 follow-up — was `paidCalls ? ... : ''`, which lit up as
  // "유료 호출 N회" even with no paid key configured, because
  // byTier.paid used to count every request routed to the paid SLOT
  // (i.e. every /translate·/regenerate call), not every request that
  // actually spent a paid KEY (lib/gemini.js's currentKey('paid')
  // silently falls back to the free key when unset). That counting bug
  // is fixed at the source now, but a day's worth of already-recorded
  // byTier.paid from before the fix stays mislabeled in
  // .gemini_usage.json (left as-is, see the fix commit) until it ages
  // out at midnight — so gate the "유료" framing on paidKeyConfigured
  // itself, not just a nonzero count, rather than trusting stale data.
  const paidCalls = usage?.byTier?.paid || 0;
  const paidOutputTokens = usage?.tokens?.paid?.output || 0;
  const costBadge = (status.paidKeyConfigured && paidCalls)
    ? `<span class="badge warn" title="유튜브 번역기의 번역·재생성 호출만 집계 · 참고용, 실제 청구는 Google Cloud 콘솔 기준">오늘 유료 호출 ${paidCalls}회 · 출력 ${formatTokensMan(paidOutputTokens)} 토큰</span>`
    : '';
  $('statusBadges').innerHTML = `
    <span class="badge ${status.geminiConfigured ? 'ok' : 'warn'}">Gemini ${status.geminiConfigured ? '설정됨' : '키 필요'}</span>
    <span class="badge ${status.youtubeApiConfigured ? 'ok' : 'warn'}">YouTube API ${status.youtubeApiConfigured ? '설정됨' : '선택 사항'}</span>
    ${buildModelControlHtml()}
    ${tierBadge}
    ${costBadge}
    ${usageBadge}`;
  wireModelControl();
}

// TASK CS-v2.2 작업 C 요구사항 3 — 방향만 안내하고 구체적 금액은 하드코딩하지
// 않는다(단가는 자주 바뀌고, geminiConfig.json의 "추정값 금지" 원칙과 같은
// 이유). 모델이 바뀌어도 이 문구 자체는 바뀔 이유가 없어 loadStatus() 시점에
// 한 번만 채운다.
function renderModelCostHint() {
  const el = $('modelCostHint');
  if (!el) return;
  el.innerHTML = 'lite 계열이 더 저렴합니다. 최신 단가는 <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noopener">구글 공식 요금표</a>에서 확인하세요. 모델을 바꾸면 캐시가 무효화되어 다시 번역됩니다.';
}

async function loadStatus() {
  try {
    const status = await api('/api/yt/status');
    lastStatus = status;
    state.geminiConfigured = Boolean(status.geminiConfigured);
    state.paidKeyConfigured = Boolean(status.paidKeyConfigured);
    // TASK CS-v2.2 작업 A 폴백 순서: 요청값 -> 환경변수 -> 기본값. restoreLocal()이
    // 이미 저장된 값을 채웠으면 그 값을 우선하고, 없을 때만 서버 기본값을 쓴다.
    if (!state.model) state.model = status.model;
    renderStatusBadges();
    renderModelCostHint();
    applyTranslateGate();
  } catch (error) {
    $('statusBadges').innerHTML = '<span class="badge warn">서버 상태 확인 실패</span>';
  }
}

/*
 * TASK CS-v2.2 작업 B.2 — 목록 조회 실패(네트워크 문제 등)는 조용히
 * state.modelList를 비운 채로 둔다. buildModelControlHtml()이 빈 목록을
 * 보면 자유 입력 칸으로 폴백하므로, 이 함수의 실패가 화면을 막지 않는다.
 */
async function loadModelList() {
  try {
    const data = await api('/api/yt/models');
    state.modelList = Array.isArray(data.models) ? data.models : [];
  } catch {
    state.modelList = [];
  }
  renderStatusBadges();
}

/** /translate·/regenerate가 404(모델 사용 불가)를 주면 목록을 갱신해 보여준다 — 조용히 다른 모델로 갈아타지 않는다(요구사항 B.3). */
function handleModelNotFoundError(error) {
  if (!error?.modelNotFound) return false;
  if (Array.isArray(error.availableModels) && error.availableModels.length) {
    state.modelList = error.availableModels;
    renderStatusBadges();
  }
  return true;
}

function applyModelChange(newModel) {
  state.model = newModel;
  state.results = [];
  state.resultsSourceKey = null;
  state.languageFailCounts.clear();
  renderResults();
  renderPendingLanguages();
  renderStatusBadges();
  saveLocal();
  showToast(`모델이 "${newModel}"(으)로 바뀌었습니다. 기존 번역 결과가 초기화되었습니다.`);
}

function showModelChangeConfirm(newModel) {
  $('modelChangeConfirmText').textContent = `모델을 "${newModel}"(으)로 바꾸면 이미 번역된 결과가 모두 초기화되고 다시 번역해야 합니다. ${costPhrase()}. 계속할까요?`;
  $('modelChangeConfirmYesBtn').textContent = `모델 변경 (${costActionLabel()})`;
  $('modelChangeConfirm').dataset.pendingModel = newModel;
  $('modelChangeConfirm').classList.remove('hidden');
}

function hideModelChangeConfirm() {
  $('modelChangeConfirm').classList.add('hidden');
  renderStatusBadges(); // 취소 시 드롭다운/입력칸을 실제 state.model로 되돌려 다시 그린다
}

function onModelChange(newModel) {
  const trimmed = String(newModel || '').trim();
  if (!trimmed || trimmed === state.model) { renderStatusBadges(); return; }
  if (state.results.length > 0) {
    showModelChangeConfirm(trimmed);
  } else {
    applyModelChange(trimmed);
  }
}

function updateTitleCount() {
  const count = Array.from($('sourceTitle').value).length;
  const el = $('sourceTitleCount');
  el.textContent = `${count} / 100`;
  el.classList.toggle('over', count > 100);
}

// TASK CS-v2.6 — 원본 언어도 키에 넣는다. 같은 제목이라도 "일본어 원본"으로 번역한
// 결과와 "한국어 원본"으로 번역한 결과는 다른 프롬프트에서 나온 다른 결과다.
function currentSourceKey() {
  return `${state.sourceLanguage}\u0000${$('sourceTitle').value.trim()}\u0000${$('sourceDescription').value}`;
}

/** Called on every title/description edit — drops results that no longer match what's in the textareas. */
function invalidateResultsIfSourceChanged() {
  if (!state.results.length || state.resultsSourceKey === null) return;
  if (state.resultsSourceKey === currentSourceKey()) return;
  state.results = [];
  state.resultsSourceKey = null;
  renderResults();
}

/* ------------------------------------------------------------------ *
 * TASK CS-v2.6 — 언어 카탈로그·원본 언어
 * ------------------------------------------------------------------ */
function normCode(code) {
  return String(code || '').trim().toLowerCase();
}

function catalogEntry(code) {
  const wanted = normCode(code);
  return state.catalog.find(lang => normCode(lang.code) === wanted) || null;
}

function languageLabel(code) {
  return catalogEntry(code)?.label || String(code || '');
}

function isSourceCode(code) {
  return normCode(code) === normCode(state.sourceLanguage);
}

function partnerCode() {
  const partner = PARTNER_LANGUAGE[normCode(state.sourceLanguage).split('-')[0]];
  return partner ? catalogEntry(partner)?.code || '' : '';
}

/*
 * 대상 언어 목록 = 카탈로그 - 원본 언어. 원본은 회색 처리하지 않고 아예 뺀다
 * (지시서 우선순위). 짝 언어(일본어 원본의 한국어)와 영어를 맨 앞에 두고
 * 나머지는 라벨 순 — 가나다순이면 '한국어'가 80개 목록 맨 끝에 묻힌다.
 */
function targetCatalog() {
  const partner = normCode(partnerCode());
  const rank = (lang) => (normCode(lang.code) === partner ? 0 : normCode(lang.code) === 'en' ? 1 : 2);
  return state.catalog
    .filter(lang => !isSourceCode(lang.code))
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, 'ko'));
}

/** 이 결과가 어느 언어 코드인지. 예전 결과(라벨만 있음)는 서버가 준 legacyLabelCodes로 푼다. */
function resultCode(result) {
  return result?.languageCode || state.legacyLabelCodes[result?.language] || '';
}

function resolvePreset(preset, limit = Infinity) {
  const codes = [];
  for (const candidates of preset) {
    if (codes.length >= limit) break;
    const found = candidates.map(catalogEntry).find(Boolean);
    if (found && !isSourceCode(found.code) && !codes.includes(found.code)) codes.push(found.code);
  }
  return codes;
}

function corePresetLabel() {
  const base = normCode(state.sourceLanguage).split('-')[0];
  if (base === 'ja') return '일본채널 핵심 10개';
  if (base === 'ko') return '한국채널 핵심 10개';
  return '핵심 10개 언어';
}

function languageOptionsHtml(selectedCode) {
  const pinned = PINNED_SOURCE_CODES.map(catalogEntry).filter(Boolean);
  const pinnedSet = new Set(pinned.map(lang => normCode(lang.code)));
  const rest = state.catalog.filter(lang => !pinnedSet.has(normCode(lang.code)));
  const option = (lang) => `<option value="${escapeHtml(lang.code)}" ${normCode(lang.code) === normCode(selectedCode) ? 'selected' : ''}>${escapeHtml(lang.label)} (${escapeHtml(lang.code)})</option>`;
  return `<optgroup label="자주 쓰는 언어">${pinned.map(option).join('')}</optgroup>` +
    `<optgroup label="전체 언어 (${state.catalog.length}개)">${rest.map(option).join('')}</optgroup>`;
}

function renderSourceControls() {
  $('sourceLanguageSelect').innerHTML = languageOptionsHtml(state.sourceLanguage);
  $('sourceLanguageSelect').disabled = !state.catalogReady;
  document.querySelectorAll('[data-source-preset]').forEach(button => {
    button.classList.toggle('is-active', isSourceCode(button.dataset.sourcePreset));
  });
  $('corePresetBtn').textContent = corePresetLabel();
  $('descCorePresetBtn').textContent = corePresetLabel();
  const sourceText = {
    youtube: 'YouTube 공식 목록',
    fallback: '내장 목록 (YouTube 목록 조회 실패 — API 키 또는 계정 연결 시 공식 목록 사용)',
    emergency: '비상 목록 (서버 언어 목록을 불러오지 못함)',
    loading: '언어 목록 불러오는 중…',
  }[state.catalogSource] || '';
  $('catalogSourceBadge').textContent = sourceText;
  $('catalogSourceBadge').classList.toggle('warn', state.catalogSource === 'fallback' || state.catalogSource === 'emergency');
  updateSourceMismatchWarning(); // TASK CS-v2.6.1 — 원본 언어가 바뀌면 경고도 다시 판정
}

/*
 * 유튜브 등록 패널의 원문 언어(snippet.defaultLanguage)는 번역 화면의 원본
 * 언어를 기본으로 따라간다. 사용자가 등록 패널에서 따로 바꿀 수는 있지만(이미
 * 올라간 영상의 원문이 다른 경우), 다르면 경고를 띄운다.
 */
function syncDefaultLanguageSelect({ followSource }) {
  const select = $('defaultLanguageSelect');
  const current = followSource ? state.sourceLanguage : (select.value || state.sourceLanguage);
  select.innerHTML = languageOptionsHtml(current);
  if (followSource) {
    // 기존 리스너(setupPublishEvents)가 'input'에서 미리본 계획을 무효화한다.
    select.dispatchEvent(new Event('input'));
  }
  updateDefaultLanguageHint();
}

function updateDefaultLanguageHint() {
  const value = $('defaultLanguageSelect').value;
  const mismatch = value && !isSourceCode(value);
  const el = $('defaultLanguageHint');
  el.textContent = mismatch
    ? `번역 화면의 원본 언어(${languageLabel(state.sourceLanguage)}, ${state.sourceLanguage})와 다릅니다. 영상에 올라간 원문이 정말 ${languageLabel(value)}인지 확인하세요.`
    : '';
  el.classList.toggle('hidden', !mismatch);
}

function clearResultsForSourceChange() {
  state.results = [];
  state.resultsSourceKey = null;
  state.languageFailCounts.clear();
  hideTranslateConfirm();
  hideQuotaChoice();
  renderResults();
}

function setSourceLanguage(code) {
  const entry = catalogEntry(code);
  if (!entry || isSourceCode(entry.code)) { renderSourceControls(); return; }
  if (state.translating) {
    showToast('번역 중에는 원본 언어를 바꿀 수 없습니다.');
    renderSourceControls();
    return;
  }
  const hadResults = state.results.length > 0;
  state.sourceLanguage = entry.code;
  // 원본은 대상에서 빠지고, 짝 언어(일본어 원본 → 한국어)는 반드시 들어간다.
  state.selected.delete(entry.code);
  state.descriptionScope.delete(entry.code);
  for (const lang of [...state.selected]) if (isSourceCode(lang)) state.selected.delete(lang);
  const partner = partnerCode();
  if (partner) state.selected.add(partner);
  // 원본 언어가 바뀌면 기존 결과는 다른 원문을 전제로 만든 것이다. 서버 캐시는
  // 원본 언어별로 따로 저장돼 있어서, 원래 언어로 되돌리면 대부분 캐시에서 다시 온다.
  if (hadResults) clearResultsForSourceChange();
  renderSourceControls();
  syncDefaultLanguageSelect({ followSource: true });
  renderLanguages($('languageSearch').value);
  saveLocal();
  showToast(hadResults
    ? `원본 언어가 ${entry.label}(${entry.code})로 바뀌어 기존 번역 결과를 비웠습니다. 되돌리면 캐시에서 다시 불러옵니다.`
    : `원본 언어: ${entry.label}(${entry.code})`);
}

/*
 * 카탈로그 도착 후 1회: 저장돼 있던 선택을 코드로 옮겨 담는다. 예전 저장분
 * (CS-v2.5까지, 라벨 배열)은 서버의 legacyLabelCodes로 푼다. 카탈로그에 없는
 * 코드는 버리고 그 사실을 알린다 — 조용히 사라지면 "선택이 왜 줄었지"가 된다.
 */
/*
 * TASK CS-v2.6.1 — 원본 언어와 실제 입력 언어가 어긋나면 경고만 한다(자동 변경·차단
 * 없음). 실제 사례: 원본 언어가 기본값 일본어인 채로 한국어 제목을 넣고 번역하면,
 * 프롬프트가 "The source metadata language is Japanese"라고 잘못 말하게 된다.
 *
 * Gemini를 부르지 않는 로컬 판정이다(비용 0). 판정이 애매하면 경고하지 않는 쪽으로
 * 기운다 — 잘못된 경고가 반복되면 사람들은 경고 자체를 무시하게 된다.
 *   - 판정에서 빼는 것: 타임스탬프가 있는 줄(트랙리스트 — 영어 곡명이 대부분이라
 *     한국어 설명도 영어처럼 보이게 만든다), URL, #해시태그, @핸들, 숫자.
 *   - 한글은 한국어만 쓴다 → 한글이 6자 이상이고 글자의 30% 이상이면 한국어.
 *   - 일본어는 가나로만 확정한다(가나 3자 이상, 가나+한자가 30% 이상). 한자만 있는
 *     글은 중국어인지 일본어인지 알 수 없으므로 판정하지 않는다.
 *   - 로마자는 한중일 문자가 거의 없을 때(5% 이하)만, 15자 이상일 때만.
 *   - 둘 이상 해당하면 한쪽이 3배 이상 우세할 때만 그쪽, 아니면 판정 안 함.
 */
const LATIN_SCRIPT_LANGUAGES = new Set([
  'af', 'az', 'bs', 'ca', 'cs', 'da', 'de', 'en', 'es', 'et', 'eu', 'fil', 'fi', 'fr', 'gl', 'hr', 'hu', 'id', 'is',
  'it', 'lt', 'lv', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'sk', 'sl', 'sq', 'sv', 'sw', 'tr', 'uz', 'vi', 'zu',
]);

function expectedScriptFor(code) {
  const norm = normCode(code);
  const base = norm.split('-')[0];
  if (base === 'ko') return 'hangul';
  if (base === 'ja') return 'japanese';
  if (base === 'zh') return 'han';
  if (LATIN_SCRIPT_LANGUAGES.has(base) || norm === 'sr-latn') return 'latin';
  return null; // 키릴·아랍·태국 문자 등 — 이 판정기가 직접 확인하지 않는 문자
}

function detectInputScript(title, description) {
  const text = `${title || ''}\n${description || ''}`
    .split(/\r?\n/)
    .filter(line => !/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(line))
    .join('\n')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[#@]\S+/g, ' ')
    .replace(/[0-9]/g, ' ');
  const count = (re) => (text.match(re) || []).length;
  const hangul = count(/[가-힣ㄱ-ㆎ]/g);
  const kana = count(/[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]/g);
  const han = count(/[㐀-䶿一-鿿]/g);
  const latin = count(/[A-Za-zÀ-ɏ]/g);
  const letters = hangul + kana + han + latin;
  if (letters < 8) return null;
  const candidates = [];
  if (hangul >= 6 && hangul / letters >= 0.3) candidates.push({ script: 'hangul', code: 'ko', name: '한국어', score: hangul });
  if (kana >= 3 && (kana + han) / letters >= 0.3) candidates.push({ script: 'japanese', code: 'ja', name: '일본어', score: kana + han });
  if (latin >= 15 && (hangul + kana + han) / letters <= 0.05) candidates.push({ script: 'latin', code: 'en', name: '영어(로마자)', score: latin });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 1 && candidates[0].score < candidates[1].score * 3) return null;
  return candidates[0];
}

function sourceMismatch(detected, sourceCode) {
  if (!detected) return false;
  const expected = expectedScriptFor(sourceCode);
  if (expected) return detected.script !== expected;
  // 판정기가 모르는 문자의 원본 언어(러시아어·태국어 등)에서는 한글/가나만 확실한 불일치로 본다.
  return detected.script === 'hangul' || detected.script === 'japanese';
}

function updateSourceMismatchWarning() {
  const el = $('sourceMismatchWarn');
  if (!el) return;
  const detected = detectInputScript($('sourceTitle').value, $('sourceDescription').value);
  if (!state.catalogReady || !sourceMismatch(detected, state.sourceLanguage)) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const target = catalogEntry(detected.code);
  const switchButton = target && !isSourceCode(target.code)
    ? ` <button type="button" class="mini-btn" data-switch-source="${escapeHtml(target.code)}">${escapeHtml(target.label)}로 변경</button>`
    : '';
  el.innerHTML = `<strong>⚠ 원문 언어 확인</strong> 입력한 제목·설명은 <strong>${escapeHtml(detected.name)}</strong>로 보이지만 ` +
    `현재 원본 언어는 <strong>${escapeHtml(languageLabel(state.sourceLanguage))}(${escapeHtml(state.sourceLanguage)})</strong>입니다. ` +
    `원본 언어 설정을 확인해 주세요. 자동으로 바꾸지는 않습니다.${switchButton}`;
  el.classList.remove('hidden');
}

/*
 * TASK CS-v2.6.1 — "예전에 전체 선택이었나"를 판정한다. 화면에 "83개 지원 · 42개
 * 선택"이 뜬 원인: CS-v2.5의 전체 선택(라벨 50개)을 코드로 옮기면 그린란드어(유튜브
 * 미지원)가 빠지고 지역 변형이 합쳐져(독일어 3개→de, 프랑스어 3개→fr …) 42개 코드가
 * 되고, 거기서 원본(ja)을 빼고 짝 언어(ko)를 더해도 42개다. 사용자가 고른 게 아니라
 * 이관 과정이 만든 숫자다.
 *
 * 두 경우를 판정한다(둘 다 LOCAL_SELECTION_VERSION 표식이 없는 저장분만):
 *   1) CS-v2.5 이하(라벨 배열): 예전 라벨 전부가 선택돼 있으면 전체 선택.
 *   2) CS-v2.6.0이 이미 이관해 코드로 저장한 것: 1)의 전체 선택을 이관했을 때 나오는
 *      코드 집합과 정확히 같으면 전체 선택이었던 것으로 본다. 이미 사용자 PC에
 *      42개짜리가 저장돼 있어서 1)만 고치면 그 화면은 영영 안 고쳐진다. 사람이
 *      일부러 정확히 이 42개를 골랐을 가능성은 사실상 없다.
 * 판정 기준표(예전 라벨 목록)는 서버의 legacyLabelCodes 키를 그대로 쓴다 — 클라이언트에
 * 예전 50개 목록을 다시 복제하지 않는다(CLAUDE.md 4.5). 이관은 1회만: 저장할 때
 * 표식을 남기므로 이후 사용자가 언어를 빼도 다시 전체로 되돌아가지 않는다.
 */
const LOCAL_SELECTION_VERSION = 2;

function isLegacyFullSelection(restored, targetCodes, partner) {
  if (Number(restored.version) >= LOCAL_SELECTION_VERSION) return false;
  const legacyLabels = Object.keys(state.legacyLabelCodes).filter(label => label !== '한국어'); // '한국어'는 예전 목록에 없던 라벨
  if (!legacyLabels.length) return false; // 서버의 변환표가 없으면(비상 목록) 판정하지 않는다
  if (!Array.isArray(restored.selectedCodes) && Array.isArray(restored.selectedLabels)) {
    const chosen = new Set(restored.selectedLabels);
    return legacyLabels.every(label => chosen.has(label));
  }
  if (Array.isArray(restored.selectedCodes)) {
    const expected = new Set();
    for (const label of legacyLabels) {
      const canonical = targetCodes.get(normCode(state.legacyLabelCodes[label]));
      if (canonical) expected.add(normCode(canonical));
    }
    if (partner) expected.add(normCode(partner));
    const stored = new Set(restored.selectedCodes.map(normCode));
    return stored.size === expected.size && [...expected].every(code => stored.has(code));
  }
  return false;
}

function applyCatalog(languages, source, legacyLabelCodes) {
  state.catalog = Array.isArray(languages) && languages.length ? [...languages] : [...EMERGENCY_CATALOG];
  state.catalogSource = source;
  state.legacyLabelCodes = legacyLabelCodes || {};
  if (!catalogEntry(state.sourceLanguage)) {
    state.catalog.push({ code: state.sourceLanguage, label: state.sourceLanguage });
  }

  if (!state.catalogReady) {
    const targets = targetCatalog();
    const targetCodes = new Map(targets.map(lang => [normCode(lang.code), lang.code]));
    const restored = state.restoredSelection || {};
    const toCodes = (codes, labels) => {
      if (Array.isArray(codes)) return { list: codes, total: codes.length };
      if (Array.isArray(labels)) return { list: labels.map(label => state.legacyLabelCodes[label]).filter(Boolean), total: labels.length };
      return null;
    };
    const pick = (raw) => {
      const kept = [];
      for (const code of raw.list) {
        const canonical = targetCodes.get(normCode(code));
        if (canonical && !kept.includes(canonical)) kept.push(canonical);
      }
      return kept;
    };
    const selectedRaw = toCodes(restored.selectedCodes, restored.selectedLabels);
    const partner = partnerCode();
    // TASK CS-v2.6.1 — 예전 "전체 선택"은 새 카탈로그에서도 전체 선택이어야 한다.
    const legacyFull = isLegacyFullSelection(restored, targetCodes, partner);
    const selected = (!selectedRaw || legacyFull) ? targets.map(lang => lang.code) : pick(selectedRaw);
    // 예전(라벨) 저장분에는 짝 언어가 원래 있을 수 없었다(한국어가 목록에 없었음).
    // 새 형식(코드) 저장분은 사용자가 일부러 뺐을 수 있으니 건드리지 않는다.
    if (partner && !selected.includes(partner) && !restored.selectedCodes && restored.selectedLabels) selected.push(partner);
    state.selected = new Set(selected);
    const descRaw = toCodes(restored.descCodes, restored.descLabels);
    state.descriptionScope = new Set(descRaw ? pick(descRaw).filter(code => state.selected.has(code)) : []);
    for (const result of state.results) {
      if (!result.languageCode && state.legacyLabelCodes[result.language]) result.languageCode = state.legacyLabelCodes[result.language];
    }
    const dropped = (selectedRaw && !legacyFull) ? selectedRaw.total - pick(selectedRaw).length : 0;
    state.catalogReady = true;
    state.restoredSelection = null;
    if (legacyFull) showToast(`이전 버전의 "전체 선택"을 새 언어 목록 전체(${selected.length}개)로 옮겼습니다.`);
    else if (dropped > 0) showToast(`저장돼 있던 선택 중 ${dropped}개는 지금 언어 목록에 없거나 같은 코드로 합쳐져 선택에서 뺐습니다.`);
  }

  renderSourceControls();
  syncDefaultLanguageSelect({ followSource: true });
  renderLanguages($('languageSearch').value);
  renderResults();
  saveLocal();
}

async function loadLanguageCatalog() {
  try {
    const data = await api('/api/yt/languages');
    applyCatalog(data.languages, data.source === 'youtube' ? 'youtube' : 'fallback', data.legacyLabelCodes);
  } catch {
    applyCatalog(EMERGENCY_CATALOG, 'emergency', {});
  }
}

function renderLanguages(filter = '') {
  const query = filter.trim().toLowerCase();
  const partner = normCode(partnerCode());
  if (!state.catalogReady) {
    $('languageGrid').innerHTML = '<p class="hint">언어 목록을 불러오는 중…</p>';
  } else {
    $('languageGrid').innerHTML = targetCatalog()
      .filter(lang => lang.label.toLowerCase().includes(query) || normCode(lang.code).includes(query))
      .map(lang => `
      <label class="language-item${normCode(lang.code) === partner ? ' partner' : ''}">
        <input type="checkbox" value="${escapeHtml(lang.code)}" ${state.selected.has(lang.code) ? 'checked' : ''} />
        <span class="language-name">${escapeHtml(lang.label)}</span>
        <span class="language-code">${escapeHtml(lang.code)}</span>
      </label>`).join('') || '<p class="hint">검색 결과가 없습니다.</p>';
  }
  $('languageGrid').querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) state.selected.add(input.value);
      else state.selected.delete(input.value);
      updateSelectedCount();
      updateContinueButton();
      pruneDescriptionScope();
      renderDescScopeGrid();
    });
  });
  updateSelectedCount();
  updateContinueButton();
  pruneDescriptionScope();
  renderDescScopeGrid();
}

// TASK CS-v2.6 — "70+" 같은 고정 문구 대신 실제로 불러온 개수를 보여준다.
function updateSelectedCount() {
  $('selectedCount').textContent = state.catalogReady
    ? `${state.catalog.length}개 지원 · ${currentSelectedLanguages().length}개 선택`
    : '불러오는 중…';
}

/*
 * TASK CS-v2.1 작업 C 요구사항 1+2 — 설명까지 번역할 언어를 고르는 영역.
 * state.selected(메인 선택)의 부분집합만 보여준다 — 번역 대상이 아닌
 * 언어를 설명 대상으로 고르는 건 의미가 없다. 핵심 프리셋(CORE_PRESET,
 * CS-v2.6부터 원본 언어에 따라 바뀜)을 재사용한다(요구사항 2).
 */
function renderDescScopeGrid() {
  const selectedList = currentSelectedLanguages();
  const grid = $('descScopeGrid');
  if (!selectedList.length) {
    grid.innerHTML = '<p class="hint">먼저 위에서 번역할 언어를 선택하세요.</p>';
  } else {
    grid.innerHTML = selectedList.map(lang => `
      <label class="language-item">
        <input type="checkbox" value="${escapeHtml(lang.code)}" ${state.descriptionScope.has(lang.code) ? 'checked' : ''} />
        <span class="language-name">${escapeHtml(lang.label)}</span>
        <span class="language-code">${escapeHtml(lang.code)}</span>
      </label>`).join('');
    grid.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', () => {
        if (input.checked) state.descriptionScope.add(input.value);
        else state.descriptionScope.delete(input.value);
        updateDescScopeCount();
        updateCostEstimate();
        saveLocal();
      });
    });
  }
  updateDescScopeCount();
  updateCostEstimate();
}

function updateDescScopeCount() {
  $('descScopeCount').textContent = `${state.descriptionScope.size}개 선택`;
}

/*
 * TASK CS-v2.1 작업 C 요구사항 4 — 선택할 때마다 예상 호출 수를 갱신한다.
 * 캐시 히트는 감안하지 않은 상한 추정치다(추정이라고 명시적으로 표기) —
 * 금액은 절대 표시하지 않는다(단가는 변동되고, 추정값을 코드에 박지
 * 않는다는 geminiConfig.json 원칙과 같은 이유).
 */
function updateCostEstimate() {
  const el = $('costEstimate');
  if (!el) return;
  const selected = currentSelectedLanguages();
  const { full, titleOnly } = splitByDescriptionScope(selected);
  const title = $('sourceTitle').value.trim();
  const description = $('sourceDescription').value;
  const callsFor = (scope, list) => {
    if (!list.length) return 0;
    return Math.ceil(list.length / estimateBatchSize(scope, title, description, list.length));
  };
  const totalCalls = callsFor('title', titleOnly) + callsFor('full', full);
  el.textContent = selected.length
    ? `제목만 ${titleOnly.length}개 + 설명 ${full.length}개 → 예상 호출 ${totalCalls}회 (캐시 히트 제외한 상한 추정치)`
    : '';
}

function setSourceMeta(data) {
  state.sourceMeta = data;
  const meta = $('sourceMeta');
  if (!data) {
    meta.classList.add('hidden');
    return;
  }
  const bits = [
    `추출 방식: ${data.source || '-'}`,
    data.channelTitle ? `채널: ${data.channelTitle}` : '',
    data.videoId ? `비디오 ID: ${data.videoId}` : '',
    data.warning ? `주의: ${data.warning}` : '',
    data.descriptionIncomplete ? '설명이 일부만 확인됐을 수 있습니다.' : ''
  ].filter(Boolean);
  meta.textContent = bits.join(' · ');
  meta.classList.remove('hidden');
}

async function extractVideo() {
  const url = $('youtubeUrl').value.trim();
  if (!url) return setError('mainError', 'YouTube URL을 입력해 주세요.');
  setError('mainError');
  $('extractBtn').disabled = true;
  $('extractBtn').textContent = '추출 중…';
  try {
    const data = await api('/api/yt/extract', { method: 'POST', body: JSON.stringify({ url, model: state.model }) });
    $('sourceTitle').value = data.title || '';
    $('sourceDescription').value = data.description || '';
    setSourceMeta(data);
    updateTitleCount();
    saveLocal();
    updateSourceMismatchWarning(); // TASK CS-v2.6.1
    showToast('제목과 설명을 가져왔습니다.');
  } catch (error) {
    setError('mainError', error.message);
  } finally {
    $('extractBtn').disabled = false;
    $('extractBtn').textContent = '제목·설명 추출';
  }
}

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) result.push(array.slice(i, i + size));
  return result;
}

/*
 * TASK CS-v1.7 — a fixed batch size of 8 always split 50 languages into 7
 * calls, whether the description was 300 characters or 4000. Size the batch
 * to the description instead: budget a per-call output token ceiling
 * (12000, comfortably under the 16384 maxOutputTokens routes/yt.js's
 * /translate sets) and estimate tokens per language as roughly half the
 * character count (title + description translated, ko/ja-heavy text) plus a
 * fixed overhead for the language label and JSON structure. Short
 * descriptions collapse to a single call; only very long ones (~4000+
 * chars) end up needing more than 7.
 */
const TRANSLATE_TOKEN_BUDGET = 12000;

// TASK CS-v2.1 작업 A 요구사항 3 — scope:'title'이면 언어당 출력량을
// description이 아니라 title 길이로 추정한다. routes/yt.js의
// estimateMaxBatchSize()와 반드시 같은 공식을 유지할 것(CLAUDE.md 3.3).
function estimateBatchSize(scope, title, description, totalSelected) {
  const baseLength = Array.from((scope === 'title' ? title : description) || '').length;
  const perLanguageTokens = (baseLength + 100) / 2;
  const size = Math.floor(TRANSLATE_TOKEN_BUDGET / perLanguageTokens);
  return Math.max(1, Math.min(totalSelected, size));
}

/*
 * TASK CS-v2.1 후속 버그 [2] — 결과가 있다는 것과 "그 언어에 필요한 만큼
 * 다 됐다"는 것은 다르다. 설명 대상(state.descriptionScope)으로 고른
 * 언어인데 결과가 scope:'title'로만 있으면(설명 번역 전) 아직 안 끝난
 * 것으로 봐야 한다 — 안 그러면 "이어서 번역"이 그 언어를 영원히
 * 건너뛴다. upsertResults()가 이미 결과마다 실제 적용된 scope를 저장해
 * 두므로 그걸 그대로 쓴다.
 */
// TASK CS-v2.6 — lang은 카탈로그 항목({code, label}). 결과와는 코드로 맞춘다.
function hasResultFor(lang) {
  const result = state.results.find(r => normCode(resultCode(r)) === normCode(lang.code));
  if (!result) return false;
  if (state.descriptionScope.has(lang.code) && result.scope !== 'full') return false;
  return true;
}

/*
 * TASK CS-v1.8 — "이어서 번역" and "언어를 아직 시도 안 함" are the same
 * question asked two ways: anything selected that isn't already sitting in
 * state.results, whether it was never attempted or got dropped by a
 * truncated batch (server's `missingLanguages`). Either way it never made
 * it into state.results, so one filter answers both — no separate tracking
 * of "missing" vs "untried" needed on the client.
 */
function pendingLanguages(selectedList) {
  return selectedList.filter(lang => !hasResultFor(lang));
}

// TASK CS-v2.1 작업 C — 실제 적용된 scope를 결과에 함께 저장한다(요구사항 4의
// 화면 반영). scope는 배치(호출) 단위 응답값이라 그 배치의 모든 결과에 같이 붙인다.
function upsertResults(newResults, scope) {
  for (const result of newResults) {
    const code = resultCode(result);
    const withScope = { ...result, languageCode: code, ...(scope ? { scope } : {}) };
    const index = state.results.findIndex(r => normCode(resultCode(r)) === normCode(code));
    if (index >= 0) state.results[index] = withScope;
    else state.results.push(withScope);
    state.languageFailCounts.delete(code); // TASK CS-v2.1 후속 버그 [1] — 성공하면 연속 실패 카운트 초기화
  }
}

// TASK 후속 — missingLanguages(성공 응답의 일부 누락이든, 429 실패 응답의
// 미처리 언어든)에 나온 언어의 연속 실패 횟수와 "가장 최근 실패 이유"를
// 기록한다. reason은 화면에 그대로 노출되는 짧은 한국어 문구다.
// TASK CS-v2.6 — languages는 언어 코드 배열이다(연속 실패 횟수도 코드로 센다).
function recordMissing(languages, reason) {
  for (const lang of languages || []) {
    const prev = state.languageFailCounts.get(lang);
    state.languageFailCounts.set(lang, { count: (prev?.count || 0) + 1, reason: reason || prev?.reason || '알 수 없음' });
  }
}

// TASK 후속 — 429 실패 응답(quotaExhausted)의 원인을 화면에 붙일 짧은
// 한국어 문구로 요약한다. quotaScopeNote()(quotaChoice 박스용, 더 긴
// 안내문)와 다른 용도 — 이건 언어 하나 옆에 붙는 짧은 라벨이다.
function quotaFailReason(error) {
  if (error.dailyLimitReached) return '유료 상한 도달';
  if (error.quotaScope === 'daily') return '하루 한도 초과';
  if (error.quotaScope === 'per-minute') return '분당 한도 초과';
  return '한도 초과';
}

/*
 * TASK CS-v2.1 작업 C — 설명 대상 언어는 state.selected의 부분집합으로만
 * 의미가 있다. 메인 선택이 줄어들면(체크 해제) 같이 정리해, 이미 선택
 * 해제한 언어가 설명 대상에는 남아 예상 표시가 어긋나는 일을 막는다.
 */
function pruneDescriptionScope() {
  for (const lang of [...state.descriptionScope]) {
    if (!state.selected.has(lang) || isSourceCode(lang)) state.descriptionScope.delete(lang);
  }
}

function splitByDescriptionScope(languages) {
  const full = languages.filter(lang => state.descriptionScope.has(lang.code));
  const titleOnly = languages.filter(lang => !state.descriptionScope.has(lang.code));
  return { full, titleOnly };
}

// TASK CS-v2.6 — 선택된 대상 언어를 화면 순서대로, {code, label} 항목으로 돌려준다.
// 원본 언어는 targetCatalog()에서 이미 빠져 있어 여기 섞일 수 없다.
function currentSelectedLanguages() {
  if (!state.catalogReady) return [];
  return targetCatalog().filter(lang => state.selected.has(lang.code));
}

function updateContinueButton() {
  const btn = $('continueTranslateBtn');
  const pending = pendingLanguages(currentSelectedLanguages());
  if (!state.results.length || !pending.length) {
    btn.classList.add('hidden');
    renderPendingLanguages();
    return;
  }
  btn.classList.remove('hidden');
  btn.disabled = state.translating;
  btn.textContent = `이어서 번역 (${pending.length}개 남음)`;
  renderPendingLanguages();
}

/*
 * TASK CS-v2.1 후속 버그 [1] — 개수만이 아니라 실제 언어 이름을 보여준다.
 * 접었다 펼 수 있게 하고(요구사항), 반복 실패한 언어는 몇 번 실패했는지도
 * 같이 표시한다. updateContinueButton()이 부르는 것과 별개로
 * runOneScopeGroup()이 배치마다 직접 불러 진행 중에도 갱신되게 한다.
 */
function renderPendingLanguages() {
  const box = $('pendingLanguagesBox');
  const pending = pendingLanguages(currentSelectedLanguages());
  if (!state.results.length || !pending.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const listEl = $('pendingLanguagesList');
  const expanded = !listEl.classList.contains('hidden');
  $('pendingToggleBtn').textContent = `${expanded ? '남은 언어 접기' : '남은 언어 보기'} (${pending.length}개)`;
  listEl.innerHTML = pending.map(lang => {
    const fail = state.languageFailCounts.get(lang.code);
    // TASK 후속 — "3회 연속 실패"만으로는 기다릴지 포기할지 판단이 안 된다는
    // 지적대로, 원인까지 한 줄에 붙인다: "3회 연속 실패 (한도 초과)".
    const failNote = fail ? ` <span class="fail-note">(${fail.count}회 연속 실패 (${escapeHtml(fail.reason)}))</span>` : '';
    return `<div>${escapeHtml(lang.label)} <span class="language-code">${escapeHtml(lang.code)}</span>${failNote}</div>`;
  }).join('');
}

/**
 * TASK CS-v2.1 작업 C 요구사항 3 — 처리할 언어를 설명 대상(scope:'full')과
 * 나머지(scope:'title')로 나눠 별도 요청으로 보낸다. 두 그룹은 각자 자기
 * scope에 맞는 묶음 크기로 나뉜다(estimateBatchSize). state.translating과
 * 버튼 상태는 이 함수가 그룹 전체에 걸쳐 한 번만 관리한다 — 그룹 사이에
 * 버튼이 깜빡이며 잠깐 풀리는 걸 막기 위해.
 */
// TASK CS-v2.1 후속 버그 [1] — "N개 완료, M개 남음: (언어명 나열)"을 한
// 줄로 만든다. overallLanguages는 이번 실행 전체의 대상(그룹 하나가
// 아니라)이라 "완료/남음"이 그룹이 바뀌어도 계속 같은 기준으로 보인다.
function describeProgress(overallLanguages) {
  const stillPending = pendingLanguages(overallLanguages);
  const doneCount = overallLanguages.length - stillPending.length;
  if (!stillPending.length) return `${doneCount}개 완료 — 전부 끝났습니다`;
  const preview = stillPending.slice(0, 8).map(lang => lang.label).join(', ') + (stillPending.length > 8 ? ` 외 ${stillPending.length - 8}개` : '');
  return `${doneCount}개 완료, ${stillPending.length}개 남음: ${preview}`;
}

async function runOneScopeGroup(overallLanguages, languages, scope, { forcePaid }) {
  const title = $('sourceTitle').value.trim();
  const description = $('sourceDescription').value;
  const scopeLabel = scope === 'full' ? '제목+설명' : '제목만';
  const batchSize = estimateBatchSize(scope, title, description, languages.length);
  const batches = chunk(languages, batchSize);
  let cacheHitCount = 0;
  const missing = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const data = await api('/api/yt/translate', {
      method: 'POST',
      body: JSON.stringify({
        title,
        description,
        // TASK CS-v2.6 — 라벨만이 아니라 코드도 보낸다. 서버는 코드로 캐시·중복·원본 충돌을 판단한다.
        languages: batch.map(({ code, label }) => ({ code, label })),
        sourceLanguageCode: state.sourceLanguage,
        sourceLanguageLabel: languageLabel(state.sourceLanguage),
        scope,
        model: state.model,
        ...(forcePaid ? { forcePaid: true } : {}),
      }),
    });
    cacheHitCount += data.fromCache?.length || 0;
    if (data.missingLanguages?.length) {
      // TASK CS-v2.6 — missingLanguageCodes는 missingLanguages(라벨)와 같은 순서다.
      const missingCodes = data.missingLanguages.map((label, i) => data.missingLanguageCodes?.[i] || state.legacyLabelCodes[label] || label);
      missing.push(...missingCodes);
      // TASK 후속(재조사) — 100자 초과로 빠진 언어는 실제 길이까지 보여준다
      // ("스웨덴어 139자 → 100자 초과로 제외") — 이게 오늘 실패의 실제
      // 원인이었는데 지금까지는 '응답에서 누락'으로만 뭉뚱그려져 원인
      // 파악이 안 됐다. 나머지(오버사이즈가 아닌 것)만 기존처럼 잘림/누락으로 구분.
      const oversizedByLang = new Map((data.oversizedTitles || []).map((o) => [o.languageCode || o.language, o.length]));
      for (const lang of missingCodes) {
        const reason = oversizedByLang.has(lang)
          ? `${oversizedByLang.get(lang)}자 → 100자 초과로 제외`
          : (data.truncated ? '응답 잘림' : '응답에서 누락');
        recordMissing([lang], reason);
      }
    }
    upsertResults(data.results, data.scope || scope);
    renderResults();
    saveLocal();
    // TASK CS-v2.1 후속 버그 [1] 요구사항 — 번역이 끝날 때마다(묶음 하나가
    // 끝날 때마다) 완료/남음을 알린다. [${scopeLabel}] 접두는 지금 어느
    // 그룹(제목만/제목+설명)을 처리 중인지 구분하기 위해 유지한다.
    $('progressText').textContent = `[${scopeLabel} · 묶음 ${i + 1}/${batches.length}] ${describeProgress(overallLanguages)}`;
    renderPendingLanguages();
    // TASK CS-v1.7 — no client-side sleep here anymore; lib/gemini.js's
    // process-wide queue paces every call (including these), and pacing
    // it from two places would just have them fight each other.
  }
  return { cacheHitCount, missing };
}

/** Shared by both the "번역" and "이어서 번역" buttons — only which languages get sent, and whether prior results are wiped first, differs. */
async function runScopedTranslate(languagesToProcess, { resetResults, forcePaid = false }) {
  if (state.translating || !state.geminiConfigured) return;
  hideTranslateConfirm();
  hideQuotaChoice();
  const title = $('sourceTitle').value.trim();
  if (!title) return setError('translateError', '원문 제목을 입력해 주세요.');
  if (!languagesToProcess.length) return setError('translateError', '번역할 언어가 없습니다.');
  setError('translateError');
  state.translating = true;
  state.resultsSourceKey = currentSourceKey();
  if (resetResults) {
    state.results = [];
    $('resultsList').innerHTML = '';
    $('resultsPanel').classList.add('hidden');
  }
  $('translateBtn').disabled = true;
  $('continueTranslateBtn').disabled = true;
  $('translateBtn').textContent = '번역 중…';
  $('progressWrap').classList.remove('hidden');
  $('progressBar').style.width = '0%';

  // TASK 후속 — 설명(full)을 title보다 먼저 돌린다. 한도가 부족할 때
  // "아직 하나도 없는 쪽"이 먼저 확보돼야 한다: title은 이미 유튜브에
  // 등록까지 끝난 언어가 많아 다시 안 해도 되는 경우가 흔하고, full은
  // 보통 개수가 더 적어(설명 대상만 골라 쓰는 게 이 기능의 취지) 먼저
  // 끝내기도 유리하다. title이 캐시에 남아있으면 재실행해도 대부분
  // 캐시 히트라 실제 호출은 거의 안 나간다(getCachedTranslations가
  // scope까지 키에 포함하므로 — lib/ytTranslationCache.js CS-v2.1 작업 B).
  const { full, titleOnly } = splitByDescriptionScope(languagesToProcess);
  const groups = [];
  if (full.length) groups.push({ scope: 'full', languages: full });
  if (titleOnly.length) groups.push({ scope: 'title', languages: titleOnly });

  let cacheHitTotal = 0;
  let missingTotal = [];
  let quotaError = null;
  let currentGroupIndex = -1; // TASK 후속 — 429가 어느 그룹에서 났고, 그 뒤로 뭐가 아예 시작도 안 됐는지 알려면 필요
  try {
    for (let g = 0; g < groups.length; g++) {
      currentGroupIndex = g;
      const { cacheHitCount, missing } = await runOneScopeGroup(languagesToProcess, groups[g].languages, groups[g].scope, { forcePaid });
      cacheHitTotal += cacheHitCount;
      missingTotal.push(...missing);
      $('progressBar').style.width = `${Math.round(((g + 1) / groups.length) * 100)}%`;
    }
    const cacheNote = cacheHitTotal ? ` (캐시에서 ${cacheHitTotal}개 불러옴)` : '';
    $('progressText').textContent = `${languagesToProcess.length}개 언어 처리 완료${cacheNote}`;
    showToast(missingTotal.length
      ? `번역 완료. ${missingTotal.length}개 언어는 출력이 잘려 받지 못했습니다 — "이어서 번역"으로 다시 시도하세요.`
      : `번역이 완료되었습니다.${cacheNote}`);
  } catch (error) {
    // TASK CS-v2.0 작업 A 요구사항 2 — 429로 멈춘 것과 그 외 오류(네트워크
    // 끊김, 서버 오류 등)는 다르게 다룬다: 무료 한도 소진은 "재시도 선택지"를
    // 보여줄 수 있는 상황이지 그냥 실패가 아니다. error.results는 이번에
    // 실패한 배치 안에서도 캐시로 이미 맞춘 언어들이므로 먼저 반영한다 —
    // 그렇지 않으면 이 배치의 캐시 히트가 화면에서 사라진다.
    if (error.quotaExhausted) {
      quotaError = error;
      upsertResults(error.results || [], error.scope);
      recordMissing((error.missingLanguages || []).map((label, i) => error.missingLanguageCodes?.[i] || state.legacyLabelCodes[label] || label), quotaFailReason(error)); // TASK 후속 — 429로 못 받은 언어도 이유와 함께 집계
      renderResults();
      renderPendingLanguages();
      saveLocal();
      setError('translateError');
      // TASK CS-v2.1 — 두 그룹 중 하나가 429로 막히면 나머지 그룹(예: 아직
      // 시도 안 한 설명-대상 그룹)도 이어서 부르지 않는다 — 남은 전체를
      // pendingLanguages로 다시 계산해 선택지에 보여준다.
      // TASK 후속 — currentGroupIndex 다음 그룹들은 fetch 자체가 한 번도
      // 안 나갔다("실패"가 아니라 "시작 못 함") — showQuotaChoice에 같이
      // 넘겨서 화면에서 구분해 보여준다.
      const skippedGroups = groups.slice(currentGroupIndex + 1);
      showQuotaChoice(pendingLanguages(languagesToProcess), quotaError, skippedGroups);
    } else if (handleModelNotFoundError(error)) {
      // TASK CS-v2.2 작업 B 요구사항 3 — 목록은 이미 handleModelNotFoundError가
      // 갱신해 보여줬다. 조용히 다른 모델로 바꿔 재시도하지 않는다 —
      // 사용자가 상단에서 직접 다른 모델을 고른 뒤 다시 눌러야 한다.
      const remaining = pendingLanguages(languagesToProcess).length;
      setError('translateError', `${languagesToProcess.length - remaining}개 언어까지 저장되었습니다. ${error.message}`);
    } else {
      const remaining = pendingLanguages(languagesToProcess).length;
      setError('translateError', `${languagesToProcess.length - remaining}개 언어까지 저장되었습니다. 처리 중 오류가 발생했습니다: ${error.message}`);
    }
  } finally {
    state.translating = false;
    $('translateBtn').disabled = !state.geminiConfigured;
    $('translateBtn').textContent = '선택 언어 번역 시작';
    updateContinueButton();
  }
}

/*
 * TASK CS-v1.8 — an inline confirm box instead of window.confirm(): this
 * page runs inside the shell's iframe, and a native blocking dialog there
 * freezes input to the whole tab (not just this iframe) until dismissed,
 * with no visual cue elsewhere in the shell that anything is waiting. A
 * dark-themed alert box matching translateGate/mainError's existing style
 * doesn't have that problem and looks like it belongs on this page.
 */
// TASK CS-v1.8 follow-up — "비용이 발생합니다" only makes sense when a paid
// key is actually configured (translate/regenerate run on the free key
// otherwise — see lib/gemini.js's effectiveTier()); showing a cost warning
// on a free call just confused users who hadn't set one up.
function costPhrase() {
  return state.paidKeyConfigured ? '비용이 발생합니다' : '무료 한도를 사용합니다';
}
function costActionLabel() {
  return state.paidKeyConfigured ? '비용 발생' : '무료 한도 사용';
}

function showTranslateConfirm(count, selected) {
  $('translateConfirmText').textContent = `${count}개 언어를 다시 번역합니다. ${costPhrase()}. 계속할까요?`;
  $('translateConfirmYesBtn').textContent = `계속 진행 (${costActionLabel()})`;
  $('translateConfirm').dataset.pendingSelected = JSON.stringify(selected);
  $('translateConfirm').classList.remove('hidden');
}

function hideTranslateConfirm() {
  $('translateConfirm').classList.add('hidden');
}

/*
 * TASK CS-v2.0 작업 A 요구사항 2 — 무료 한도 초과로 멈췄을 때 뜨는 선택지.
 * 유료 키 유무에 따라 문구와 버튼이 달라진다. 유료 키가 없으면 "유료로
 * 이어서" 버튼 자체를 숨긴다 — 눌러도 무료 키로 폴백되어 또 429가 날
 * 뿐이므로, 누를 수 있게 보여주는 것 자체가 오해를 만든다(지시서 요구사항
 * 2의 명시적 요구).
 */
function quotaScopeNote(error) {
  // TASK CS-v2.0 — dailyLimitReached는 우리 앱 자체의 .gemini_limits.json
  // 상한(유료 키가 있어도 걸림)이라 quotaScope(구글 쪽 RPM/RPD 추정)와
  // 별개로 먼저 확인한다 — 이 경우 "유료로 이어서"를 눌러도 똑같이 즉시
  // 막히므로 다른 안내가 필요하다.
  if (error.dailyLimitReached) {
    return ' 이 도구에 설정된 유료 일일 상한(.gemini_limits.json)에 도달했습니다 — 내일 다시 시도하거나 상한 값을 늘려주세요.';
  }
  if (error.quotaScope === 'daily') return ' 하루 요청 한도로 보입니다.';
  if (error.quotaScope === 'per-minute') return ' 분당 요청 한도로 보입니다 — 1~2분 후 다시 시도하면 무료로 계속할 수 있습니다.';
  return ' 분당 한도인지 하루 한도인지 이번 응답만으로는 확인되지 않았습니다 — 1~2분 후 다시 시도해 보고, 계속 실패하면 하루 한도일 가능성이 큽니다.';
}

function scopeGroupLabel(scope) {
  return scope === 'full' ? '설명 번역' : '제목 번역';
}

// TASK 후속 — skippedGroups는 이번 실행에서 fetch 자체가 한 번도 안 나간
// 그룹들이다(429가 난 그룹 다음에 있던 것들). "실패"와 "시작도 못 함"은
// 사용자 입장에서 판단이 다르므로("다시 시도하면 될까?" vs "애초에 시도가
// 안 됐구나") 구분해서 명시한다.
function showQuotaChoice(pendingList, error, skippedGroups = []) {
  const box = $('quotaChoice');
  const n = pendingList.length;
  const note = quotaScopeNote(error);
  const offerPaidRetry = state.paidKeyConfigured && !error.dailyLimitReached;

  $('quotaChoicePaidBtn').classList.toggle('hidden', !offerPaidRetry);
  $('quotaChoiceSetupBtn').classList.toggle('hidden', state.paidKeyConfigured || error.dailyLimitReached);

  let text = offerPaidRetry
    ? `무료 한도를 모두 썼습니다.${note} 남은 ${n}개 언어를 유료 키로 이어서 번역할까요? 비용이 발생합니다.`
    : state.paidKeyConfigured
      ? `무료·유료 모두 오늘 한도에 도달했습니다.${note} 남은 언어는 ${n}개입니다.`
      : `무료 한도를 모두 썼습니다.${note} 남은 ${n}개 언어는 내일 다시 시도하거나, 유료 키를 설정하면 지금 바로 이어서 할 수 있습니다.`;

  if (skippedGroups.length) {
    const names = skippedGroups.map((g) => `${scopeGroupLabel(g.scope)}(${g.languages.length}개)`).join(', ');
    text += ` ${names}은(는) 한도 때문에 시작하지 못했습니다.`;
  }

  $('quotaChoiceText').textContent = text;

  box.dataset.pendingLanguages = JSON.stringify(pendingList);
  box.classList.remove('hidden');
}

function hideQuotaChoice() {
  $('quotaChoice').classList.add('hidden');
}

async function onTranslateClick() {
  const selected = currentSelectedLanguages();
  if (!selected.length) return setError('translateError', '번역 언어를 하나 이상 선택해 주세요.');
  // TASK CS-v1.8 — re-running the full selection can still hit cache under
  // the hood (unchanged title/description), but we can't promise that up
  // front, so warn every time there's overlap with existing results rather
  // than silently re-spend on whichever ones did change.
  const alreadyDone = selected.filter(hasResultFor);
  if (alreadyDone.length > 0) {
    showTranslateConfirm(alreadyDone.length, selected);
    return;
  }
  await runScopedTranslate(selected, { resetResults: true });
}

async function onContinueTranslateClick() {
  const pending = pendingLanguages(currentSelectedLanguages());
  if (!pending.length) { showToast('이어서 번역할 언어가 없습니다.'); return; }
  await runScopedTranslate(pending, { resetResults: false });
}

const REGEN_BUTTON_LABELS = { 'regen-title': '제목 재생성', 'regen-description': '설명 재생성' };

function renderResults() {
  if (!state.results.length) {
    $('resultsPanel').classList.add('hidden');
    updateContinueButton();
    return;
  }
  $('resultsPanel').classList.remove('hidden');
  $('resultsList').innerHTML = state.results.map((result, index) => {
    const titleCount = Array.from(result.translatedTitle || '').length;
    return `
      <article class="result-card" data-index="${index}">
        <div class="result-title-row">
          <div style="display:flex;align-items:center;gap:10px">
            <h3>${escapeHtml(result.language)} <span class="language-code">${escapeHtml(resultCode(result))}</span></h3>
            <span class="pill" title="이 언어에 실제로 적용된 번역 범위">${result.scope === 'full' ? '제목+설명' : '제목만'}</span>
          </div>
          <div class="result-actions">
            <button class="mini-btn" data-action="copy-title">제목 복사</button>
            <button class="mini-btn" data-action="regen-title">제목 재생성</button>
            <button class="mini-btn" data-action="copy-description">설명 복사</button>
            <button class="mini-btn" data-action="regen-description">설명 재생성</button>
          </div>
        </div>
        <div class="result-grid">
          <div>
            <div class="result-label-row"><span class="result-label">번역 제목</span><span class="counter ${titleCount > 100 ? 'over' : ''}">${titleCount} / 100</span></div>
            <textarea data-field="translatedTitle" rows="2">${escapeHtml(result.translatedTitle)}</textarea>
          </div>
          <div>
            <div class="result-label-row"><span class="result-label">번역 설명</span></div>
            <textarea data-field="translatedDescription" rows="9">${escapeHtml(result.translatedDescription)}</textarea>
          </div>
        </div>
      </article>`;
  }).join('');

  $('resultsList').querySelectorAll('.result-card').forEach(card => {
    const index = Number(card.dataset.index);
    card.querySelectorAll('textarea').forEach(textarea => {
      textarea.addEventListener('input', () => {
        state.results[index][textarea.dataset.field] = textarea.value;
        if (textarea.dataset.field === 'translatedTitle') {
          const counter = textarea.closest('div').querySelector('.counter');
          const n = Array.from(textarea.value).length;
          counter.textContent = `${n} / 100`;
          counter.classList.toggle('over', n > 100);
        }
        saveLocal();
      });
    });
    card.querySelectorAll('[data-action]').forEach(button => {
      button.addEventListener('click', async () => {
        const action = button.dataset.action;
        const result = state.results[index];
        if (action === 'copy-title') return copyText(result.translatedTitle);
        if (action === 'copy-description') return copyText(result.translatedDescription);
        const field = action === 'regen-description' ? 'description' : 'title';
        const label = REGEN_BUTTON_LABELS[action];

        /*
         * TASK CS-v1.8 task D — regenerate is a real paid call every click.
         * If this exact language+field was already regenerated for the
         * CURRENT title/description text (unchanged since), require an
         * extra click before spending another one — a plain click that
         * only requests a new random phrasing of the same thing is the
         * abuse case this guards against. A lightweight arm-then-confirm
         * on the button itself, not window.confirm() (see onTranslateClick
         * above — a native dialog in this iframe'd page is worse than a
         * button that just needs a second click), and not a full alert box
         * per card, since there can be up to 50 of these on screen at once.
         */
        const sourceKey = currentSourceKey();
        result._regenSourceKey = result._regenSourceKey || {};
        const alreadyRegeneratedForThisText = result._regenSourceKey[field] === sourceKey;
        if (alreadyRegeneratedForThisText && button.dataset.confirmArmed !== '1') {
          button.dataset.confirmArmed = '1';
          button.textContent = `다시 누르면 재생성 (${costActionLabel()})`;
          clearTimeout(button._confirmTimer);
          button._confirmTimer = setTimeout(() => {
            delete button.dataset.confirmArmed;
            button.textContent = label;
          }, 4000);
          return;
        }
        delete button.dataset.confirmArmed;
        clearTimeout(button._confirmTimer);

        button.disabled = true;
        button.textContent = '처리 중…';
        try {
          const data = await api('/api/yt/regenerate', {
            method: 'POST',
            body: JSON.stringify({
              title: $('sourceTitle').value,
              description: $('sourceDescription').value,
              language: result.language,
              languageCode: resultCode(result), // TASK CS-v2.6
              sourceLanguageCode: state.sourceLanguage,
              sourceLanguageLabel: languageLabel(state.sourceLanguage),
              field,
              model: state.model,
            })
          });
          if (field === 'title') result.translatedTitle = data.text;
          else result.translatedDescription = data.text;
          result._regenSourceKey[field] = sourceKey;
          renderResults();
          saveLocal();
          showToast('재생성했습니다.');
        } catch (error) {
          handleModelNotFoundError(error);
          setError('translateError', error.message);
        } finally {
          button.disabled = false;
          button.textContent = label;
        }
      });
    });
  });
  updateContinueButton();
}

async function copyText(text) {
  await navigator.clipboard.writeText(String(text || ''));
  showToast('클립보드에 복사했습니다.');
}

function csvEscape(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  // TASK CS-v2.6 — 코드 열은 맨 뒤에 붙인다(기존 열 순서를 쓰던 사람이 깨지지 않게).
  const rows = [['언어', '번역 제목', '번역 설명', '언어 코드'], ...state.results.map(x => [x.language, x.translatedTitle, x.translatedDescription, resultCode(x)])];
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  download('﻿' + csv, 'youtube_translations.csv', 'text/csv;charset=utf-8');
}

function exportJson() {
  const payload = {
    source: { title: $('sourceTitle').value, description: $('sourceDescription').value, sourceLanguage: state.sourceLanguage, meta: state.sourceMeta },
    // _regenSourceKey is internal regenerate-confirm bookkeeping (CS-v1.8 task D) — not part of the exported data.
    translations: state.results.map((result) => ({
      language: result.language,
      languageCode: resultCode(result),
      translatedTitle: result.translatedTitle,
      translatedDescription: result.translatedDescription,
      scope: result.scope,
    })),
  };
  download(JSON.stringify(payload, null, 2), 'youtube_translations.json', 'application/json;charset=utf-8');
}

function copyAll() {
  const text = state.results.map(x => `[${x.language}]\n제목: ${x.translatedTitle}\n\n${x.translatedDescription}`).join('\n\n====================\n\n');
  copyText(text);
}

const LOCAL_STATE_KEY = 'youtubeTranslatorLocalState';

function saveLocal() {
  const payload = {
    url: $('youtubeUrl')?.value || '',
    title: $('sourceTitle')?.value || '',
    description: $('sourceDescription')?.value || '',
    // TASK CS-v2.6 — 선택은 코드로 저장한다(selectedCodes). 예전 키(selected,
    // descriptionScope — 라벨 배열)는 쓰지 않는다: 같은 키에 코드를 넣으면 예전
    // 형식인지 새 형식인지 구분할 수 없게 된다.
    sourceLanguage: state.sourceLanguage,
    selectedCodes: Array.from(state.selected),
    descriptionScopeCodes: Array.from(state.descriptionScope),
    // TASK CS-v2.6.1 — 이관을 마쳤다는 표식. isLegacyFullSelection()은 이게 있으면 판정하지 않는다.
    languageSelectionVersion: LOCAL_SELECTION_VERSION,
    results: state.results,
    resultsSourceKey: state.resultsSourceKey,
    sourceMeta: state.sourceMeta,
    model: state.model, // TASK CS-v2.2 작업 C 요구사항 2 — 다음 실행에도 유지
  };
  // 카탈로그가 도착하기 전에는 state.selected가 아직 비어 있다. 그때 저장하면
  // (입력 중이거나 창을 닫는 순간) 저장돼 있던 선택이 빈 배열로 덮어써진다 —
  // 그 몇 초 동안은 선택 필드를 저장돼 있던 그대로 둔다.
  // TASK CS-v2.6.1 — 비상 목록(서버 언어 목록을 못 받음, 10개 남짓)일 때도 같다. 그
  // 상태의 선택을 저장하면 원래 선택이 10개 이하로 덮이고, 이관 표식까지 남아서 서버가
  // 돌아와도 전체 선택 이관이 다시는 안 일어난다.
  if (!state.catalogReady || state.catalogSource === 'emergency') {
    try {
      const previous = JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) || 'null') || {};
      for (const key of ['selected', 'descriptionScope', 'selectedCodes', 'descriptionScopeCodes', 'languageSelectionVersion']) {
        if (key in previous) payload[key] = previous[key];
        else delete payload[key];
      }
    } catch { /* corrupted — nothing worth preserving */ }
  }
  try { localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(payload)); } catch { /* storage full/blocked — state stays in memory */ }
}

function restoreLocal() {
  try {
    const payload = JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) || 'null');
    if (!payload) return;
    $('youtubeUrl').value = payload.url || '';
    $('sourceTitle').value = payload.title || '';
    $('sourceDescription').value = payload.description || '';
    if (Array.isArray(payload.results)) state.results = payload.results;
    // TASK CS-v2.6 — 원본 언어가 저장돼 있지 않은 건 CS-v2.5 이전 저장분이다. 그때의
    // 번역은 전부 "한국어 원본" 프롬프트로 만들어졌으므로, 결과가 남아 있으면 원본을
    // ko로 복원해 그 결과가 계속 유효하게 둔다(기본값 ja로 두면 결과는 남아 있는데
    // 원본 언어 표시는 일본어인 어긋난 상태가 된다). 결과가 없으면 새 기본값 ja.
    const legacyPayload = !payload.sourceLanguage;
    state.sourceLanguage = payload.sourceLanguage || (state.results.length ? 'ko' : 'ja');
    state.restoredSelection = {
      version: payload.languageSelectionVersion, // TASK CS-v2.6.1 — 없으면 이관 전(CS-v2.6.0 이하) 저장분
      selectedCodes: payload.selectedCodes,
      selectedLabels: payload.selected,
      descCodes: payload.descriptionScopeCodes,
      descLabels: payload.descriptionScope,
    };
    // TASK CS-v1.8 — payload.resultsSourceKey is missing on state saved
    // before this field existed; title/description were saved in the same
    // snapshot as results, so currentSourceKey() (now that both are set
    // above) is the correct value for that older data too.
    // TASK CS-v2.6 — 예전 키에는 원본 언어 칸이 없다. 앞에 붙여 새 형식으로 맞춘다.
    const storedKey = legacyPayload && typeof payload.resultsSourceKey === 'string'
      ? `${state.sourceLanguage}\u0000${payload.resultsSourceKey}`
      : payload.resultsSourceKey;
    state.resultsSourceKey = storedKey ?? (state.results.length ? currentSourceKey() : null);
    state.sourceMeta = payload.sourceMeta || null;
    if (payload.model) state.model = payload.model; // TASK CS-v2.2 — 없으면 loadStatus()가 서버 기본값으로 채운다
    setSourceMeta(state.sourceMeta);
    updateTitleCount();
    renderResults();
  } catch { /* ignore corrupted local storage */ }
}

function setupEvents() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === tab));
      const target = tab.dataset.tab;
      $('urlTab').classList.toggle('active', target === 'url');
      $('manualTab').classList.toggle('active', target === 'manual');
    });
  });
  $('extractBtn').addEventListener('click', extractVideo);
  $('youtubeUrl').addEventListener('keydown', event => { if (event.key === 'Enter') extractVideo(); });
  $('sourceTitle').addEventListener('input', () => { invalidateResultsIfSourceChanged(); updateTitleCount(); updateCostEstimate(); updateSourceMismatchWarning(); saveLocal(); });
  $('sourceDescription').addEventListener('input', () => { invalidateResultsIfSourceChanged(); updateCostEstimate(); updateSourceMismatchWarning(); saveLocal(); });
  // TASK CS-v2.6.1 — 경고 안의 [○○로 변경]은 누를 때만 원본 언어를 바꾼다. 경고는 다시
  // 그려지므로 컨테이너에 위임한다. setSourceLanguage()를 그대로 써서 결과 초기화·
  // 등록 계획 무효화·원문 언어 동기화가 드롭다운으로 바꿀 때와 똑같이 일어난다.
  $('sourceMismatchWarn').addEventListener('click', event => {
    const button = event.target.closest('[data-switch-source]');
    if (button) setSourceLanguage(button.dataset.switchSource);
  });
  document.querySelectorAll('[data-copy-target]').forEach(button => {
    button.addEventListener('click', () => copyText($(button.dataset.copyTarget).value));
  });
  // TASK CS-v2.6 — 전체 선택은 "원본을 뺀 카탈로그 전체"다.
  $('selectAllBtn').addEventListener('click', () => { state.selected = new Set(targetCatalog().map(lang => lang.code)); renderLanguages($('languageSearch').value); saveLocal(); });
  $('clearAllBtn').addEventListener('click', () => { state.selected.clear(); renderLanguages($('languageSearch').value); saveLocal(); });
  $('corePresetBtn').addEventListener('click', () => { state.selected = new Set(resolvePreset(CORE_PRESET, CORE_PRESET_SIZE)); renderLanguages($('languageSearch').value); saveLocal(); });
  $('asiaPresetBtn').addEventListener('click', () => { state.selected = new Set(resolvePreset(ASIA_PRESET)); renderLanguages($('languageSearch').value); saveLocal(); });
  $('globalPresetBtn').addEventListener('click', () => { state.selected = new Set(resolvePreset(GLOBAL_PRESET)); renderLanguages($('languageSearch').value); saveLocal(); });
  $('languageSearch').addEventListener('input', event => renderLanguages(event.target.value));
  $('sourceLanguageSelect').addEventListener('change', event => setSourceLanguage(event.target.value));
  document.querySelectorAll('[data-source-preset]').forEach(button => {
    button.addEventListener('click', () => setSourceLanguage(button.dataset.sourcePreset));
  });
  // TASK CS-v2.1 작업 C 요구사항 2 — 핵심 프리셋을 설명 대상 프리셋으로도
  // 재사용. state.selected와의 교집합만 적용한다(번역 대상이 아닌 언어를
  // 설명 대상으로 넣는 건 의미가 없다). TASK CS-v2.6 — 원본 언어에 따라 바뀌는
  // 같은 프리셋(일본채널/한국채널 핵심 10개)을 쓴다.
  $('descCorePresetBtn').addEventListener('click', () => {
    state.descriptionScope = new Set(resolvePreset(CORE_PRESET, CORE_PRESET_SIZE).filter(code => state.selected.has(code)));
    renderDescScopeGrid();
    saveLocal();
  });
  $('descClearBtn').addEventListener('click', () => {
    state.descriptionScope.clear();
    renderDescScopeGrid();
    saveLocal();
  });
  $('translateBtn').addEventListener('click', onTranslateClick);
  $('continueTranslateBtn').addEventListener('click', onContinueTranslateClick);
  $('pendingToggleBtn').addEventListener('click', () => {
    $('pendingLanguagesList').classList.toggle('hidden');
    renderPendingLanguages();
  });
  $('translateConfirmYesBtn').addEventListener('click', async () => {
    const selected = JSON.parse($('translateConfirm').dataset.pendingSelected || '[]');
    hideTranslateConfirm();
    await runScopedTranslate(selected, { resetResults: true });
  });
  $('translateConfirmNoBtn').addEventListener('click', hideTranslateConfirm);
  $('modelChangeConfirmYesBtn').addEventListener('click', () => {
    const newModel = $('modelChangeConfirm').dataset.pendingModel;
    $('modelChangeConfirm').classList.add('hidden');
    applyModelChange(newModel);
  });
  $('modelChangeConfirmNoBtn').addEventListener('click', hideModelChangeConfirm);
  // TASK CS-v2.0 작업 A — 남은 언어(quotaChoice에 저장해둔 목록)만 forcePaid로
  // 다시 보낸다. resetResults:false — 이미 성공한 언어는 그대로 둔다.
  $('quotaChoicePaidBtn').addEventListener('click', async () => {
    const pending = JSON.parse($('quotaChoice').dataset.pendingLanguages || '[]');
    hideQuotaChoice();
    await runScopedTranslate(pending, { resetResults: false, forcePaid: true });
  });
  // TASK CS-v2.0 — 셸의 키 다이얼로그는 이 iframe과 다른 문서다
  // (public/index.html). CLAUDE.md 3.4대로 postMessage로 부모(셸)에 요청하고
  // origin을 명시한다 — 같은 오리진에서만 서빙되는 앱이지만, 관례를 그대로
  // 따른다.
  $('quotaChoiceSetupBtn').addEventListener('click', () => {
    hideQuotaChoice();
    window.parent.postMessage({ type: 'creator-studio:open-paid-key-dialog' }, window.location.origin);
  });
  $('quotaChoiceLaterBtn').addEventListener('click', hideQuotaChoice);
  $('exportCsvBtn').addEventListener('click', exportCsv);
  $('exportJsonBtn').addEventListener('click', exportJson);
  $('copyAllBtn').addEventListener('click', copyAll);
  window.addEventListener('beforeunload', saveLocal);
  // TASK CS-v2.2 — 키가 바뀌면(특히 유료 키 추가/변경) 그 프로젝트에서 쓸 수
  // 있는 모델 목록도 달라질 수 있어 같이 다시 불러온다.
  window.addEventListener('creator-studio:key-updated', () => { loadStatus(); loadModelList(); });
}

restoreLocal();
renderSourceControls();
renderLanguages();
setupEvents();
loadStatus();
loadModelList();
loadLanguageCatalog(); // TASK CS-v2.6 — 실패해도 비상 목록으로 그린다(화면을 막지 않는다)

/* ------------------------------------------------------------------ *
 * TASK CS-v1.6 — 유튜브에 번역 자동 등록 (videos.update: localizations)
 *
 * The write path is deliberately two-step (미리보기 → 등록), like the
 * timeline tool's rename: this publishes to a live public channel, and the
 * language-code resolution (한국어 라벨 → BCP-47) can legitimately fall back
 * or drop a language, so the user sees exactly what will land before it does.
 * ------------------------------------------------------------------ */

// TASK CS-v2.4 — renamingId는 "지금 이름을 고치는 중인 행"이다. 계정 행은
// 상태가 바뀔 때마다 통째로 다시 그려지므로, 편집 중인지 여부도 상태로 갖고
// 있어야 다시 그릴 때 입력칸이 사라지지 않는다.
const publishState = { oauth: null, plan: null, renamingId: '' };

function activeAccount() {
  const status = publishState.oauth;
  if (!status) return null;
  return (status.accounts || []).find((account) => account.id === status.activeAccountId) || null;
}

/*
 * TASK CS-v2.4 — 계정을 바꾸면 이전 계정에서 불러온 것들은 전부 무효다.
 * 특히 미리본 계획(publishState.plan)을 남겨 두면, A계정에서 고른 영상 ID로
 * B계정에 등록을 시도하게 된다 — 그건 남의 채널에 대한 쓰기 실패이거나(운이
 * 좋으면) 소유권 검사에 걸리는 403이다. 목록·계획·버튼을 같이 비운다.
 */
function invalidateAccountScopedState() {
  const select = $('myVideoSelect');
  select.innerHTML = '';
  select.classList.add('hidden');
  publishState.plan = null;
  $('applyPublishBtn').disabled = true;
  $('publishReport').classList.add('hidden');
  $('publishVerify').classList.add('hidden');
}

function accountRowHtml(account, activeId) {
  const id = escapeHtml(account.id);
  if (publishState.renamingId === account.id) {
    return `<div class="account-row${account.id === activeId ? ' active' : ''}" data-id="${id}">
      <span class="account-dot"></span>
      <span class="account-rename">
        <input class="account-rename-input" type="text" value="${escapeHtml(account.label)}" data-id="${id}" />
      </span>
      <span class="account-actions">
        <button class="mini-btn" data-action="rename-save" data-id="${id}">저장</button>
        <button class="mini-btn" data-action="rename-cancel" data-id="${id}">취소</button>
      </span>
    </div>`;
  }

  const meta = [];
  meta.push(account.channelTitle ? `채널: ${escapeHtml(account.channelTitle)}` : '채널 미확인');
  if (!account.hasToken) {
    meta.push('<span class="bad">연결 안 됨 — [재연결] 필요</span>');
  } else if (account.connectionAgeDays !== null && account.connectionAgeDays !== undefined) {
    meta.push(`${account.connectionAgeDays}일 전 연결`);
  }
  if (account.hasToken && account.probablyExpired) {
    meta.push(`<span class="warn">${publishState.oauth?.testingTokenDays ?? 7}일 만료 가능 · 재연결 권장</span>`);
  }

  return `<div class="account-row${account.id === activeId ? ' active' : ''}" data-id="${id}" data-action="activate">
    <span class="account-dot"></span>
    <span class="account-main">
      <span class="account-label">${escapeHtml(account.label)}${account.id === activeId ? ' · 선택됨' : ''}</span>
      <div class="account-meta">${meta.join(' · ')}</div>
    </span>
    <span class="account-actions">
      <button class="mini-btn" data-action="rename" data-id="${id}">이름</button>
      <button class="mini-btn" data-action="reconnect" data-id="${id}">재연결</button>
      <button class="mini-btn" data-action="delete" data-id="${id}">삭제</button>
    </span>
  </div>`;
}

function renderAccounts() {
  const status = publishState.oauth;
  const box = $('accountList');
  if (!status) { box.innerHTML = ''; return; }
  const accounts = status.accounts || [];
  if (!accounts.length) {
    box.innerHTML = '<p class="account-empty">등록된 계정이 없습니다. 위에 별명을 적고 [＋ 계정 추가]를 눌러 주세요.</p>';
    return;
  }
  box.innerHTML = accounts.map((account) => accountRowHtml(account, status.activeAccountId)).join('');
}

async function loadOAuthStatus() {
  try {
    const status = await api('/api/yt/oauth/status');
    const previousActive = publishState.oauth?.activeAccountId;
    publishState.oauth = status;
    $('redirectUriBox').textContent = status.redirectUri;
    if (status.clientIdPreview && !$('clientIdInput').value) $('clientIdInput').placeholder = status.clientIdPreview;

    const badges = [];
    badges.push(`<span class="badge ${status.hasClient ? 'ok' : 'warn'}">OAuth 클라이언트 ${status.hasClient ? '설정됨' : '필요'}</span>`);
    const active = activeAccount();
    if (active) {
      const expiring = active.probablyExpired || !active.hasToken;
      badges.push(`<span class="badge ${expiring ? 'warn' : 'ok'}">선택: ${escapeHtml(active.label)}${
        active.channelTitle && active.channelTitle !== active.label ? ` (${escapeHtml(active.channelTitle)})` : ''}</span>`);
      if (active.probablyExpired) {
        badges.push(`<span class="badge warn">${status.testingTokenDays}일 만료 가능 · 재연결 권장</span>`);
      }
    } else {
      badges.push(`<span class="badge warn">계정 ${(status.accounts || []).length ? '미선택' : '없음'}</span>`);
    }
    $('oauthBadges').innerHTML = badges.join('');
    renderAccounts();
    if (!status.hasClient) $('oauthSetup').open = true;
    // 서버 쪽에서 활성 계정이 바뀐 경우(예: 활성 계정을 지워 자동 전환)에도
    // 이전 계정 기준으로 불러온 목록·계획은 버린다.
    if (previousActive && previousActive !== status.activeAccountId) invalidateAccountScopedState();
  } catch (error) {
    $('oauthBadges').innerHTML = '<span class="badge warn">연결 상태 확인 실패</span>';
  }
}

async function saveOAuthClient() {
  setError('publishError');
  try {
    await api('/api/yt/oauth/credentials', {
      method: 'POST',
      body: JSON.stringify({
        clientId: $('clientIdInput').value.trim(),
        clientSecret: $('clientSecretInput').value.trim(),
      }),
    });
    $('clientSecretInput').value = '';
    showToast('클라이언트 정보를 저장했습니다. 이제 [＋ 계정 추가]를 눌러 주세요.');
    await loadOAuthStatus();
  } catch (error) {
    setError('publishError', error.message);
  }
}

function openConsentPopup({ label = '', reconnectId = '' } = {}) {
  if (!publishState.oauth?.hasClient) {
    $('oauthSetup').open = true;
    return setError('publishError', '먼저 구글 OAuth 클라이언트 ID와 보안 비밀번호를 저장해 주세요.');
  }
  setError('publishError');
  const query = new URLSearchParams();
  if (label) query.set('label', label);
  if (reconnectId) query.set('reconnect', reconnectId);
  // A popup, not a redirect: this tool runs inside the Creator Studio shell's
  // iframe and would otherwise navigate the whole app away to Google.
  window.open(`/api/yt/oauth/start?${query.toString()}`, 'creator-studio-yt-oauth', 'width=520,height=680');
}

function addAccount() {
  const label = $('newAccountLabel').value.trim();
  openConsentPopup({ label });
  $('newAccountLabel').value = '';
  showToast('구글 계정 선택 화면에서 반드시 "다른 계정"을 골라 주세요.');
}

async function switchAccount(accountId) {
  if (!accountId || accountId === publishState.oauth?.activeAccountId) return;
  setError('publishError');
  try {
    await api('/api/yt/oauth/active', { method: 'POST', body: JSON.stringify({ accountId }) });
    // 상태를 다시 읽기 전에 먼저 비운다: 화면에 이전 계정의 영상 목록이
    // 한 순간이라도 선택 가능한 채로 남아 있으면 안 된다.
    invalidateAccountScopedState();
    await loadOAuthStatus();
    showToast(`선택한 계정: ${activeAccount()?.label || accountId}`);
  } catch (error) {
    setError('publishError', error.message);
  }
}

async function saveAccountLabel(accountId, label) {
  setError('publishError');
  try {
    await api('/api/yt/oauth/rename', { method: 'POST', body: JSON.stringify({ accountId, label }) });
    publishState.renamingId = '';
    await loadOAuthStatus();
    showToast('별명을 바꿨습니다.');
  } catch (error) {
    setError('publishError', error.message);
  }
}

async function deleteAccount(accountId) {
  const account = (publishState.oauth?.accounts || []).find((row) => row.id === accountId);
  if (!window.confirm(`"${account?.label || accountId}" 계정을 목록에서 지웁니다. 유튜브 영상에는 아무 영향이 없고, 다시 쓰려면 구글 동의를 다시 받아야 합니다. 계속할까요?`)) return;
  setError('publishError');
  try {
    const data = await api('/api/yt/oauth/disconnect', { method: 'POST', body: JSON.stringify({ accountId }) });
    invalidateAccountScopedState();
    await loadOAuthStatus();
    const next = (data.accounts || []).find((row) => row.id === data.activeAccountId);
    showToast(next ? `계정을 지웠습니다. 선택한 계정: ${next.label}` : '계정을 지웠습니다. 남은 계정이 없습니다.');
  } catch (error) {
    setError('publishError', error.message);
  }
}

/*
 * TASK CS-v2.4 — 행은 상태가 바뀔 때마다 통째로 다시 그려진다. 그래서 개별
 * 버튼에 리스너를 달면 다시 그리는 순간 전부 끊어진다. 목록 컨테이너 하나에만
 * 위임하고, 어떤 동작인지는 data-action으로 판별한다.
 */
function handleAccountListClick(event) {
  const button = event.target.closest('button[data-action]');
  const row = event.target.closest('.account-row');
  if (!row) return;
  const accountId = button?.dataset.id || row.dataset.id;

  if (button) {
    event.stopPropagation();
    const action = button.dataset.action;
    if (action === 'rename') { publishState.renamingId = accountId; renderAccounts(); $('accountList').querySelector('.account-rename-input')?.focus(); return; }
    if (action === 'rename-cancel') { publishState.renamingId = ''; renderAccounts(); return; }
    if (action === 'rename-save') {
      const input = row.querySelector('.account-rename-input');
      return saveAccountLabel(accountId, input ? input.value : '');
    }
    if (action === 'reconnect') {
      const account = (publishState.oauth?.accounts || []).find((item) => item.id === accountId);
      return openConsentPopup({ reconnectId: accountId, label: account?.label || '' });
    }
    if (action === 'delete') return deleteAccount(accountId);
    return;
  }

  if (publishState.renamingId === accountId) return; // 편집 중인 행은 클릭으로 전환하지 않는다
  switchAccount(accountId);
}

async function loadMyVideos() {
  setError('publishError');
  const button = $('refreshVideosBtn');
  button.disabled = true;
  try {
    const accountId = publishState.oauth?.activeAccountId || '';
    const data = await api(`/api/yt/my-videos?maxResults=50&accountId=${encodeURIComponent(accountId)}`);
    const select = $('myVideoSelect');
    if (!data.videos.length) {
      select.classList.add('hidden');
      return setError('publishError', `"${data.accountLabel || '선택한 계정'}" 채널에서 영상을 찾지 못했습니다.`);
    }
    select.innerHTML = `<option value="">— ${escapeHtml(data.accountLabel || '내 영상')}에서 고르기 —</option>` + data.videos.map((video) =>
      `<option value="${escapeHtml(video.videoId)}">${escapeHtml(video.title)}</option>`).join('');
    select.classList.remove('hidden');
    showToast(`${escapeHtml(data.accountLabel || '')} · ${data.videos.length}개 영상을 불러왔습니다.`);
  } catch (error) {
    setError('publishError', error.message);
  } finally {
    button.disabled = false;
  }
}

function currentTranslationsForPublish() {
  return state.results
    .filter((result) => (result.translatedTitle || '').trim())
    .map((result) => ({
      language: result.language,
      languageCode: resultCode(result), // TASK CS-v2.6 — 서버 planLocalizations()가 라벨보다 먼저 쓴다
      translatedTitle: result.translatedTitle,
      translatedDescription: result.translatedDescription,
    }));
}

// TASK CS-v2.3 — routes/yt.js의 formatPublishProblems()와 같은 필드명을
// 사람이 읽는 라벨로 바꾼다. 서버가 이미 error.message로 같은 문장을 만들어
// 주지만(적용을 막을 때), 미리보기 단계에서는 에러가 아니라 dryRun 응답의
// problems[]로 오므로 화면에서 따로 조립해야 한다.
function publishProblemLabel(field) {
  if (field === 'snippet.title') return '영상 제목(snippet.title)';
  if (field === 'snippet.description') return '영상 설명(snippet.description)';
  if (field === 'snippet.tags') return '태그 전체 합계(snippet.tags)';
  const m = /^localizations\.([^.]+)\.(title|description)$/.exec(field);
  if (m) return `${m[2] === 'title' ? '번역 제목' : '번역 설명'} (${m[1]})`;
  return field;
}

function renderPublishReport(data, applied) {
  const box = $('publishReport');
  const rows = (applied ? data.published : data.planned) || [];
  const overwriting = new Set(data.overwriting || []);
  const parts = [];

  parts.push(`<h4>${applied ? '등록 완료' : '미리보기 — 아직 아무것도 등록되지 않았습니다'}</h4>`);
  parts.push(`<p>계정: <strong>${escapeHtml(data.accountLabel || '')}</strong> · 영상: <strong>${escapeHtml(data.videoTitle || data.videoId)}</strong> · 원문 언어 <code>${escapeHtml(data.defaultLanguage)}</code>` +
    (applied ? ` · 현재 등록된 언어 ${data.totalLocalizations}개` : '') + '</p>');

  if (data.problems?.length) {
    parts.push(`<p class="bad">⚠ 유튜브 길이 제한 초과 ${data.problems.length}건 — 이대로는 등록할 수 없습니다.</p><ul>` +
      data.problems.map((p) =>
        `<li>${escapeHtml(publishProblemLabel(p.field))} — ${p.length}자 (최대 ${p.limit}자)</li>`).join('') + '</ul>');
  }

  // TASK CS-v2.6 — 5000바이트 초과는 막지 않고 알린다. 문서상 제한(원문 설명)과
  // 문서에 없는 항목(번역 설명 — 참고용)을 구분하고, 이번에 새로 보내는 것과 이미
  // 유튜브에 있던 것도 구분한다(lib/ytPublishValidation.js describeByteRisks()).
  const risks = data.byteRisks || [];
  if (risks.length) {
    const line = (r) => `<li>${escapeHtml(publishProblemLabel(r.field))} — ${r.bytes.toLocaleString('ko-KR')}바이트 (${r.chars.toLocaleString('ko-KR')}자)` +
      ` <span class="hint">${r.basis === 'documented' ? '[문서상 제한 5000바이트]' : '[문서에 제한 없음 · 참고]'} ${escapeHtml(r.note)}</span></li>`;
    const main = risks.filter((r) => r.origin !== 'existing');
    const existingRisks = risks.filter((r) => r.origin === 'existing');
    if (main.length) {
      parts.push(`<p class="warn">⚠ 설명 5000바이트(UTF-8) 초과 ${main.length}건 — 등록을 막지는 않습니다. 실제로 거부될지는 실측되지 않았습니다.</p><ul>` + main.map(line).join('') + '</ul>');
    }
    if (existingRisks.length) {
      parts.push(`<details><summary class="hint">이미 유튜브에 저장된 번역 설명 중 5000바이트 초과 ${existingRisks.length}건 (참고)</summary><ul>` + existingRisks.map(line).join('') + '</ul></details>');
    }
  }
  if (rows.length) {
    parts.push(`<p class="ok">${applied ? '등록됨' : '등록 예정'} ${rows.length}개 언어</p><ul>` + rows.map((row) => {
      const isOverwrite = overwriting.has(row.code);
      return `<li><code>${escapeHtml(row.code)}</code> ${escapeHtml(row.language)}` +
        (isOverwrite ? ' <span class="warn">(기존 번역 덮어씀)</span>' : '') +
        (row.note ? ` <span class="warn">— ${escapeHtml(row.note)}</span>` : '') +
        // TASK CS-v2.6 — 설명이 실리는 언어는 글자 수와 UTF-8 바이트를 같이 보여 준다.
        (row.descriptionChars ? ` <span class="hint">· 설명 ${row.descriptionChars.toLocaleString('ko-KR')}자 / ${Number(row.descriptionBytes || 0).toLocaleString('ko-KR')}바이트</span>` : '') +
        (row.title ? `<br /><span style="color:#cfe0f6">${escapeHtml(row.title)}</span>` : '') + '</li>';
    }).join('') + '</ul>');
  }

  if (data.skipped?.length) {
    parts.push(`<p class="bad">건너뜀 ${data.skipped.length}개</p><ul>` + data.skipped.map((row) =>
      `<li>${escapeHtml(row.language)} — ${escapeHtml(row.reason)}</li>`).join('') + '</ul>');
  }
  if (!applied && data.currentDefaultLanguage && data.currentDefaultLanguage !== data.defaultLanguage) {
    parts.push(`<p class="warn">이 영상의 원문 언어가 현재 <code>${escapeHtml(data.currentDefaultLanguage)}</code>로 설정돼 있습니다. 등록하면 <code>${escapeHtml(data.defaultLanguage)}</code>로 바뀝니다.</p>`);
  }
  if (applied) parts.push(`<p class="hint">유튜브 스튜디오 &gt; 자막/번역 메뉴에서도 확인할 수 있습니다. 반영까지 몇 분 걸릴 수 있습니다. (${escapeHtml(data.quotaNote || '')})</p>`);

  box.innerHTML = parts.join('');
  box.classList.remove('hidden');
}

async function previewPublish() {
  setError('publishError');
  const translations = currentTranslationsForPublish();
  if (!translations.length) return setError('publishError', '먼저 위에서 번역을 실행해 주세요. 등록할 번역 결과가 없습니다.');
  const videoId = $('publishVideoId').value.trim() || $('myVideoSelect').value;
  if (!videoId) return setError('publishError', '대상 영상 URL 또는 ID를 입력해 주세요.');
  const accountId = publishState.oauth?.activeAccountId || '';
  if (!accountId) return setError('publishError', '먼저 유튜브 계정을 추가하고 등록할 계정을 골라 주세요.');

  $('previewPublishBtn').disabled = true;
  try {
    const data = await api('/api/yt/publish-localizations', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        videoId,
        defaultLanguage: $('defaultLanguageSelect').value,
        translations,
        dryRun: true,
      }),
    });
    // TASK CS-v2.4 — 계획에 accountId를 넣어 둔다(4.1). 적용은 미리본 계획
    // 그대로만 나가야 하므로, 그 사이에 활성 계정이 바뀌었더라도 미리본
    // 계정으로 등록된다.
    publishState.plan = { accountId, videoId, defaultLanguage: data.defaultLanguage, translations };
    renderPublishReport(data, false);
    $('applyPublishBtn').disabled = !data.planned?.length || Boolean(data.problems?.length);
  } catch (error) {
    setError('publishError', error.message);
    publishState.plan = null;
    $('applyPublishBtn').disabled = true;
  } finally {
    $('previewPublishBtn').disabled = false;
  }
}

/*
 * TASK CS-v2.0 작업 B — publishedCount는 "보낸 개수"지 "저장된 개수"가
 * 아니다. /localizations는 videos.list(1유닛)로 유튜브에 실제로 저장된
 * 값을 그대로 되읽으므로, videos.update(50유닛)를 또 쓰는 게 아니라
 * 부담 없이 매 등록 뒤에 호출할 수 있다(routes/yt.js의 /localizations
 * 주석 참고).
 */
function renderPublishVerification(sentPublished, verifyData) {
  const box = $('publishVerify');
  const existing = verifyData.existing || [];
  const savedCodes = new Set(existing.map((e) => e.code));
  const sentCodes = sentPublished.map((p) => p.code);
  const missingAfterSave = sentCodes.filter((code) => !savedCodes.has(code));

  const parts = [];
  parts.push('<h4>유튜브에서 실제로 되읽은 결과</h4>');
  parts.push(`<p class="hint">보낸 언어 ${sentCodes.length}개 · 방금 videos.list로 다시 읽은 결과 유튜브에 저장된 언어 ${existing.length}개</p>`);

  if (missingAfterSave.length) {
    parts.push(`<p class="bad">⚠ 보냈지만 되읽기에는 없는 언어 ${missingAfterSave.length}개: ${missingAfterSave.map(escapeHtml).join(', ')}` +
      ' — 유튜브가 조용히 거부했거나 반영에 시간이 걸리는 중일 수 있습니다. 잠시 후 새로고침해 다시 확인하세요.</p>');
  } else if (sentCodes.length) {
    parts.push('<p class="ok">보낸 언어가 모두 유튜브에 저장된 것으로 확인됩니다.</p>');
  }

  if (existing.length) {
    parts.push('<ul>' + existing.map((e) =>
      `<li><code>${escapeHtml(e.code)}</code>${sentCodes.includes(e.code) ? '' : ' <span class="hint">(이번에 보내지 않은, 기존 등록)</span>'}` +
      `<br /><span style="color:#cfe0f6">${escapeHtml(e.title)}</span></li>`
    ).join('') + '</ul>');
  }

  parts.push('<p class="hint">직접 확인: YouTube Studio → 콘텐츠 → 이 영상 → 세부정보 → "번역 추가(다른 언어)" 섹션에서 언어별 제목을 볼 수 있습니다. ' +
    '또는 유튜브 자체의 표시 언어 설정을 등록한 언어로 바꾼 뒤 영상 페이지를 열어 확인하세요. ' +
    '이 등록은 Gemini 번역 한도와는 무관한 별도 기능입니다(유튜브 쿼터, 하루 10,000유닛) — 여기서 발생하는 비용은 없습니다.</p>');

  box.innerHTML = parts.join('');
  box.classList.remove('hidden');
}

async function applyPublish() {
  if (!publishState.plan) return setError('publishError', '먼저 미리보기를 실행해 주세요.');
  setError('publishError');
  $('publishVerify').classList.add('hidden');
  const button = $('applyPublishBtn');
  button.disabled = true;
  button.textContent = '등록 중…';
  try {
    // Publishes exactly the plan that was previewed, never a freshly rebuilt one.
    const data = await api('/api/yt/publish-localizations', {
      method: 'POST',
      body: JSON.stringify({ ...publishState.plan, dryRun: false }),
    });
    renderPublishReport(data, true);
    showToast(`${data.publishedCount}개 언어를 유튜브로 보냈습니다. 실제 저장 여부 확인 중…`);

    // TASK CS-v2.0 작업 B 요구사항 1 — 등록 응답(보낸 개수) 말고, 되읽은 값이 진짜다.
    try {
      const verify = await api(`/api/yt/localizations?videoId=${encodeURIComponent(data.videoId)}&accountId=${encodeURIComponent(publishState.plan?.accountId || '')}`);
      renderPublishVerification(data.published || [], verify);
    } catch (verifyError) {
      $('publishVerify').innerHTML = `<p class="bad">등록 후 확인 조회 실패: ${escapeHtml(verifyError.message)} — YouTube Studio에서 직접 확인해 주세요.</p>`;
      $('publishVerify').classList.remove('hidden');
    }
  } catch (error) {
    setError('publishError', error.message);
  } finally {
    button.disabled = false;
    button.textContent = '✅ 유튜브에 등록';
  }
}

function setupPublishEvents() {
  $('saveClientBtn').addEventListener('click', saveOAuthClient);
  $('addAccountBtn').addEventListener('click', addAccount);
  $('newAccountLabel').addEventListener('keydown', (event) => { if (event.key === 'Enter') addAccount(); });
  $('accountList').addEventListener('click', handleAccountListClick);
  $('accountList').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.classList.contains('account-rename-input')) return;
    saveAccountLabel(event.target.dataset.id, event.target.value);
  });
  $('refreshVideosBtn').addEventListener('click', loadMyVideos);
  $('previewPublishBtn').addEventListener('click', previewPublish);
  $('applyPublishBtn').addEventListener('click', applyPublish);
  $('copyRedirectBtn').addEventListener('click', () => copyText($('redirectUriBox').textContent));
  $('myVideoSelect').addEventListener('change', (event) => {
    if (event.target.value) $('publishVideoId').value = event.target.value;
    $('applyPublishBtn').disabled = true;
  });
  // Any change to the target invalidates the previewed plan.
  ['publishVideoId', 'defaultLanguageSelect'].forEach((id) => {
    $(id).addEventListener('input', () => { publishState.plan = null; $('applyPublishBtn').disabled = true; });
  });
  $('defaultLanguageSelect').addEventListener('change', () => {
    publishState.plan = null;
    $('applyPublishBtn').disabled = true;
    updateDefaultLanguageHint(); // TASK CS-v2.6 — 번역 화면의 원본 언어와 다르면 경고
  });
  // The OAuth popup posts back here when Google finishes the round trip.
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'creator-studio:yt-oauth') loadOAuthStatus();
  });
}

setupPublishEvents();
loadOAuthStatus();
