# Notion × 그래프뷰 노트 웹앱 — 최단 경로 구현 계획 (GAS 미사용판)

> 작성일: 2026-10-28 / 기준 API: `Notion-Version: 2026-03-11` (공식 문서 확인 시점 최신)
> 구성: **Notion → GitHub Actions(정기 동기화·암호화) → GitHub Pages(정적 사이트)** / 백엔드 서버 없음

---

## 0. 결론 (한눈에)

```
[Notion DB]
    │  Notion API (토큰 = GitHub Secret, 브라우저에는 없음)
    ▼
[GitHub Actions]  scripts/sync.mjs
    │  ① 노트 목록 조회 → ② 변경된 노트 본문(Markdown) 수집
    │  ③ gzip → AES-GCM 암호화 → dist/data/*.enc
    ▼
[GitHub Pages 정적 사이트]  ◀── 브라우저: 패스프레이즈 입력 → 복호화 → 그래프·검색·사이드바
```

| 핵심 결정 | 이유 |
|---|---|
| **서버 대신 "빌드 시점 동기화"** | 정적 사이트는 토큰을 숨길 수 없음 → 토큰은 Actions에서만 사용하고, 결과 데이터만 배포 |
| **데이터는 암호화해서 배포** | GitHub Pages 사이트는 저장소가 비공개여도 **인터넷에 공개**됨 (공식 문서). 평문 JSON 배포 금지 |
| **본문 전체를 빌드 때 수집** | Actions는 GAS의 6분 실행 제한이 없어 본문 전수 수집 가능 → 정적 서빙 + 본문 전문검색까지 가능 |
| **증분 빌드** | 이전 암호화 산출물을 캐시 → `last_edited_time`이 바뀐 노트만 본문 재호출 |
| **편집은 Notion에서, 앱은 그래프 뷰어** | 정적 사이트는 안전하게 쓰기 불가 (Phase 2 대안은 7장) |

### GAS판 대비 달라지는 점

| 항목 | GAS판 | 이번 수정판 |
|---|---|---|
| 토큰 보관 | GAS 스크립트 속성 | GitHub Secrets |
| 데이터 갱신 | 접속 시 실시간 | **주기 동기화 (지연 있음)** |
| 본문 전문검색 | Phase 3 | **MVP 포함 가능** |
| 앱에서 노트 쓰기 | Phase 2 가능 | **불가** (Notion에서 편집) |
| 접근 제어 | APP_KEY | **패스프레이즈 복호화** |
| 추가 플랫폼 | GAS | 없음 (GitHub만) |

### 검토한 대안 (GAS 제외)

| 방식 | 토큰 위치 | 실시간 | 쓰기 | 평가 |
|---|---|---|---|---|
| **GitHub Actions 정적 빌드** | GitHub Secrets | 주기 갱신 | 불가 | **채택** — 추가 플랫폼 0, 요구사항(깃허브 배포) 충족 |
| 서버리스 프록시 (Cloudflare Workers / Vercel 등) | 서비스 환경변수 | 실시간 | 가능 | Phase 2 대안 (신규 계정·플랫폼 필요) |
| 브라우저에서 토큰 직접 입력 후 호출 | 사용자 브라우저 | 실시간 | 가능 | 비권장 — 토큰이 브라우저에 상주, CORS 가능성 미확인 |
| 로컬 exe (Tauri/Electron) | 로컬 PC | 실시간 | 가능 | 웹 배포가 아님 (기존 exe 계획과 결합 가능) |

---

## 1. 기능분석

### MVP

| # | 기능 | 구현 방식 |
|---|---|---|
| 1 | Notion DB → 그래프 표시 | `graph.enc`(노드+엣지) 복호화 → force-graph(Canvas) |
| 2 | 노드 클릭 → 사이드바에 노트 열람 | `n/<id>.enc` 1개만 로드·복호화 → marked + DOMPurify |
| 3 | 연결된 노트만 강조 | 클릭 노드의 이웃 집합 계산, 나머지 dim |
| 4 | 키워드 검색 → 관련 노드 강조 | `search.enc`(제목·태그·폴더·요약·본문 앞부분) → FlexSearch |
| 5 | 폴더·태그 필터 | Notion `폴더`(select), `태그`(multi-select) |
| 6 | "Notion에서 열기" 버튼 | API 응답의 `url` 값을 **그대로** 사용 (URL 파싱 금지) |
| 7 | 접근 제어 | 패스프레이즈 → PBKDF2 → AES-GCM 복호화 (실패 시 데이터 열람 불가) |

### 후순위

| 단계 | 기능 |
|---|---|
| Phase 2 | 앱에서 쓰기(노트 생성·연결·폴더 변경) — 7장의 대안 중 택1 |
| Phase 3 | 본문 내 멘션/링크 기반 엣지 (M0에서 `/markdown` 링크 표기 확인 후), Gemini RAG, PWA 오프라인 |

> **한계 명시**: 갱신은 Actions 실행 주기에 따름. 스케줄은 **best-effort**(수 분~수십 분 지연 가능, 5분 미만 불가). 즉시 반영이 필요하면 Actions 탭에서 수동 실행(Run workflow).

---

## 2. Notion 데이터 구조 (시트 구조 대응)

노트용 **데이터베이스 1개**. 속성명은 코드가 이 이름으로 읽으므로 **정확히 일치**시킬 것.

| 속성명 | 타입 | 용도 |
|---|---|---|
| `이름` | Title | 노트 제목 (노드 라벨) |
| `연결` | Relation → **같은 DB (자기 참조)** | 노트 간 연결선. 자기 참조 시 역방향 속성이 자동 생성되므로 `연결`만 읽고 중복 제거 |
| `태그` | Multi-select | 필터·검색·색상 |
| `폴더` | Select | 범주 분류 |
| `요약` | Text (선택) | 검색·사이드바 미리보기 |

**Notion 측 준비**
1. 위 속성으로 DB 생성
2. 내부 통합(Integration) 생성 → 토큰 발급
3. DB 페이지 `···` → 연결(Connections)에서 통합 추가 (**누락 시 404**)
4. **데이터소스 ID** 확보: DB 설정 → *Manage data sources* → *Copy data source ID*
   (2025-09-03부터 쿼리는 `POST /v1/data_sources/{id}/query`)

> ⚠️ **민감정보 주의**: 사이트와 암호화 파일은 인터넷에 공개되므로, 학생 개인정보 등 민감한 내용은 이 DB에 넣지 말 것. 암호화는 강한 패스프레이즈를 전제로 함(5장 참고).

---

## 3. 구조 · 파일 · 데이터 형식

### 저장소 구조 (`notion-graph-notes`, **public** — Pages 무료 사용 조건)

```
notion-graph-notes/
├─ .github/workflows/sync-deploy.yml   # 동기화 + Pages 배포
├─ scripts/sync.mjs                    # Notion → 암호화 데이터 (Node 내장 fetch/crypto, npm 의존성 없음)
├─ web/
│  ├─ index.html
│  ├─ css/style.css
│  └─ js/
│     ├─ crypto.js    # 복호화 (sync.mjs와 동일 규격)
│     ├─ data.js      # 데이터 로드·캐시
│     ├─ graph.js     # force-graph 렌더·강조·필터
│     ├─ search.js    # FlexSearch
│     └─ sidebar.js   # 본문 렌더 (marked + DOMPurify)
└─ .gitignore                          # dist/ 제외
```

### 빌드 산출물 (`dist/data/`, 저장소에 커밋하지 않음)

| 파일 | 내용 | 비고 |
|---|---|---|
| `meta.json` | `{v, salt(base64), iter, builtAt}` | 평문 (비밀 아님, 복호화에 salt 필요) |
| `graph.enc` | `{nodes:[{id,title,tags,folder,url,edited}], edges:[[a,b]]}` | 가장 먼저 로드 |
| `search.enc` | `[{id, text}]` (본문 앞 약 3,000자) | 로드 후 FlexSearch 인덱스 생성 |
| `n/<id>.enc` | `{md}` (본문 Markdown) | 노드 클릭 시 1개만 로드 |

- 모든 `.enc` = **gzip → AES-256-GCM** (파일 앞 12바이트 = IV), 키 = **PBKDF2-SHA256**(패스프레이즈, salt, 600,000회)
- 노트 수정시각(`edited`)은 `graph.enc` 안에만 존재 → 증분 판단은 이전 `graph.enc`를 복호화해 수행 (평문 manifest 없음)

---

## 4. 핵심 코드 골격

### 4-1. 워크플로 `.github/workflows/sync-deploy.yml`

```yaml
name: sync-deploy
on:
  schedule:
    - cron: '23,53 * * * *'      # 30분 간격 (정각 회피: 정각은 지연이 가장 심함)
  workflow_dispatch:              # 수동 실행 (Actions 탭 / GitHub 모바일 앱)
  push:
    branches: [main]
permissions:                      # 최소 권한
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }

      # 이전 "암호화된" 산출물 복원 (평문은 캐시에 남지 않음)
      - uses: actions/cache@v4
        with:
          path: dist/data
          key: data-${{ github.run_id }}
          restore-keys: data-

      - name: Notion 동기화 + 암호화
        env:
          NOTION_TOKEN:    ${{ secrets.NOTION_TOKEN }}
          DATA_SOURCE_ID:  ${{ secrets.DATA_SOURCE_ID }}
          DATA_PASSPHRASE: ${{ secrets.DATA_PASSPHRASE }}
        run: node scripts/sync.mjs

      - run: cp -r web/* dist/
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.d.outputs.page_url }}
    steps:
      - id: d
        uses: actions/deploy-pages@v4
```

- `pull_request` 계열 트리거는 **넣지 않음** (Secrets 노출 방지)
- 액션 버전(`@v4` 등)은 배포 전에 각 액션 릴리스 페이지에서 최신 메이저 확인

### 4-2. `scripts/sync.mjs` (핵심부 · Node 22)

```javascript
// Notion → 암호화 정적 데이터. 의존성 없음(Node 내장 fetch/crypto/zlib).
import { webcrypto as crypto } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';

const { NOTION_TOKEN, DATA_SOURCE_ID, DATA_PASSPHRASE } = process.env;
if (!NOTION_TOKEN || !DATA_SOURCE_ID || !DATA_PASSPHRASE) throw new Error('환경변수 누락');

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const OUT = 'dist/data';
const ITER = 600000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const te = new TextEncoder(), td = new TextDecoder();
const b64 = u8 => Buffer.from(u8).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const exists = p => fs.access(p).then(() => true, () => false);

/* ───── Notion 호출: 429/529 → Retry-After 준수 재시도 (토큰·응답 본문은 로그에 출력하지 않음) ───── */
async function notion(method, path, body) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(NOTION + path, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 429 || res.status === 529) {
      await sleep(Math.min(Number(res.headers.get('retry-after') || 1), 30) * 1000 + i * 300);
      continue;
    }
    if (res.ok) return res.json();
    throw new Error(`Notion ${res.status} ${method} ${path.split('?')[0]}`);
  }
  throw new Error('rate_limited');
}

/* ───── 암호화 (브라우저 js/crypto.js와 동일 규격) ───── */
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, text) {                       // 문자열 → gzip → AES-GCM → [IV(12)|암호문]
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gzipSync(te.encode(text))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}
async function open(key, buf) {
  const iv = buf.subarray(0, 12), ct = buf.subarray(12);
  return td.decode(gunzipSync(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))));
}

/* ───── 노트 목록 (노트 100개당 1회 호출) ───── */
async function queryAll() {
  const nodes = []; let cursor = null;
  do {
    const r = await notion('POST', `/data_sources/${DATA_SOURCE_ID}/query`,
      { page_size: 100, ...(cursor && { start_cursor: cursor }) });
    for (const p of r.results) nodes.push(toNode(p));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return nodes;
}
function toNode(p) {                                   // 속성명은 2장 표와 일치해야 함
  const P = p.properties || {};
  return {
    id: p.id,
    title: ((P['이름']?.title) || []).map(t => t.plain_text).join('') || '(제목 없음)',
    tags: ((P['태그']?.multi_select) || []).map(t => t.name),
    folder: P['폴더']?.select?.name || '',
    summary: ((P['요약']?.rich_text) || []).map(t => t.plain_text).join(''),
    links: ((P['연결']?.relation) || []).map(r => r.id),
    url: p.url,
    edited: p.last_edited_time
  };
}
function buildEdges(nodes) {                           // 무방향 중복 제거, 존재하지 않는 id 무시
  const ids = new Set(nodes.map(n => n.id)), seen = new Set(), edges = [];
  for (const n of nodes) for (const t of n.links) {
    if (!ids.has(t)) continue;
    const k = n.id < t ? `${n.id}|${t}` : `${t}|${n.id}`;
    if (!seen.has(k)) { seen.add(k); edges.push([n.id, t]); }
  }
  return edges;
}

/* ───── 메인 ───── */
async function main() {
  await fs.mkdir(`${OUT}/n`, { recursive: true });

  // 1) salt 재사용(있으면) → 키 생성 → 이전 graph.enc 복호화로 "이전 edited 목록" 복원
  const prevMeta = await fs.readFile(`${OUT}/meta.json`, 'utf8').then(JSON.parse, () => null);
  const salt = prevMeta ? unb64(prevMeta.salt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(DATA_PASSPHRASE, salt);
  let prev = new Map();
  try {
    const g = JSON.parse(await open(key, await fs.readFile(`${OUT}/graph.enc`)));
    prev = new Map(g.nodes.map(n => [n.id, n.edited]));
  } catch { /* 첫 빌드 또는 패스프레이즈 변경 → 전체 재수집 */ }

  // 2) 노트 목록
  const nodes = await queryAll();

  // 3) 변경된 노트만 본문 수집 (호출 간격 ≈340ms → 평균 3 req/s 이하)
  let fetched = 0;
  for (const n of nodes) {
    const f = `${OUT}/n/${n.id}.enc`;
    if (prev.get(n.id) === n.edited && await exists(f)) continue;
    const { markdown } = await notion('GET', `/pages/${n.id}/markdown`);
    await fs.writeFile(f, await seal(key, JSON.stringify({ md: markdown })));
    fetched++; await sleep(340);
  }

  // 4) 삭제된 노트 파일 정리
  const live = new Set(nodes.map(n => `${n.id}.enc`));
  for (const f of await fs.readdir(`${OUT}/n`)) if (!live.has(f)) await fs.unlink(`${OUT}/n/${f}`);

  // 5) 검색 인덱스용 텍스트 (본문은 저장된 파일에서 복호화해 사용)
  const search = [];
  for (const n of nodes) {
    const { md } = JSON.parse(await open(key, await fs.readFile(`${OUT}/n/${n.id}.enc`)));
    const body = md.replace(/[#>*_`\[\]()!|-]+/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);  // 단순화 처리
    search.push({ id: n.id, text: [n.title, n.tags.join(' '), n.folder, n.summary, body].join(' ') });
  }

  // 6) 저장 (graph에는 links/summary 제외한 경량 노드 + edges)
  const slim = nodes.map(({ links, summary, ...rest }) => rest);
  await fs.writeFile(`${OUT}/graph.enc`, await seal(key, JSON.stringify({ nodes: slim, edges: buildEdges(nodes) })));
  await fs.writeFile(`${OUT}/search.enc`, await seal(key, JSON.stringify(search)));
  await fs.writeFile(`${OUT}/meta.json`,
    JSON.stringify({ v: 1, salt: b64(salt), iter: ITER, builtAt: new Date().toISOString() }));

  console.log(`노트 ${nodes.length}개 / 본문 재수집 ${fetched}개`);   // 건수만 출력
}
main().catch(e => { console.error(String(e.message)); process.exit(1); });
```

### 4-3. 브라우저 `web/js/crypto.js` + 로드 흐름

```javascript
// sync.mjs와 동일 규격: PBKDF2-SHA256(600,000) → AES-GCM, [IV(12)|암호문], gzip
export async function deriveKey(pass, saltB64, iter) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);          // 비추출(non-extractable) 키
}
export async function openFile(key, url) {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
```

```javascript
// 시작 흐름: meta → 키 도출 → graph 복호화(패스프레이즈 검증) → 렌더 → search 백그라운드 로드
const meta = await (await fetch('data/meta.json', { cache: 'no-cache' })).json();
const key = await deriveKey(passphrase, meta.salt, meta.iter);
const v = encodeURIComponent(meta.builtAt);                     // 빌드 갱신 시 캐시 무효화
const graph = await openFile(key, `data/graph.enc?v=${v}`);     // 복호화 실패 = 패스프레이즈 오류
renderGraph(graph);
openFile(key, `data/search.enc?v=${v}`).then(buildSearchIndex);
// 노드 클릭: openFile(key, `data/n/${id}.enc?v=${encodeURIComponent(node.edited)}`) → DOMPurify.sanitize(marked.parse(md))
```

- 복호화된 키는 `CryptoKey`(비추출)로만 보관. 패스프레이즈를 저장하려면 "이 기기에서 기억" 체크 시에만 저장(선택)
- 라이브러리(force-graph, FlexSearch, marked, DOMPurify)는 CDN **정확한 버전 고정**

---

## 5. 단계별 실행 계획 (순서 = 최단 경로)

| 단계 | 작업 | 완료 기준 (DoD) |
|---|---|---|
| **M0** | Notion DB·통합·데이터소스 ID 준비 → 로컬 스모크 테스트 | ① 데이터소스 쿼리 200 ② 노트 1개 `/markdown` 200 ③ 응답에서 `연결`(relation)·`url` 확인 |
| **M1** | `sync.mjs` **로컬 실행** → `dist/data` 생성 | `.enc` 파일 생성, 파일을 열어도 평문 없음, 재실행 시 "본문 재수집 0개"(증분 동작) |
| **M2** | 프론트(`web/`): 복호화 + 그래프 + 사이드바 + 검색 (로컬 서버로 확인) | 패스프레이즈 오류 시 거부, 정상 시 그래프·노드 클릭 본문·이웃 강조·검색 강조 |
| **M3** | GitHub 저장소 + Secrets 등록 + 워크플로 → Pages 배포 | 공개 URL에서 패스프레이즈 입력 후 동작, 모바일 확인, 수동 실행으로 갱신 확인 |
| **M4** | 성능 점검 (노트 1,000개) | 첫 렌더·검색 체감 지연 없음 (기존 목표: 50~60FPS, 검색 50ms 이내) |
| **Phase 2** | 쓰기 기능 필요 시 7장 대안 | — |

**로컬 테스트 방법 (Windows PowerShell)**
```powershell
$env:NOTION_TOKEN="발급한_토큰"; $env:DATA_SOURCE_ID="데이터소스_ID"; $env:DATA_PASSPHRASE="16자_이상_무작위_문장"
node scripts/sync.mjs
Copy-Item -Recurse -Force web\* dist\
cd dist; python -m http.server 8080      # 브라우저: http://localhost:8080 (file:// 는 fetch 불가)
```

---

## 6. 배포 방법

1. **저장소 생성**: `notion-graph-notes` (**public**) → 파일 업로드
2. **Secrets 등록**: Settings → Secrets and variables → Actions → `NOTION_TOKEN`, `DATA_SOURCE_ID`, `DATA_PASSPHRASE`
   - `DATA_PASSPHRASE`는 브라우저에서 입력할 문구와 동일 (**16자 이상 무작위** 권장)
3. **Pages 설정**: Settings → Pages → Source = **GitHub Actions**
4. **최초 실행**: Actions 탭 → `sync-deploy` → Run workflow (첫 빌드는 본문 전수 수집이라 오래 걸림)
5. 발급된 `https://<계정>.github.io/notion-graph-notes/` 접속 → 패스프레이즈 입력
6. **확인**: 개발자도구 Network·저장소 어디에도 Notion 토큰·평문 노트가 없는지 점검

**운영 주의**
- 패스프레이즈 변경 시: Secret 수정 → 캐시 불일치로 **자동 전체 재수집**(첫 빌드와 동일 시간)
- **60일 비활동 시 스케줄이 자동 비활성화**될 수 있음 (커밋이 없으면) → 가끔 코드 커밋하거나 Actions 탭에서 재활성화
- 스케줄이 불안정해 보이면 `workflow_dispatch`(수동 실행)를 기본 수단으로 사용

---

## 7. Phase 2 — 앱에서 쓰기가 꼭 필요할 때

정적 사이트에 토큰을 둘 수 없으므로 아래 중 택1. (GAS 외 선택지)

| 대안 | 방식 | 트레이드오프 |
|---|---|---|
| A. Notion에서 편집 (기본) | 앱의 "Notion에서 열기" 버튼 | 추가 작업 0, 앱은 뷰어 |
| B. 서버리스 프록시 | Cloudflare Workers / Vercel 함수 등에 토큰 보관 | 실시간 읽기·쓰기 가능하나 신규 플랫폼·계정 필요 |
| C. 로컬 exe | Tauri/Electron에서 토큰을 로컬 보관, Notion 직접 호출 | 웹 배포 아님, 기존 exe 계획과 결합 |

> 쓰기 구현 시 공통 주의: `연결`(relation) 수정은 기존 목록을 읽어 **병합 후 전체 전송** (일부만 보내면 덮어쓰기). 2025-09-03 이후 페이지 생성 시 parent가 데이터소스 기준인지 공식 레퍼런스로 확인.

---

## 8. 보안 · 성능 체크리스트

| 구분 | 항목 |
|---|---|
| 보안 | 토큰·패스프레이즈는 **Secrets에만** 보관, 코드·로그·커밋에 출력 금지 (`sync.mjs`는 건수만 출력) |
| 보안 | 워크플로는 `push`/`schedule`/`workflow_dispatch`만 사용, 권한 최소화, `pull_request_target` 금지 |
| 보안 | **오프라인 무차별 대입 위험**: 암호문이 공개되므로 패스프레이즈가 약하면 뚫릴 수 있음 → 16자 이상 무작위. 노트 수·파일 크기는 외부에서 추정 가능 |
| 보안 | 본문 렌더 시 DOMPurify 필수, CDN·액션 버전 고정 |
| 성능 | 레이트리밋: 연결당 평균 3 req/s (공식). 429/529 → `Retry-After` 준수 재시도 |
| 성능 | 노트 1,000개 = 목록 약 10회 + 본문 약 1,000회 → **첫 전수 빌드 약 6~15분 (추정)**, 이후는 변경분만 |
| 성능 | 클릭 시 1파일만 로드(수 KB), 파일 URL에 `?v=edited`를 붙여 브라우저 캐시 활용 |
| 성능 | 캐시 유실 시 전체 재수집으로 자동 복구 (동작은 정상, 시간만 증가) |
| 성능 | 변경 없음에도 30분마다 배포되므로 필요 시 주기를 1~3시간으로 완화 |

---

## 9. 검증 필요 항목 (확인 전까지 가정으로만 취급)

| # | 항목 | 확인 방법 | 상태 |
|---|---|---|---|
| 1 | `/markdown` 응답의 **링크·멘션 표기** (Notion-flavored) | M0에서 실제 노트 3~5개 호출. 비표준 태그는 DOMPurify가 제거할 수 있음 → 렌더러 보정 또는 블록 API 폴백 | **M0 필수** |
| 2 | Relation 값이 많을 때 페이지 객체에 **전부 포함되는지** (`has_more`) | 연결 많은 노트로 테스트 | M0 |
| 3 | Actions 잡 최대 실행시간, 캐시 보존 정책(미접근 시 삭제 등) | GitHub Docs 확인 | M3 전 |
| 4 | 사용 액션 최신 메이저 버전 (`checkout`, `setup-node`, `cache`, `configure-pages`, `upload-pages-artifact`, `deploy-pages`) | 각 릴리스 페이지 | M3 전 |
| 5 | `DecompressionStream('gzip')` 지원 범위 | 대상 기기(학교 PC·모바일 브라우저)에서 실제 테스트, 미지원 시 pako 폴백 또는 비압축 | M2 |
| 6 | PBKDF2 600,000회의 모바일 도출 시간 | 실기기 측정 (과하면 iter 조정 후 전체 재빌드) | M2 |

---

## 10. 확정된 공식 사항 (근거)

| 사항 | 내용 |
|---|---|
| 최신 API 버전 | `2026-03-11` (`archived`→`in_trash` 이름 변경 등. MVP는 영향 적음) |
| 데이터베이스 구조 | 2025-09-03부터 DB = 컨테이너, 쿼리는 `/v1/data_sources/{id}/query` |
| Markdown 읽기 | `GET /v1/pages/:page_id/markdown` — 내부 통합에서도 사용 가능 |
| 레이트리밋 | 연결당 평균 3 req/s, 429/529 시 `Retry-After` 존중 |
| Pages 공개 | Pages 사이트는 **저장소가 비공개여도 공개** (플랜/조직 설정에 따름), 무료 플랜은 public 저장소에서 사용 |
| Pages 배포 | `actions/upload-pages-artifact` + `actions/deploy-pages` 로 커밋 없이 배포 가능 |
| 스케줄 | 최소 5분 간격, 고부하 시 지연 가능(best-effort), **60일 저장소 비활동 시 자동 비활성화** |

**참고 문서**
- Notion 버전 관리: https://developers.notion.com/reference/versioning
- Notion 2025-09-03 업그레이드: https://developers.notion.com/docs/upgrade-guide-2025-09-03
- Notion 2026-03-11 업그레이드: https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11
- Notion 요청 제한: https://developers.notion.com/reference/request-limits
- Notion 페이지 Markdown 조회: https://developers.notion.com/reference/retrieve-page-markdown
- GitHub Pages 게시 소스 설정: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

---

## 11. 다음 요청 시 제공 가능한 산출물

M0 스모크 테스트 후 → **`sync-deploy.yml` + `sync.mjs` + `web/` 전체 파일 완성본**을 "기능분석 → DB 구조 → 전체코드 → 배포방법" 순서로 제공.
M0 ①번(`/markdown` 실제 응답 샘플 1개)을 붙여주시면 렌더러를 실제 형식에 맞춰 확정할 수 있음.
