export class SearchEngine {
  constructor() {
    this.rawDocs = [];
    this.index = null;
    this.useFlex = typeof window.FlexSearch !== 'undefined';
  }

  buildIndex(docs) {
    this.rawDocs = docs || [];

    if (this.useFlex) {
      try {
        // FlexSearch Document 인덱스 구성
        this.index = new window.FlexSearch.Document({
          document: {
            id: 'id',
            index: ['text', 'title', 'tags', 'folder']
          },
          tokenize: 'forward',
          charset: 'latin:extra'
        });

        for (const doc of this.rawDocs) {
          this.index.add({
            id: doc.id,
            title: doc.title || '',
            tags: Array.isArray(doc.tags) ? doc.tags.join(' ') : '',
            folder: doc.folder || '',
            text: doc.text || ''
          });
        }
        return;
      } catch (e) {
        console.warn('FlexSearch 초기화 실패, 내장 검색기로 대체합니다:', e);
      }
    }
  }

  /**
   * 쿼리 검색 -> 매칭된 노트 ID Set 반환
   */
  search(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return null; // 빈 검색어는 전체 표시 의미

    const matchedIds = new Set();

    if (this.index) {
      try {
        const results = this.index.search(q, { limit: 100 });
        for (const fieldRes of results) {
          for (const id of fieldRes.result) {
            matchedIds.add(id);
          }
        }
        if (matchedIds.size > 0) return matchedIds;
      } catch {
        // 폴백
      }
    }

    // 부분 일치 및 토큰 검색 폴백 (한글 검색 최적화)
    const keywords = q.split(/\s+/).filter(Boolean);
    for (const doc of this.rawDocs) {
      const fullText = (doc.text || '').toLowerCase();
      const isMatch = keywords.every(kw => fullText.includes(kw));
      if (isMatch) {
        matchedIds.add(doc.id);
      }
    }

    return matchedIds;
  }
}
