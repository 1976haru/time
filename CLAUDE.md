# CLAUDE.md

이 저장소에서 작업할 때 먼저 읽는 파일입니다. 여기 적힌 제약은 전부 실제 코드에서
확인한 것이고, 근거 파일·줄 번호를 함께 적었습니다. 코드를 고치다 이 문서와 실제가
어긋나면 **이 문서도 같이 고치세요.**

---

## 1. 프로젝트 개요

로컬 전용 Express 서버 **한 개**(기본 포트 5300, `127.0.0.1` 바인딩)가 5개 크리에이터
도구를 iframe으로 서빙하는 단일 앱입니다. 외부에 배포되지 않고 사용자 PC에서만 돕니다.

용도: 시니어 대상 유튜브 플레이리스트 채널 2개(**한국 아침 플레이리스트**, **일본 쇼와
카페**)의 제작 파이프라인. 채널당 주 12곡 기준.

| 도구 | 정적 파일 | 라우터 |
|---|---|---|
| 유튜브 추출기·번역기·**자동 등록** | `tools/yt/` | `routes/yt.js` |
| 음악 타임라인 생성기 | `tools/timeline/` | `routes/timeline.js` |
| 스토리 숏츠 | `tools/shorts/` | `routes/shorts.js` |
| 스토리보드 | `tools/storyboard/` (빌드 산출물) | `routes/story.js` |
| 썸네일·커버 스튜디오 | `tools/thumbnail/` | `routes/thumbnail.js` |

현재 버전: **CS-v2.6.1**

---

## 2. 실행과 검증

```bash
npm start        # node server.js
npm run dev      # node --watch server.js
npm run check    # node --check server.js  ← server.js 하나만 문법 검사한다
```

`engines.node >= 20` (개발 확인은 v22 기준).

**주의: `npm run check`는 `server.js` 한 파일의 문법만 봅니다.** `routes/`, `lib/`,
`tools/`는 전혀 검사하지 않습니다. 자동 테스트는 아직 없습니다(로드맵 #10). 그래서
변경 후에는 **반드시 서버를 실제로 띄우고 해당 엔드포인트를 호출해서** 확인하세요.

첫 실행은 `start-creator-studio.bat`이 `npm install`과 스토리보드 빌드까지 자동으로
합니다(`start-creator-studio.bat:61-78`).

---

## 3. 아키텍처 제약 — 어기지 마세요

### 3.1 `tools/*/`는 빌드 스텝이 없는 정적 파일

- `tools/timeline/index.html`은 **HTML + CSS + JS가 한 파일에 들어있는 단일 파일**입니다
  (약 1,200줄, `<script>` 안 IIFE). 여기에 import·번들러·모듈 시스템을 도입하지 마세요.
  서버 없이 파일로 직접 열어도 타임라인 생성이 동작해야 한다는 것이 이 구조의 이유입니다.
- `tools/yt/app.js`만 `type="module"`입니다(`tools/yt/index.html`).
- `tools/shorts/`, `tools/thumbnail/`도 정적입니다.

### 3.2 `tools/storyboard/`는 직접 수정 금지

`storyboard-app/`(React + vite)의 **빌드 산출물**입니다. `vite.config.ts:10`의
`base: '/tools/storyboard/'` 설정으로 이 경로에 빌드됩니다. `.gitignore`에도 들어 있습니다.
고쳐야 하면 `storyboard-app/` 소스를 고치고 다시 빌드하세요.

### 3.3 `stripLeadingNumber()`는 의도적으로 두 벌 있습니다

- `routes/timeline.js:65`
- `tools/timeline/index.html:481`

정적 페이지와 서버가 모듈을 공유할 수 없어서 복제한 것입니다. **한쪽을 고치면 반드시
다른 쪽도 같이 고치세요.** 정규식 리터럴이 서로 완전히 같아야 합니다:

```js
/^\s*[\[(]?\d{1,3}[\])]?[\s._-]+/
```

(따옴표 스타일만 서버는 `'`, 클라이언트는 `"`로 다릅니다. 정규식 자체는 동일합니다.)
`normalizeForMatch()`도 같은 이유로 두 벌입니다(`routes/timeline.js:72`,
`tools/timeline/index.html:492`). 이 둘이 어긋나면 폴더의 실제 파일명과 화면의 곡 제목이
매칭되지 않아 rename이 조용히 아무 일도 안 하게 됩니다.

### 3.3.1 파일명에 구워진 괄호 제목 분리 (CS-v2.5)

실제 운영 파일명은 `01. Run Past the Gate (교문밖그날).wav`처럼 괄호 제목이 이미
들어있습니다. 그대로 두면 `track.title`이 괄호까지 삼켜서 CS-v1.6의 [괄호 제목 표기]
드롭다운을 "사용 안 함"으로 놔도 괄호가 출력에 남습니다 — 옵션이 무력해집니다.
그래서 `splitBracketTitle()`(`tools/timeline/index.html`)이 파일을 불러오는 시점에
맨 끝 괄호 한 쌍을 떼어 `titleKo`/`titleJa`로 옮깁니다.

- **분리 판정을 영어 음악 용어 목록(`Live`/`Remix`/`feat.`…)으로 만들지 마세요.**
  목록은 반드시 샙니다. 규칙은 "괄호 안에 한글·가나·한자가 하나라도 있는가" 하나뿐이고,
  이게 윈도우 중복 다운로드의 `(1)`·`(2)`까지 같이 걸러 줍니다.
- 맨 끝 괄호만 대상입니다. `Rock (Live) at Dawn`처럼 중간에 있는 괄호는 건드리지 않습니다.
- 필드 배정: 가나가 있으면 `titleJa`, 한글만 있으면 `titleKo`, 한자만 있으면 `titleJa`.
  한글+가나가 섞이면 일본어로 봅니다. `(한국어 / 日本語)`는 슬래시로 나눠 각각 넣되,
  조각 중 하나라도 한글·일본어가 없으면(`(Live / 昭和)`) 쪼개지 않고 한 덩어리로 둡니다.
- **드롭다운 기본값은 `none`을 유지합니다.** 대신 실제로 분리했으면 상태 표시줄에
  몇 곡에서 분리했는지 알립니다 — 이 안내가 없으면 사용자는 제목이 사라졌다고 오해합니다.
- **디스크 파일명(rename·ZIP)에는 [괄호 제목 표기]와 무관하게 괄호가 들어가지 않습니다**
  (사용자 결정, CS-v2.5). 대신 rename 미리보기가 괄호가 떨어져 나가는 항목 수를 세어
  `#bracketRenameWarn`에 경고를 띄웁니다(`computeRenamePlan()`의 `bracketDropped`).
  4.1의 "미리보기 → 적용"에서 미리보기가 지는 책임입니다 — 지우지 마세요.

### 3.4 셸은 iframe을 `display` 토글로만 전환합니다

`public/shell.js:17` — 5개 iframe이 셸 로드 시 전부 한 번 로드되고, 탭 전환은 `display`만
바꿉니다. 그래서 탭을 옮겨도 입력 상태가 살아 있습니다. iframe을 매번 다시 로드하는
방식으로 바꾸지 마세요(사용자가 작업 중이던 내용이 날아갑니다).

도구 사이에 데이터를 주고받아야 하면 iframe → 셸 → iframe의 `postMessage` 중계를 쓰고,
`origin`을 반드시 검증하세요.

### 3.5 Gemini 키는 `lib/keyStore.js`를 통해서만

`lib/keyStore.js`가 키를 읽어 전 도구에 공급합니다. **키 값을 API 응답이나 로그에 절대
노출하지 마세요.** 상태 확인은 `currentKey()`/`hasPaidKey()`의 불리언 결과만 씁니다.

**CS-v1.8부터 무료/유료 두 슬롯입니다** (Gemini 과금·한도가 API 키 = Google Cloud
프로젝트 단위이기 때문— 프로젝트당 요청 한도표는 안 적습니다, 요금표처럼 바뀌니 필요하면
그때 확인하세요):

- 무료: `.gemini_key` 파일 / `GEMINI_API_KEY` 환경변수. 기존과 동일.
- 유료(선택): `.gemini_key_paid` 파일 / `GEMINI_API_KEY_PAID` 환경변수. `currentKey('paid')`가
  없으면 무료 키로 **자동 폴백**하므로, 유료 키를 넣지 않으면 지금처럼 전부 무료 키로
  동작합니다.
- **유료 슬롯을 쓰는 곳은 `routes/yt.js`의 `/translate`·`/regenerate` 딱 둘뿐**입니다. 나머지
  전부(추출, 타임라인, 숏츠 텍스트/이미지/영상, 스토리보드, 썸네일, 소셜 스튜디오)는 무료
  슬롯입니다. 새 유료 호출을 추가하고 싶으면 먼저 제안하세요 — 단가 자릿수가 다른 걸(특히
  이미지·영상 생성) 유료 슬롯에 붙이지 않습니다.
- `lib/gemini.js`의 요청 큐(`minIntervalMs`/재시도)도 슬롯별로 **독립**입니다. 두 키는 서로
  다른 프로젝트의 서로 다른 분당 한도이므로 같은 큐를 타면 안 됩니다.
- 어떤 요청이 어느 슬롯을 쓰는지는 `withRetry(fn, { tier })`/`requireGeminiClient(tier)`의
  `tier` 인자로 결정됩니다. 인자를 생략하면 항상 `'free'`— 새 호출부를 추가할 때 유료로
  보내려는 의도가 없다면 그냥 생략하면 됩니다.

> 알려진 불일치: `routes/shorts.js:165`는 `keyStore` 대신 `process.env`를 직접 읽습니다.
> 동작에는 문제가 없지만 shorts를 손볼 일이 있으면 `currentKey()`로 통일하세요.

**CS-v2.1부터 `/translate`에 `scope`(`'title'` | `'full'`, 기본값 `'title'`)가 있습니다.**
제목만 번역하면 50개 언어가 호출 1회로 끝나(설명 미전송 + 출력 스키마도 제목만 요청 —
실측 43,142 → 1,523 토큰, 96.5% 감소) 무료 한도로 충분한 경우가 많습니다. 설명까지
번역할 언어는 `tools/yt/app.js`의 "설명까지 번역할 언어" 영역에서 따로 고르고, 그
언어들만 `scope:'full'`로 별도 요청이 나갑니다. 캐시 키(`lib/ytTranslationCache.js`)에도
`scope`가 들어가 있어 `title`로 캐시된 항목이 `full` 조회에 잘못 히트하지 않습니다 —
새 caller를 추가할 때 `scope`를 빠뜨리면 캐시가 조용히 오염됩니다.

**CS-v2.2부터 모델을 화면에서 고를 수 있습니다.** `/translate`·`/regenerate`·`/extract`가
요청 본문의 `model`을 받고, 폴백 순서는 요청값 → `GEMINI_MODEL` 환경변수 →
`gemini-3.5-flash`입니다. 서버가 `resolveModel()`로 형식을 재검증합니다(영숫자·하이픈·
마침표, 64자 이내) — 형식이 틀리면 400, 폴백 대상이 아닙니다. `GET /api/yt/models`가
그 계정에서 실제로 쓸 수 있는 텍스트 모델 목록을 돌려주고(`ai.models.list()` 조회,
임베딩·이미지·TTS·비디오 계열 제외 — 필터는 이름과 description을 같이 봅니다,
"nano-banana-pro-preview"처럼 이름만으로는 안 걸러지는 이미지 모델이 실제로 있었습니다),
화면은 이 목록으로 드롭다운을 채우고 실패하면 자유 입력으로 폴백합니다. 모델이
404(사용 불가)를 반환하면 조용히 다른 모델로 갈아타지 않고 사용 가능한 목록과 함께
알립니다 — 이 원칙은 협상 대상이 아닙니다(4.2와 같은 이유: 사용자가 고른 것과 다른
모델로 돈이 나가면 안 됩니다). `skipThinkingConfigByModel`/`extractToolsModeByModel`은
모델별로 따로 기억합니다 — 계정 전역이 아니라 모델별 속성이라 프로세스 전역 플래그
하나로는 부정확합니다.

---

## 4. 외부에 쓰는 기능의 안전 규칙

이 앱은 사용자의 **실제 파일**과 **실제 유튜브 채널**에 씁니다. 아래 패턴은 협상 대상이
아닙니다.

### 4.1 미리보기 → 적용 2단계

새로 만드는 쓰기 기능도 전부 이 형태여야 합니다. **미리보기 없이 바로 실행되는 경로를
만들지 마세요.**

- 적용은 **미리본 계획 그대로만** 전송합니다. 적용 시점에 계획을 다시 계산하지 않습니다
  (`tools/timeline/index.html:383`의 `currentRenamePlan`, `tools/yt/app.js`의
  `publishState.plan`).
- 목록·순서·대상이 바뀌면 이전 미리보기를 무효화하고 다시 스캔하게 합니다.

### 4.2 파일명 변경 (`routes/timeline.js`)

`fs.rename`을 호출하는 곳은 `/apply-rename` 하나뿐이고, 클라이언트 미리보기를 신뢰하지
않고 서버가 전부 재검증합니다: 확장자 화이트리스트(`.wav`/`.mp3`), 원본 존재 확인,
멱등 스킵, 이름 충돌 감지, 시스템 폴더 차단, 자기 자신 폴더 차단(`assertSafeFolder()`).
실행 직전 폴더에 `_rename_backup.json`을 남겨 `undo-rename`으로 1단계 되돌립니다.
**이 검증을 "클라이언트가 이미 확인했으니"라는 이유로 건너뛰지 마세요.**

한 항목이 실패해도 나머지 배치는 계속 진행하고, 실패 사유를 항목별로 보고합니다.
새 배치 기능도 이 패턴을 따르세요.

### 4.3 `videos.update`는 part를 통째로 교체합니다

값이 있는 속성을 빼고 보내면 **그 값이 삭제됩니다.** 그래서 등록 경로는 항상
read-modify-write입니다 (`routes/yt.js`의 `/publish-localizations`):

```
videos.list(part=snippet,localizations)
  → 기존 title/description/categoryId/tags/localizations 보존
  → 새 localizations 병합
  → PUT videos(part=snippet,localizations)
```

**이 패턴을 절대 단순화하지 마세요.** 영상 제목과 설명이 통째로 날아갑니다.
`playlists.update`도 같습니다.

### 4.4 유튜브 OAuth

- 쓰기라서 API 키로는 안 됩니다. `youtube.force-ssl` 범위의 OAuth 2.0이 필요합니다.
- 클라이언트 ID/보안 비밀번호와 refresh token은 `.yt_oauth.json`(mode 600, gitignore)에만
  저장합니다.
- 동의 화면이 "테스트" 상태면 구글이 **7일마다 refresh token을 만료**시킵니다. 숨기지
  말고 UI에 경과일 배지와 `invalid_grant` 전용 안내로 표면화하세요(`lib/ytOAuth.js`).
- 쿼터: `videos.update` 1회 = **50유닛**, 기본 일일 10,000유닛. 언어를 몇 개 올리든
  영상 1편당 50유닛입니다. **이 한도는 계정별이 아니라 OAuth 클라이언트가 속한 구글 클라우드
  프로젝트 전체**에 걸립니다 — 소진되면 계정을 바꿔도 소용없고, 그 사실이 오류 문구에 있어야
  사용자가 계정을 하나씩 바꿔 보며 헤매지 않습니다.

### 4.4.1 계정 다중 등록 (CS-v2.4)

`.yt_oauth.json`은 `{ clientId, clientSecret, accounts: [...], activeAccountId }`입니다.
`accounts[]` 각 항목은 `{ id, label, refreshToken, channelId, channelTitle, connectedAt }`.

**구조상 핵심 — 이걸 놓치면 설계가 틀어집니다: OAuth 클라이언트(clientId + clientSecret =
구글 클라우드 프로젝트)는 모든 계정이 공유하고, refresh token만 계정별입니다.** 그래서 Cloud
Console 설정은 채널을 몇 개 늘리든 최초 1회로 끝나고, 계정마다 반복되는 것은 구글 동의
절차뿐입니다. 계정 추가 화면에서 클라이언트 ID를 다시 묻지 마세요.

- 계정 id는 채널 id가 아니라 생성된 랜덤 값(`acc_` + hex)입니다. 동의가 끝나기 전에는 어느
  채널인지 알 수 없는데 행은 먼저 있어야 하기 때문입니다(라벨을 구글 왕복 너머로 실어 나르는
  것이 그 행입니다).
- v1.6 형식(최상위 `refreshToken`)은 `readOAuthFile()`이 읽을 때 `accounts[0]`으로 자동
  이관하고 최상위 키를 지웁니다. **이 마이그레이션을 지우지 마세요** — 사용자 PC에는 이미 살아
  있는 연결이 들어 있고, 날리면 데이터 손실로 보입니다.
- **`buildAuthUrl()`의 `prompt`는 `consent select_account`입니다. `select_account`를 빼면
  기능이 통째로 무의미해집니다.** 구글이 브라우저에 이미 로그인된 계정을 그대로 재사용해서,
  [계정 추가]를 눌러도 같은 채널만 다시 연결되고 화면에는 고장난 것처럼 보입니다.
- **같은 채널 중복 등록 방어**(`rememberChannel()`): 같은 `channelId`를 가진 다른 행이 있으면
  새 행을 지우고 기존 행의 토큰만 갱신한 뒤 `duplicateOf`를 돌려줍니다. 콜백 화면은 그걸 받아
  "이미 등록된 채널입니다 — OO의 연결을 갱신했습니다"라고 알립니다. 안 막으면 사용자가 "일본
  채널"이라 믿는 행이 실제로는 한국 채널이어서 **한국 채널에 일본어 제목이 올라갑니다.**
- `accessTokenCache`는 계정별 `Map`입니다. 단일 변수로 되돌리지 마세요 — A계정용 토큰이
  B계정 요청에 재사용되어 엉뚱한 채널에 쓰게 됩니다.
- 소유권 검사는 **선택한 계정의 `channelId`** 와 대조하고, 오류 메시지에 계정 별명과 고칠
  방법을 넣습니다. 다계정이 되면서 계정을 잘못 고르는 일이 실제로 가능해졌습니다.
- **API 응답에 `refreshToken`을 넣지 마세요.** 연결 여부는 `hasToken: Boolean(...)` 불리언으로만
  노출합니다(3.5와 같은 이유).
- 프론트엔드에서 계정을 전환하면 **이전 계정의 영상 목록과 미리본 계획을 반드시 무효화**합니다
  (`tools/yt/app.js`의 `invalidateAccountScopedState()`). 안 그러면 A계정에서 고른 영상 ID로
  B계정에 등록을 시도하게 됩니다. 계정 행은 다시 그려지므로 개별 버튼에 리스너를 달지 말고
  `#accountList`에 이벤트를 위임하세요.

### 4.5 언어 코드 해석

한국어 라벨(`포르투갈어 (브라질)`) → BCP-47(`pt-BR`) 변환은 `lib/ytLanguages.js`의
후보 배열에서 하고, 런타임에 `i18nLanguages.list`로 받아온 **실제 지원 목록과 대조**해
첫 지원 코드를 씁니다(`nl-BE` 미지원 → `nl`). 코드가 겹치면 뒤엣것을 건너뛰고 이유를
보고합니다. 이 해석 로직을 복사해서 두 벌로 만들지 말고 `planLocalizations()`를
재사용하세요.

**CS-v2.6부터 언어의 식별자는 라벨이 아니라 코드입니다.** 번역기의 대상 언어 목록은
하드코딩 배열이 아니라 `GET /api/yt/languages`가 주는 카탈로그(`{code, label}`)이고,
1순위는 `i18nLanguages.list` 공식 목록(API 키 → 없으면 선택된 OAuth 계정 토큰),
실패하면 `lib/ytLanguages.js`의 `FALLBACK_LANGUAGE_CATALOG`(83개, 2026-10 공식 목록과
코드 전부 일치 확인)입니다. 응답의 `source`가 `'youtube' | 'fallback'`입니다.

- 번역 결과에는 `languageCode`가 실리고, `planLocalizations()`는 그 코드를 **먼저** 씁니다.
  위의 라벨 후보 배열(`LANGUAGE_CODE_CANDIDATES`)은 코드가 없는 예전 결과(CS-v2.5 이하
  localStorage)를 위한 하위 호환 경로입니다 — 지우지 마세요. 예전 라벨 → 코드 변환은 서버가
  `legacyLabelCodes`로 내려주므로 후보 배열을 클라이언트에 복제하지 마세요.
- 대상 언어에서 원본 언어는 **아예 빠집니다**(회색 처리 아님). 원본 = 대상 요청은 화면,
  `/translate`·`/regenerate`(400), `planLocalizations()`(원문 언어와 같은 코드는 skipped)
  세 군데에서 막습니다.
- 프리셋(`CORE_PRESET` 등, `tools/yt/app.js`)은 라벨이 아니라 **후보 코드 배열** 목록입니다.
  카탈로그에 실제로 있는 첫 후보를 씁니다.
- (CS-v2.6.1) 예전 "전체 선택"은 새 카탈로그에서도 전체 선택으로 이관합니다
  (`isLegacyFullSelection()`). localStorage의 `languageSelectionVersion` 표식이 이관을
  **1회로** 제한합니다 — 이 표식을 지우거나 저장을 빠뜨리면 사용자가 뺀 언어가 새로고침할
  때마다 다시 전체로 돌아옵니다. 비상 목록(서버 언어 목록 실패) 상태에서는 선택·표식을
  저장하지 않습니다.
- (CS-v2.6.1) 원본 언어와 입력 문자가 어긋나 보이면 경고만 합니다(`detectInputScript()`,
  로컬 휴리스틱, Gemini 호출 없음). 자동으로 원본 언어를 바꾸거나 번역을 막지 마세요.

### 4.5.1 원본 언어와 번역 프롬프트 (CS-v2.6)

`/translate`·`/regenerate`는 `sourceLanguageCode`/`sourceLanguageLabel`을 받습니다(화면
기본값은 `ja`, **요청에 없으면 `ko`** — CS-v2.5 이하 클라이언트는 항상 한국어 원본이었기
때문). 프롬프트는 "The source metadata language is Japanese (ja)."처럼 원본을 명시합니다.

- **6070/7080 연대 규칙과 "첫번째 플레이리스트 → Vol. N" 규칙은 원본이 `ko`일 때만**
  들어갑니다. 규칙은 `buildRuleList()`가 키로 조립하고 번호를 마지막에 매깁니다 — 규칙끼리
  "rule 8 below"처럼 번호로 참조하므로 하드코딩 번호를 다시 쓰지 마세요(`{{rule:key}}`).
  원본이 `ko`일 때의 규칙 문장·번호는 CS-v2.5와 같습니다(2번 규칙의 "[코드] 제외" 문구만 추가).
- 번역 캐시 키(`lib/ytTranslationCache.js`, `CACHE_VERSION` 4)에 원본 언어가 들어가고, 언어는
  라벨이 아니라 코드로 묶습니다. 새 caller가 `sourceLanguage`를 빠뜨리면 다른 원본의 결과가
  캐시 히트로 나옵니다(`scope`와 같은 종류의 함정).
- 원본 언어를 바꾸면 화면의 기존 결과는 비워지고, 유튜브 등록 패널의 원문 언어
  (`snippet.defaultLanguage`)도 같이 바뀝니다.
- **등록을 막는 길이 검증은 여전히 글자 수**(CS-v2.3)입니다. UTF-8 바이트는 dryRun 응답의
  `byteRisks[]`로 **측정·경고만** 합니다(`describeByteRisks()`). 문서상 제한은
  `snippet.description` 5000바이트뿐이고 `localizations.(key).description`에는 제한이 적혀
  있지 않아 `basis: 'documented' | 'undocumented'`로 구분해 보여 줍니다. 실제 영상에 이미
  5,000바이트를 넘는 설명(원문 5,148, th 8,867바이트)이 저장돼 있었습니다 — 실제 쓰기로는
  검증하지 않았으므로, 바이트로 **차단**하려면 거부되는 쓰기 사례를 근거로 먼저 확보하세요.
- 등록은 지금도 `part=snippet,localizations`입니다. 문서상 `part=localizations`만 보내는 것도
  가능하지만, `defaultLanguageNotSet` 오류 조건이 그 경로에서 어떻게 동작하는지 실측 전이라
  바꾸지 않았습니다(원문 설명이 5,000바이트를 넘는 영상이라면 그쪽이 더 안전할 수 있음).

### 4.6 등록 전 길이 검증과 오류 로그 (CS-v2.3)

`/publish-localizations`는 `lib/ytPublishValidation.js`의 `validatePublishPayload()`로
videos.update에 실릴 최종 페이로드(title 100자·description 5000자·tags 합계 500자)를
**보내기 전에** 직접 센다. `localizations`는 항상 existing(기존 등록분) + planned(이번
등록분)를 합친 맵이므로, 이번에 건드리지 않는 예전 등록분이 지금 기준으로 초과여도 같이
걸린다. 문제가 하나라도 있으면 videos.update를 **아예 호출하지 않고** 422로 어떤 언어의
어떤 필드가 몇 자인지 응답한다 — dryRun 응답에도 같은 `problems[]`가 실려서 미리보기
단계에서 "적용" 버튼이 막힌다.

이 검증을 만든 계기: 실제 등록에서 "The request metadata is invalid."가 났는데,
`lib/ytOAuth.js`의 `youtubeApi()`가 그동안 `data.error.errors[]`(구글이 필드별로 주는
`{reason, location, locationType, message}`)를 버리고 `data.error.message` 한 줄만 썼다.
지금은 실패마다 `.yt_errors.log`(gitignore)에 `errors[]` 전문을 남기고, location이 있으면
사용자 메시지에도 같이 보여준다. **단, 확인해 보니 이 클래스의 오류(제목/설명 길이 초과)는
구글이 `location`을 필드별로 주지 않고 `"body"`(전체 요청) 하나로만 준다** — 그래서
`errors[]`를 살리는 것만으로는 어느 필드인지 알 수 없고, 4.6의 사전 검증이 실질적인
해결책이다. `errors[]` 서핑은 위치 정보를 주는 다른 종류의 오류(예: 권한/쿼터 계열)에는
여전히 유효하다.

---

## 5. 비밀 정보

절대 커밋하지 않습니다 (`.gitignore` 확인):

```
.gemini_key  .yt_oauth.json  .timeline-settings.json  .env  .env.local
node_modules/  output/  tools/storyboard/
```

문서나 코드 예시에 **실제 키·토큰·클라이언트 시크릿 값을 적지 마세요.** 새 상태 파일을
만들면 `.gitignore`에 먼저 추가하세요.

---

## 6. 작업 보고 규칙 — 가장 중요

이 프로젝트에서 이미 두 번, 테스트를 전부 통과한 상태로 심각한 버그가 배포됐습니다.
연번 기능은 화면 문자열만 바꾸고 실제 파일명은 그대로였는데 테스트가 화면 문자열만
봤기 때문에 통과했습니다.

그래서:

1. **테스트 통과 개수만 보고하지 마세요.** 그건 완료 보고가 아닙니다.
2. **실제 생성된 출력 샘플을 붙이세요.** 타임라인 텍스트 3줄, API 응답 JSON 전문,
   번역 결과, 조립된 설명란 등 사람이 눈으로 읽고 틀린 걸 알아챌 수 있는 것.
3. **실행해 보지 않고 "동작할 것입니다"라고 쓰지 마세요.** 실행할 수 없는 이유가
   있으면 그 이유를 명시하세요.
4. 외부 API 동작이나 스펙은 **기억에 의존하지 말고** 공식 문서를 확인하고 근거를
   제시하세요.
5. 지시받지 않은 리팩터링을 끼워 넣지 마세요. 필요하다고 판단되면 먼저 제안하세요.

---

## 7. 커밋·버전 관례

- 기능 변경 시 버전을 올립니다: `CS-v1.7`, `CS-v1.8` …
- 커밋 메시지: `feat: 영문 한 줄 요약 (CS-vX.Y)` + 본문에 **왜** 그렇게 했는지.
  `fix:`, `docs:`, `refactor:`도 같은 형식입니다.
- 코드 주석에 `TASK CS-vX.Y` 형태로 결정의 이유를 남기는 것이 이 저장소의 관행입니다.
  "무엇을 하는지"가 아니라 **"왜 이렇게 했는지, 왜 다른 방법을 안 썼는지"**를 씁니다.
  기존 예시: `routes/timeline.js` 상단 블록, `lib/ytOAuth.js` 상단 블록,
  `routes/yt.js`의 `videos.update` 설명 블록.
- 커밋 이력을 rebase/squash로 고쳐쓰지 마세요.
- `git push --force`는 사용자 확인 없이 실행하지 마세요.

---

## 8. 로드맵

`docs/ROADMAP.md`에 지시문 11개가 순서대로 있습니다. 한 지시문 = 한 작업 = 한 커밋이
원칙입니다. 여러 개를 한 번에 처리하지 마세요.
