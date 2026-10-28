import { deriveKey } from './crypto.js';
import { DataManager } from './data.js';
import { SearchEngine } from './search.js';
import { GraphView } from './graph.js';
import { SidebarView } from './sidebar.js';

class App {
  constructor() {
    this.dataManager = new DataManager();
    this.searchEngine = new SearchEngine();
    this.graphView = null;
    this.sidebarView = null;

    this.meta = null;
    this.rawNodes = [];

    // DOM 요소
    this.unlockModal = document.getElementById('unlock-modal');
    this.unlockForm = document.getElementById('unlock-form');
    this.passInput = document.getElementById('passphrase-input');
    this.rememberCheck = document.getElementById('remember-passphrase');
    this.btnUnlock = document.getElementById('btn-unlock');
    this.unlockError = document.getElementById('unlock-error');

    this.searchInput = document.getElementById('search-input');
    this.searchClear = document.getElementById('search-clear');
    this.folderSelect = document.getElementById('folder-filter');
    this.tagSelect = document.getElementById('tag-filter');

    this.nodeCountEl = document.getElementById('node-count');
    this.edgeCountEl = document.getElementById('edge-count');
    this.lastSyncEl = document.getElementById('last-sync-time');

    this.toastContainer = document.getElementById('toast-container');
  }

  async start() {
    this.initViews();
    this.initEventListeners();

    // 1. 암호화 메타데이터 로드
    try {
      this.meta = await this.dataManager.loadMeta();
    } catch (err) {
      this.unlockError.textContent = `데이터 로드 대기 중: GitHub Actions 동기화가 진행 중이거나 아직 실행되지 않았습니다. (${err.message})`;
      return;
    }

    // 2. 저장된 패스프레이즈 자동 복호화 시도
    const savedPass = localStorage.getItem('notion_passphrase');
    if (savedPass) {
      this.passInput.value = savedPass;
      this.rememberCheck.checked = true;
      this.attemptUnlock(savedPass, true);
    }
  }

  initViews() {
    this.sidebarView = new SidebarView({
      containerId: 'sidebar',
      onSelectNode: (nodeId) => {
        if (this.graphView) {
          this.graphView.selectNodeById(nodeId);
        }
      }
    });

    this.graphView = new GraphView({
      containerId: 'graph-container',
      onNodeClick: (node) => {
        const neighborNodes = Array.from(node.neighbors || []);
        const fetchContent = this.dataManager.loadNote(node.id, node.edited);
        this.sidebarView.renderNode(node, neighborNodes, fetchContent);
      },
      onBackgroundClick: () => {
        this.sidebarView.close();
      }
    });
  }

  initEventListeners() {
    // 잠금 해제 폼
    this.unlockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = this.passInput.value.trim();
      if (!pass) return;
      await this.attemptUnlock(pass, false);
    });

    // 검색
    this.searchInput.addEventListener('input', () => this.handleFilterChange());
    this.searchClear.addEventListener('click', () => {
      this.searchInput.value = '';
      this.searchClear.classList.remove('visible');
      this.handleFilterChange();
    });

    // 필터
    this.folderSelect.addEventListener('change', () => this.handleFilterChange());
    this.tagSelect.addEventListener('change', () => this.handleFilterChange());

    // 뷰 컨트롤
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => this.graphView.zoomIn());
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => this.graphView.zoomOut());
    document.getElementById('btn-reset-view')?.addEventListener('click', () => this.graphView.resetView());

    // 잠금(로그아웃)
    document.getElementById('btn-lock')?.addEventListener('click', () => {
      localStorage.removeItem('notion_passphrase');
      window.location.reload();
    });

    // 단축키
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        this.searchInput.focus();
      }
    });
  }

  async attemptUnlock(passphrase, isAuto = false) {
    this.setLoading(true);
    this.unlockError.textContent = '';

    try {
      const key = await deriveKey(passphrase, this.meta.salt, this.meta.iter);
      this.dataManager.setCryptoKey(key);

      const graph = await this.dataManager.loadGraph();
      this.rawNodes = graph.nodes || [];

      if (this.rememberCheck.checked) {
        localStorage.setItem('notion_passphrase', passphrase);
      } else {
        localStorage.removeItem('notion_passphrase');
      }

      this.unlockModal.classList.add('hidden');
      this.graphView.init(graph);
      this.updateHudAndFilters(graph);

      this.showToast('복호화 성공! 그래프를 불러왔습니다.', 2500);

      // 백그라운드 검색 색인 로드
      this.dataManager.loadSearch().then(searchDocs => {
        this.searchEngine.buildIndex(searchDocs);
      }).catch(() => {});

    } catch (err) {
      if (isAuto) localStorage.removeItem('notion_passphrase');
      this.unlockError.textContent = err.message || '패스프레이즈가 올바르지 않습니다.';
    } finally {
      this.setLoading(false);
    }
  }

  setLoading(isLoading) {
    this.btnUnlock.disabled = isLoading;
    this.btnUnlock.innerHTML = isLoading
      ? '<span class="spinner"></span> 복호화 중...'
      : '노트 잠금 해제';
  }

  updateHudAndFilters(graph) {
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];

    if (this.nodeCountEl) this.nodeCountEl.textContent = nodes.length;
    if (this.edgeCountEl) this.edgeCountEl.textContent = edges.length;

    if (this.meta?.builtAt && this.lastSyncEl) {
      const d = new Date(this.meta.builtAt);
      this.lastSyncEl.textContent = `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const folders = new Set();
    const tags = new Set();

    for (const n of nodes) {
      if (n.folder) folders.add(n.folder);
      if (Array.isArray(n.tags)) n.tags.forEach(t => tags.add(t));
    }

    this.folderSelect.innerHTML = '<option value="">모든 폴더</option>';
    Array.from(folders).sort().forEach(f => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = `📁 ${f}`;
      this.folderSelect.appendChild(opt);
    });

    this.tagSelect.innerHTML = '<option value="">모든 태그</option>';
    Array.from(tags).sort().forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = `#${t}`;
      this.tagSelect.appendChild(opt);
    });
  }

  handleFilterChange() {
    const query = this.searchInput.value.trim();
    const selectedFolder = this.folderSelect.value;
    const selectedTag = this.tagSelect.value;

    if (query) {
      this.searchClear.classList.add('visible');
    } else {
      this.searchClear.classList.remove('visible');
    }

    const searchMatches = this.searchEngine.search(query);
    let matchedIds = null;

    if (query || selectedFolder || selectedTag) {
      matchedIds = new Set();
      for (const node of this.rawNodes) {
        if (query && searchMatches && !searchMatches.has(node.id)) continue;
        if (selectedFolder && node.folder !== selectedFolder) continue;
        if (selectedTag && (!node.tags || !node.tags.includes(selectedTag))) continue;
        matchedIds.add(node.id);
      }
    }

    this.graphView.applyFilter(matchedIds);
  }

  showToast(message, duration = 3000) {
    if (!this.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.start();
});
