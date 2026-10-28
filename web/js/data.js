import { openFile } from './crypto.js';

export class DataManager {
  constructor() {
    this.key = null;
    this.meta = null;
    this.graph = null;
    this.searchIndex = null;
    this.noteCache = new Map();
  }

  setCryptoKey(key) {
    this.key = key;
  }

  async loadMeta() {
    const res = await fetch('data/meta.json', { cache: 'no-cache' });
    if (!res.ok) {
      throw new Error('data/meta.json 파일을 찾을 수 없습니다. GitHub Actions 빌드가 완료되었는지 확인하세요.');
    }
    this.meta = await res.json();
    return this.meta;
  }

  async loadGraph() {
    if (!this.key || !this.meta) throw new Error('암호화 키가 없습니다.');
    const v = encodeURIComponent(this.meta.builtAt);
    this.graph = await openFile(this.key, `data/graph.enc?v=${v}`);
    return this.graph;
  }

  async loadSearch() {
    if (!this.key || !this.meta) throw new Error('암호화 키가 없습니다.');
    const v = encodeURIComponent(this.meta.builtAt);
    this.searchIndex = await openFile(this.key, `data/search.enc?v=${v}`);
    return this.searchIndex;
  }

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
