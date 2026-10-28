// 브라우저 직접 연동 Notion API 클라이언트 (CORS 프록시 지원)
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

export class NotionClient {
  constructor({ token, databaseId, proxyUrl = 'https://corsproxy.io/?url=' }) {
    this.token = (token || '').trim();
    this.databaseId = (databaseId || '').trim();
    this.proxyUrl = (proxyUrl || '').trim();
    this.cacheDbName = 'notion_graph_cache';
    this.db = null;
  }

  setCredentials({ token, databaseId, proxyUrl }) {
    if (token !== undefined) this.token = token.trim();
    if (databaseId !== undefined) this.databaseId = databaseId.trim();
    if (proxyUrl !== undefined) this.proxyUrl = proxyUrl.trim();
  }

  /**
   * CORS 프록시를 적용한 URL 생성
   */
  buildUrl(apiPath) {
    const targetUrl = NOTION_API + apiPath;
    if (!this.proxyUrl) return targetUrl;

    if (this.proxyUrl.includes('?url=')) {
      return this.proxyUrl + encodeURIComponent(targetUrl);
    }
    if (this.proxyUrl.endsWith('/')) {
      return this.proxyUrl + targetUrl;
    }
    return `${this.proxyUrl}/${targetUrl}`;
  }

  /**
   * 노션 API 호출 (Retry-After 대응)
   */
  async request(method, apiPath, body = null) {
    const url = this.buildUrl(apiPath);

    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    };

    let attempts = 0;
    while (attempts < 5) {
      attempts++;
      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined
        });
      } catch (err) {
        if (attempts >= 5) {
          throw new Error(`네트워크/CORS 오류: 프록시 주소 또는 인터넷 연결을 확인하세요. (${err.message})`);
        }
        await new Promise(r => setTimeout(r, 1000 * attempts));
        continue;
      }

      if (res.status === 429 || res.status === 529) {
        const retryAfter = Number(res.headers.get('retry-after') || 1);
        await new Promise(r => setTimeout(r, Math.min(retryAfter, 30) * 1000 + attempts * 300));
        continue;
      }

      if (res.ok) {
        return res.json();
      }

      let errMsg = '';
      try {
        const errJson = await res.json();
        errMsg = errJson.message || res.statusText;
      } catch {
        errMsg = await res.text().catch(() => res.statusText);
      }

      if (res.status === 401) {
        throw new Error('Notion API 토큰(API Key)이 올바르지 않습니다.');
      }
      if (res.status === 404) {
        throw new Error('데이터베이스 또는 페이지를 찾을 수 없습니다. (ID 확인 및 노션 DB 페이지 우측 상단 ··· -> 연결(Connections)에 해당 통합이 추가되어 있는지 확인하세요)');
      }

      throw new Error(`Notion API [${res.status}]: ${errMsg}`);
    }
    throw new Error('요청 재시도 횟수 초과');
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
      // 폴백: databases 쿼리
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
    // 1. IndexedDB 캐시 확인
    await this.initCacheDb();
    if (this.db) {
      const cached = await this.getFromCache(pageId);
      if (cached && cached.edited === editedTime) {
        return cached.md;
      }
    }

    // 2. /v1/pages/{id}/markdown 시도
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

    // 3. 캐시 저장
    if (this.db) {
      await this.saveToCache(pageId, { md: mdText, edited: editedTime });
    }

    return mdText;
  }

  /* ───── IndexedDB 브라우저 캐시 관리 ───── */
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

  clearCache() {
    return new Promise((resolve) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction('notes', 'readwrite');
      const store = tx.objectStore('notes');
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}
