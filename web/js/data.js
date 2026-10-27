import { openFile } from './crypto.js';

export class DataManager {
  constructor() {
    this.key = null;
    this.meta = null;
    this.graph = null;
    this.searchIndex = null;
    this.noteCache = new Map(); // id -> { md }
  }

  setCryptoKey(key) {
    this.key = key;
  }

  /**
   * 평문 메타데이터 로드 (salt, iter, builtAt)
   */
  async loadMeta() {
    const res = await fetch('data/meta.json', { cache: 'no-cache' });
    if (!res.ok) {
      throw new Error('data/meta.json 파일을 찾을 수 없습니다. 빌드가 완료되었는지 확인하세요.');
    }
    this.meta = await res.json();
    return this.meta;
  }

  /**
   * graph.enc 로드 및 복호화
   */
  async loadGraph() {
    if (!this.key || !this.meta) throw new Error('암호화 키 또는 메타데이터가 초기화되지 않았습니다.');
    const v = encodeURIComponent(this.meta.builtAt);
    this.graph = await openFile(this.key, `data/graph.enc?v=${v}`);
    return this.graph;
  }

  /**
   * search.enc 로드 및 복호화
   */
  async loadSearch() {
    if (!this.key || !this.meta) throw new Error('암호화 키 또는 메타데이터가 초기화되지 않았습니다.');
    const v = encodeURIComponent(this.meta.builtAt);
    this.searchIndex = await openFile(this.key, `data/search.enc?v=${v}`);
    return this.searchIndex;
  }

  /**
   * 개별 노트 본문 로드 및 복호화 (캐시 우선)
   */
  async loadNote(id, editedTime) {
    if (this.noteCache.has(id)) {
      return this.noteCache.get(id);
    }

    if (!this.key) throw new Error('암호화 키가 없습니다.');
    const v = encodeURIComponent(editedTime || Date.now());
    const data = await openFile(this.key, `data/n/${id}.enc?v=${v}`);
    this.noteCache.set(id, data);
    return data;
  }
}
