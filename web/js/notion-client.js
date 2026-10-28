// 브라우저 직접 연동 Notion API 클라이언트 (CORS 프록시 및 자동 URL 정제 지원)
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

/**
 * 사용자가 전체 URL을 넣어도 32자리 Database ID를 자동 추출
 */
export function extractNotionId(input) {
  if (!input) return '';
  const str = String(input).trim();

  // 1. 하이픈 포함 UUID (예: 29841fbc-8a23-405f-88ba-0123456789ab)
  const uuidMatch = str.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (uuidMatch) {
    return uuidMatch[0].replace(/-/g, '').toLowerCase();
  }

  // 2. 32자리 16진수 문자열 (예: 29841fbc8a23405f88ba0123456789ab)
  const hex32Match = str.match(/[0-9a-fA-F]{32}/);
  if (hex32Match) {
    return hex32Match[0].toLowerCase();
  }

  // 3. URL 형태에서 마지막 32자리 추출 (예: /p/제목-29841fbc8a23405f88ba0123456789ab)
  const cleanUrl = str.split('?')[0].split('#')[0];
  const lastSegment = cleanUrl.split('/').filter(Boolean).pop() || '';
  const hexInLast = lastSegment.replace(/[^0-9a-fA-F]/g, '');
  if (hexInLast.length >= 32) {
    return hexInLast.slice(-32).toLowerCase();
  }

  return str.replace(/[^a-zA-Z0-9_-]/g, '');
}

export class NotionClient {
  constructor({ token, databaseId, proxyUrl = 'https://corsproxy.io/?url=' }) {
    this.token = (token || '').trim();
    this.databaseId = extractNotionId(databaseId);
    this.proxyUrl = (proxyUrl || '').trim();
    this.cacheDbName = 'notion_graph_cache';
    this.db = null;
  }

  setCredentials({ token, databaseId, proxyUrl }) {
    if (token !== undefined) this.token = token.trim();
    if (databaseId !== undefined) this.databaseId = extractNotionId(databaseId);
    if (proxyUrl !== undefined) this.proxyUrl = proxyUrl.trim();
  }

  /**
   * 프록시 형태(리버스 프록시 vs ?url= 쿼리 프록시)에 맞춰 가능한 URL 목록 반환
   */
  getCandidateUrls(apiPath) {
    const targetUrl = NOTION_API + apiPath; // https://api.notion.com/v1/...
    if (!this.proxyUrl) return [targetUrl];

    const proxy = this.proxyUrl.trim().replace(/\/+$/, '');

    // 사용자가 이미 ?url= 이나 쿼리를 직접 작성한 경우
    if (proxy.includes('?url=')) {
      return [proxy + encodeURIComponent(targetUrl)];
    }
    if (proxy.includes('?')) {
      return [`${proxy}&url=${encodeURIComponent(targetUrl)}`];
    }

    // 일반 프록시 도메인인 경우 (예: https://notion-proxy.xxx.workers.dev)
    // 1순위: /v1/... 직접 리버스 프록시 형태 (많은 Notion Worker의 표준)
    // 2순위: ?url= 쿼리 전달 형태
    return [
      `${proxy}${apiPath}`,
      `${proxy}/?url=${encodeURIComponent(targetUrl)}`
    ];
  }

  /**
   * 노션 API 호출 (스마트 프록시 듀얼 시도 & HTML 감지 & Retry-After 대응)
   */
  async request(method, apiPath, body = null) {
    const candidateUrls = this.getCandidateUrls(apiPath);

    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    };

    let lastError = null;

    for (const url of candidateUrls) {
      let attempts = 0;
      while (attempts < 2) {
        attempts++;
        let res;
        try {
          res = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
          });
        } catch (err) {
          lastError = new Error(`프록시 통신 실패 (${url}): ${err.message}`);
          break; // 다음 candidate URL 시도
        }

        if (res.status === 429 || res.status === 529) {
          const retryAfter = Number(res.headers.get('retry-after') || 1);
          await new Promise(r => setTimeout(r, Math.min(retryAfter, 5) * 1000 + attempts * 300));
          continue;
        }

        const text = await res.text().catch(() => '');

        if (res.ok) {
          try {
            return JSON.parse(text);
          } catch (parseErr) {
            // Notion API는 정상 시 반드시 JSON을 반환해야 함. HTML이 온 경우 다음 후보 시도
            lastError = new Error(
              `프록시 서버가 Notion JSON 대신 HTML 웹페이지를 반환했습니다.\n` +
              `• 시도 주소: ${url}\n` +
              `• 응답 내용: ${text.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').slice(0, 100)}...`
            );
            break; // 다음 URL 후보 시도
          }
        }

        // 404가 나오면 리버스 프록시 형태일 수 있으므로 다음 URL 후보 시도
        if (res.status === 404 && candidateUrls.length > 1 && url === candidateUrls[0]) {
          break;
        }

        let errMsg = text;
        try {
          const errJson = JSON.parse(text);
          errMsg = errJson.message || res.statusText;
        } catch {
          errMsg = text.slice(0, 100) || res.statusText;
        }

        if (res.status === 401) {
          throw new Error(`[401 인증 실패] Notion API 토큰이 올바르지 않습니다: ${errMsg}`);
        }
        if (res.status === 404) {
          throw new Error(`[404 찾을 수 없음] 데이터베이스나 페이지가 없거나 통합 봇이 연결되지 않았습니다.`);
        }

        throw new Error(`Notion API [${res.status}]: ${errMsg}`);
      }
    }

    throw lastError || new Error('요청 실패 (프록시 주소를 확인하세요)');
  }

  /**
   * 연결 및 권한 즉시 진단 함수
   */
  async testConnection() {
    if (!this.token) throw new Error('Notion API 토큰(ntn_... 또는 secret_...)을 입력해 주세요.');
    if (!this.databaseId) throw new Error('올바른 데이터베이스 ID(또는 URL)를 입력해 주세요.');

    // 1. 프록시 및 토큰 유효성 검사 (GET /v1/users/me)
    let user;
    try {
      user = await this.request('GET', '/users/me');
    } catch (err) {
      if (err.message.includes('401')) {
        throw new Error('토큰 인증 실패 (401): 입력하신 노션 엑세스 토큰이 유효하지 않습니다.');
      }
      throw new Error(`프록시 또는 토큰 오류: ${err.message}`);
    }

    // 2. 데이터베이스 접근 권한 검사 (POST /v1/databases/{id}/query 또는 GET /v1/databases/{id})
    try {
      await this.request('GET', `/databases/${this.databaseId}`);
    } catch (err) {
      if (err.message.includes('404')) {
        throw new Error(
          `데이터베이스를 찾을 수 없습니다 (404).\n` +
          `추출된 DB ID: ${this.databaseId}\n\n` +
          `[해결 방법]\n` +
          `1. 노션 DB 페이지 우측 상단 [···] -> [연결(Connections)]에 생성하신 내부 통합을 반드시 추가해 주세요. (가장 흔한 원인)\n` +
          `2. 데이터베이스 ID가 맞는지 확인해 주세요.`
        );
      }
    }

    return {
      botName: user?.name || '통합 봇',
      dbId: this.databaseId
    };
  }

  /**
   * DB / Data Source 목록 쿼리
   */
  async fetchAllPages(onProgress) {
    if (!this.token) throw new Error('Notion API 토큰을 입력하세요.');
    if (!this.databaseId) throw new Error('데이터베이스 ID를 입력하세요.');

    const pages = [];
    let cursor = null;

    // 1차 시도: data_sources 쿼리 (2025-09-03 이후)
    let endpoint = `/data_sources/${this.databaseId}/query`;
    try {
      if (onProgress) onProgress(0, 0, '데이터베이스 확인 중...');
      await this.request('POST', endpoint, { page_size: 1 });
    } catch (err) {
      // 2차 시도: databases 쿼리
      endpoint = `/databases/${this.databaseId}/query`;
    }

    do {
      if (onProgress) onProgress(pages.length, null, `노트 목록 조회 중... (${pages.length}개)`);
      const res = await this.request('POST', endpoint, {
        page_size: 100,
        ...(cursor && { start_cursor: cursor })
      });

      for (const p of res.results || []) {
        pages.push(this.parsePage(p));
      }
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);

    return pages;
  }

  parsePage(p) {
    const P = p.properties || {};

    let titleProp = P['이름']?.title;
    if (!titleProp) {
      const key = Object.keys(P).find(k => P[k]?.type === 'title');
      if (key) titleProp = P[key].title;
    }
    const title = (titleProp || []).map(t => t.plain_text).join('') || '(제목 없음)';

    let tagsProp = P['태그']?.multi_select;
    if (!tagsProp) {
      const key = Object.keys(P).find(k => P[k]?.type === 'multi_select');
      if (key) tagsProp = P[key].multi_select;
    }
    const tags = (tagsProp || []).map(t => t.name);

    let folderProp = P['폴더']?.select?.name;
    if (!folderProp) {
      const key = Object.keys(P).find(k => P[k]?.type === 'select');
      if (key) folderProp = P[key]?.select?.name;
    }
    const folder = folderProp || '기본';

    const summary = ((P['요약']?.rich_text) || []).map(t => t.plain_text).join('');

    let linksProp = P['연결']?.relation;
    if (!linksProp) {
      const key = Object.keys(P).find(k => P[k]?.type === 'relation');
      if (key) linksProp = P[key].relation;
    }
    const links = (linksProp || []).map(r => r.id);

    return {
      id: p.id,
      title,
      tags,
      folder,
      summary,
      links,
      url: p.url,
      edited: p.last_edited_time
    };
  }

  buildEdges(nodes) {
    const ids = new Set(nodes.map(n => n.id));
    const seen = new Set();
    const edges = [];

    for (const n of nodes) {
      for (const targetId of n.links) {
        if (!ids.has(targetId)) continue;
        const key = n.id < targetId ? `${n.id}|${targetId}` : `${targetId}|${n.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push([n.id, targetId]);
        }
      }
    }
    return edges;
  }

  /**
   * 개별 페이지 마크다운 본문 가져오기 (IndexedDB 로컬 캐시 연동)
   */
  async fetchPageMarkdown(pageId, editedTime) {
    await this.initCacheDb();
    if (this.db) {
      const cached = await this.getFromCache(pageId);
      if (cached && cached.edited === editedTime) {
        return cached.md;
      }
    }

    let mdText = '';
    try {
      const res = await this.request('GET', `/pages/${pageId}/markdown`);
      if (res && typeof res.markdown === 'string') {
        mdText = res.markdown;
      }
    } catch {
      // 블록 폴백
    }

    if (!mdText) {
      try {
        const blocksRes = await this.request('GET', `/blocks/${pageId}/children?page_size=100`);
        const lines = [];
        for (const b of blocksRes.results || []) {
          const type = b.type;
          const rich = b[type]?.rich_text;
          const text = (rich || []).map(t => t.plain_text).join('');
          if (type.startsWith('heading_1')) lines.push(`# ${text}`);
          else if (type.startsWith('heading_2')) lines.push(`## ${text}`);
          else if (type.startsWith('heading_3')) lines.push(`### ${text}`);
          else if (type === 'bulleted_list_item') lines.push(`- ${text}`);
          else if (type === 'numbered_list_item') lines.push(`1. ${text}`);
          else if (type === 'to_do') lines.push(`- [${b.to_do?.checked ? 'x' : ' '}] ${text}`);
          else if (type === 'code') lines.push(`\`\`\`\n${text}\n\`\`\``);
          else if (type === 'quote') lines.push(`> ${text}`);
          else if (text) lines.push(text);
        }
        mdText = lines.join('\n\n') || '(내용이 비어 있습니다.)';
      } catch (err) {
        mdText = '(본문을 불러올 수 없습니다: ' + err.message + ')';
      }
    }

    if (this.db) {
      await this.saveToCache(pageId, { md: mdText, edited: editedTime });
    }

    return mdText;
  }

  initCacheDb() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      const req = window.indexedDB.open(this.cacheDbName, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes', { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      req.onerror = () => resolve(null);
    });
  }

  getFromCache(id) {
    return new Promise((resolve) => {
      if (!this.db) return resolve(null);
      const tx = this.db.transaction('notes', 'readonly');
      const store = tx.objectStore('notes');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  saveToCache(id, data) {
    return new Promise((resolve) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      store.put({ id, ...data });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}
