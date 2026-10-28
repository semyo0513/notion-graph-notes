# Notion × 그래프뷰 노트 웹앱 (클라이언트 로컬 직접 입력판)

> 노션(Notion) 데이터베이스의 노트를 옵시디언(Obsidian) 스타일의 인터랙티브 지식 그래프로 시각화하고 열람하는 웹 애플리케이션입니다.  
> **GitHub 저장소와 서버에는 순수 웹앱 뷰어 코드만 올라가며, 어떠한 노션 데이터나 API 키도 저장되지 않습니다.**  
> 모든 토큰과 DB 정보는 **접속한 사용자 본인의 웹 브라우저(LocalStorage)**에만 보관되므로, 깃허브가 완전 공개(Public) 상태여도 개인정보가 100% 안전하게 보호됩니다.

---

## 🔒 작동 원리 및 보안 장점

```
[GitHub Pages 배포 웹앱]
       │ (순수 HTML/JS/CSS 뷰어 엔진만 서빙, 저장소에 노션 데이터 0바이트)
       ▼
[사용자 웹 브라우저]
       ├─ 사용자 본인의 Notion API Key & DB ID 직접 입력 (브라우저 로컬 저장소에만 보관)
       ├─ 실시간으로 Notion API 직접 호출 (CORS 프록시 경유)
       ├─ 브라우저 메모리 상에서 실시간 그래프 구성 & IndexedDB 로컬 캐싱
       └─ 노션에서 내용 수정 후 '동기화(🔄)' 누르면 즉시 실시간 반영!
```

### 왜 이 방식이 가장 안전한가요?
1. **GitHub 저장소 데이터 제로**: 깃허브 저장소나 Pages 서버에 노션 노트 파일이 아예 배포되지 않으므로, 저장소가 공개되어 있어도 노출될 데이터 자체가 없습니다.
2. **실시간 반영**: GitHub Actions 정기 빌드를 기다릴 필요 없이, 노션에서 수정한 내용을 웹앱에서 즉시 실시간으로 확인할 수 있습니다.
3. **다중 사용자 지원**: 같은 웹앱 주소로 다른 사람(동료/친구)이 접속해도, 각자 자신의 노션 API 키를 입력하여 각자의 지식 그래프를 독립적으로 볼 수 있습니다.

---

## 📋 1. Notion 준비 사항

노션에 데이터베이스를 1개 생성하고 아래 속성명을 **동일하게** 생성해 주세요:

| 속성명 | 타입 | 설명 |
|---|---|---|
| **`이름`** | Title | 노트 제목 (그래프 노드 라벨) |
| **`연결`** | Relation | **자기 자신 DB를 참조**하는 관계형 속성 (노트 간 연결선) |
| **`태그`** | Multi-select | 태그 필터 및 분류 |
| **`폴더`** | Select | 범주 분류 (노드 고유 색상 매핑) |
| **`요약`** | Text (선택) | 검색 및 사이드바 미리보기 |

> **노션 설정 팁**:
> 1. 노션 설정 → [통합(Integrations)](https://www.notion.so/profile/integrations)에서 새 내부 통합을 생성하여 `API 토큰 (secret_...)`을 발급받습니다.
> 2. 해당 노션 DB 페이지 우측 상단 `···` → `연결(Connections)`에서 생성한 통합을 추가합니다. (**필수**)
> 3. DB 페이지 설정에서 *Manage data sources* → *Copy data source ID*를 복사합니다. (또는 DB URL의 32자리 ID)

---

## 🚀 2. 웹앱 사용 방법

1. 배포된 웹앱 주소(`https://semyo0513.github.io/notion-graph-notes/`)에 접속합니다.
2. 화면 중앙의 **Notion 연결 설정** 창에 발급받은 정보를 입력합니다:
   - **Notion API 토큰**: `secret_...`
   - **데이터베이스 ID**: 복사한 32자리 ID
   - **CORS 프록시 주소**: 기본값(`https://corsproxy.io/?url=`) 그대로 사용 가능
3. **[설정 저장 및 노션 동기화]**를 누르면 즉시 노션의 모든 노트가 2D 인터랙티브 그래프로 로드됩니다!

---

## 🌐 3. (선택) 나만의 개인 CORS 프록시 만들기 (Cloudflare Workers)

기본으로 제공되는 `https://corsproxy.io/?url=` 외에, **완전한 나만의 전용 프록시**를 원하신다면 Cloudflare Workers(무료)를 이용해 1분 만에 구축할 수 있습니다.

1. [Cloudflare 대시보드](https://dash.cloudflare.com/)에 로그인 후 **Workers & Pages** → **Create application** 클릭
2. 아래 코드를 붙여넣고 저장 및 배포(Deploy)합니다:
```javascript
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return new Response('Missing ?url=', { status: 400 });

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    const modifiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });

    const response = await fetch(modifiedRequest);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders
    });
  }
};
```
3. 생성된 Worker 주소(예: `https://my-proxy.workers.dev/?url=`)를 웹앱의 설정창에 입력하시면 됩니다.

---

## 💻 4. 로컬 테스트 방법

```bash
# 로컬 개발 서버 실행
npm start
```
- 브라우저에서 `http://localhost:8080`에 접속하여 테스트할 수 있습니다.
- 토큰이 없더라도 **[토큰 없이 데모 둘러보기]** 버튼을 누르면 내장된 샘플 지식 그래프를 즉시 체험할 수 있습니다.
