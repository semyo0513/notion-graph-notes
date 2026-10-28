# Notion × 그래프뷰 노트 웹앱 (프록시 불필요 · 완전 암호화판)

> 노션(Notion) 데이터베이스의 노트를 옵시디언(Obsidian) 스타일의 인터랙티브 지식 그래프로 시각화하고 열람하는 웹 애플리케이션입니다.  
> **CORS 프록시나 외부 서버가 전혀 필요 없으며, GitHub Actions를 통해 오직 Notion 공식 API와 직접 통신합니다.**  
> 모든 노트 데이터는 **AES-256-GCM**으로 완전 암호화되어 배포되므로, 깃허브 저장소가 공개(Public) 상태여도 개인정보가 100% 안전하게 보호됩니다.

---

## 🔒 작동 구조 (프록시 0개)

```
[Notion API]
       │ (CORS 제약이 없는 GitHub Actions 서버 환경에서 직접 통신)
       ▼
[GitHub Actions (scripts/sync.mjs)]
       │
       ├─ Notion API 직접 조회 (토큰은 GitHub Secrets에만 안전하게 보관)
       ├─ 노트 본문 & 관계망 수집 → gzip 압축 → AES-256-GCM 암호화
       ▼
[GitHub Pages 정적 사이트]
       │
       ▼ (웹 접속)
[사용자 웹 브라우저]
       └─ 프록시 입력 전혀 없이, 설정한 '패스프레이즈(비밀번호)'만 입력하면 즉시 복호화되어 열람!
```

---

## 🚀 3분 배포 가이드

### 1단계: 노션 데이터베이스 준비
1. 노션 설정 → [통합(Integrations)](https://www.notion.so/profile/integrations)에서 새 내부 통합을 생성하고 **API 토큰 (`ntn_...` 또는 `secret_...`)**을 발급받습니다.
2. 그래프로 볼 **노션 데이터베이스 페이지**로 이동합니다.
3. **[가장 중요]** 페이지 우측 상단 **`···`** 클릭 ➔ **`연결(Connections)`** ➔ 생성한 통합 봇을 반드시 추가합니다.
4. 해당 노션 DB의 웹 주소 URL(또는 ID)을 복사합니다. (예: `https://app.notion.com/p/...`)

---

### 2단계: GitHub Secrets 3개 등록
저장소의 **Settings** ➔ **Secrets and variables** ➔ **Actions** ➔ **New repository secret**에서 다음 3가지를 등록합니다:

| 시크릿 이름 (Name) | 내용 (Secret) |
|---|---|
| `NOTION_TOKEN` | 노션 API 토큰 (`ntn_...` 또는 `secret_...`) |
| `DATA_SOURCE_ID` | 노션 DB URL (`https://app.notion.com/p/...` 전체 그대로 붙여넣어도 자동 처리됨) |
| `DATA_PASSPHRASE` | 웹 접속 시 입력할 **비밀번호** (16자 이상 안전한 문장 권장) |

---

### 3단계: GitHub Pages 활성화 및 최초 동기화
1. 저장소의 **Settings** ➔ **Pages**로 이동합니다.
2. **Build and deployment** ➔ **Source**를 `GitHub Actions`로 선택합니다.
3. 저장소 상단의 **Actions** 탭으로 이동합니다.
4. 좌측의 **`sync-deploy`** 워크플로를 클릭 ➔ 우측의 **`Run workflow`** 버튼을 누릅니다.
5. 1~2분 뒤 빌드가 완료되면 배포된 주소(`https://semyo0513.github.io/notion-graph-notes/`)로 접속합니다.
6. 등록하신 `DATA_PASSPHRASE` 비밀번호를 입력하면 바로 지식 그래프가 펼쳐집니다!

> **자동 동기화**: 이후 노션에서 내용을 수정하시면 30분마다 GitHub Actions가 자동으로 변경사항을 감지하여 암호화 배포합니다. (즉시 반영하고 싶을 때는 Actions 탭에서 `Run workflow` 클릭)
