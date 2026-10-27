# Notion × 그래프뷰 노트 웹앱 (공개 저장소 보안 암호화 지원)

> 노션(Notion) 데이터베이스의 노트를 옵시디언(Obsidian) 스타일의 인터랙티브 지식 그래프로 시각화하고 열람하는 웹 애플리케이션입니다.  
> **GitHub 저장소가 완전 공개(Public) 상태로 운영되더라도 개인정보 및 노트 내용이 100% 안전하게 보호되도록 영지식(Zero-Knowledge) 클라이언트 사이드 암호화**가 적용되어 있습니다.

---

## 🔒 공개 저장소 보안 아키텍처

```
[Notion Database]
       │
       ▼ (Notion API - 토큰은 GitHub Secrets에만 존재)
[GitHub Actions (scripts/sync.mjs)]
       │
       ├─ 노트 목록 & 본문 수집 (메모리 상에서만 처리)
       ├─ gzip 압축 → AES-256-GCM 암호화 (PBKDF2 600,000회 반복)
       ▼
[GitHub Pages 배포 아티팩트]
       ├─ data/meta.json   : 암호화 메타데이터 (salt, 반복횟수만 포함, 개인정보 0)
       ├─ data/graph.enc   : 전체 그래프 노드/엣지 (바이너리 암호문)
       ├─ data/search.enc  : 전문 검색 색인 (바이너리 암호문)
       └─ data/n/*.enc     : 개별 노트 본문 Markdown (바이너리 암호문)
       │
       ▼ (인터넷 공개 호스팅)
[브라우저 웹앱 (web/)]
       └─ 사용자가 패스프레이즈 입력 → Web Crypto API로 메모리 상에서만 복호화
```

### 개인정보 및 보안 핵심 원칙
1. **API 토큰 비공개**: `NOTION_TOKEN`과 `DATA_SOURCE_ID`는 Git 저장소에 절대 커밋되지 않으며, 오직 GitHub Actions의 암호화된 Secrets 환경변수로만 전달됩니다.
2. **저장소 및 Pages 파일 전수 암호화**: 배포되는 모든 노트 데이터(`.enc`)는 **PBKDF2-SHA256 (600,000회) + AES-256-GCM**으로 암호화되어 공개 저장소나 Pages URL을 열어보아도 평문 텍스트가 단 한 글자도 노출되지 않습니다.
3. **무차별 대입(Brute-force) 방어**: 600,000회 반복 연산으로 고성능 GPU 기반 해시 역산 공격을 원천 차단합니다. (16자 이상의 안전한 패스프레이즈 사용 권장)
4. **XSS 방어**: 본문 마크다운 렌더링 시 `DOMPurify`로 새니타이징 처리되어 악성 스크립트 실행을 방지합니다.

---

## 📋 1. Notion 데이터베이스 구성

노션에 데이터베이스를 1개 생성하고 아래 속성명을 **정확히 동일하게** 생성해 주세요:

| 속성명 | 타입 | 설명 |
|---|---|---|
| **`이름`** | Title | 노트 제목 (그래프 노드 라벨) |
| **`연결`** | Relation | **자기 자신 DB를 참조**하는 관계형 속성 (노트 간 연결선) |
| **`태그`** | Multi-select | 태그 필터 및 분류 |
| **`폴더`** | Select | 범주 분류 (노드 고유 색상 매핑) |
| **`요약`** | Text (선택) | 검색 및 미리보기 보조 |

> **노션 설정 팁**:
> 1. 노션 설정 → [통합(Integrations)](https://www.notion.so/profile/integrations)에서 새 내부 통합을 생성하여 `API 토큰`을 발급받습니다.
> 2. 해당 노션 DB 페이지 우측 상단 `···` → `연결(Connections)`에서 생성한 통합을 추가합니다.
> 3. DB 페이지 설정에서 *Manage data sources* → *Copy data source ID*를 복사합니다.

---

## 🚀 2. GitHub 저장소 및 배포 설정 (3분 셋업)

### Step 1. 저장소 생성 및 푸시
이 저장소 코드를 GitHub에 Public(또는 Private)으로 푸시합니다.
```bash
git init
git add .
git commit -m "feat: Notion Graph Notes initial commit"
git branch -M main
git remote add origin https://github.com/<사용자ID>/notion-graph-notes.git
git push -u origin main
```

### Step 2. GitHub Secrets 등록
저장소의 **Settings** → **Secrets and variables** → **Actions** → **New repository secret**에서 다음 3가지 항목을 등록합니다:

| 시크릿 이름 | 내용 |
|---|---|
| `NOTION_TOKEN` | 노션 내부 통합 시크릿 키 (`secret_...`) |
| `DATA_SOURCE_ID` | 노션 데이터 소스 ID (또는 DB ID) |
| `DATA_PASSPHRASE` | 암호화 비밀번호 (**웹 접속 시 입력할 비밀번호**, 16자 이상 권장) |

### Step 3. GitHub Pages 설정
저장소의 **Settings** → **Pages** → **Build and deployment**:
- **Source**: `GitHub Actions` 선택

### Step 4. 최초 동기화 실행
- 저장소의 **Actions** 탭으로 이동 → `sync-deploy` 워크플로 선택 → **Run workflow** 클릭
- 빌드가 완료되면 Pages URL(`https://<사용자ID>.github.io/notion-graph-notes/`)이 생성됩니다.
- 사이트에 접속하여 설정한 `DATA_PASSPHRASE`를 입력하면 그래프가 열립니다!

> **동기화 주기**: 이후 30분마다 노션의 변경사항이 자동으로 감지되어 증분 빌드(수정된 노트만 갱신) 배포됩니다.

---

## 💻 3. 로컬 테스트 및 개발 방법

실제 노션 API 키 없이도 로컬에서 즉시 모의 데이터로 웹앱을 테스트할 수 있습니다.

### 모의(Mock) 암호화 데이터 생성 및 로컬 서버 실행
```bash
# 1. 모의 암호화 데이터 생성 (기본 패스프레이즈: test-passphrase-1234)
npm run mock

# 2. 복호화 정상/비정상 검증 테스트 실행
npm run verify

# 3. web 정적 파일 dist로 복사
Copy-Item -Recurse -Force web\* dist\

# 4. 로컬 웹 서버 실행
npm run serve
```
브라우저에서 `http://localhost:8080`에 접속한 뒤, 패스프레이즈에 `test-passphrase-1234`를 입력하여 그래프 뷰어와 노트를 테스트할 수 있습니다.

### 실제 노션 API와 로컬 연동 시
1. `.env.example`을 복사하여 `.env` 생성:
   ```env
   NOTION_TOKEN=secret_your_token
   DATA_SOURCE_ID=your_data_source_id
   DATA_PASSPHRASE=your_secret_passphrase
   ```
2. 동기화 실행:
   ```bash
   npm run sync
   ```

---

## 🛠️ 주요 기능

- **2D 물리 시뮬레이션 지식 그래프**: Force-Directed 그래프로 노트 클러스터와 연결선 탐색
- **연결선(이웃) 하이라이트**: 특정 노드 클릭 시 직결된 이웃 노드만 밝게 표시되고 나머지는 디밍(Dimming)
- **우측 슬라이딩 사이드바**: 클릭한 노드의 마크다운 본문 파싱, XSS 방지 새니타이징, "Notion에서 열기" 바로가기
- **실시간 전문 검색 (FlexSearch)**: 제목, 본문, 태그, 폴더 인메모리 전문 검색 및 그래프 동적 필터링
- **폴더 & 태그 필터링**: 원하는 주제 노드만 즉시 선별
- **영지식 복호화 및 세션 보존**: 브라우저 로컬 저장소 선택 저장 기능 및 즉시 다시 잠그기(로그아웃) 지원
