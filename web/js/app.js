import { NotionClient, extractNotionId } from './notion-client.js';
import { SearchEngine } from './search.js';
import { GraphView } from './graph.js';
import { SidebarView } from './sidebar.js';

class App {
  constructor() {
    this.notionClient = new NotionClient({});
    this.searchEngine = new SearchEngine();
    this.graphView = null;
    this.sidebarView = null;

    this.rawNodes = [];
    this.edges = [];

    // DOM 요소
    this.settingsModal = document.getElementById('settings-modal');
    this.settingsForm = document.getElementById('settings-form');
    this.tokenInput = document.getElementById('token-input');
    this.dbIdInput = document.getElementById('db-id-input');
    this.proxyInput = document.getElementById('proxy-input');
    this.rememberCheck = document.getElementById('remember-settings');
    this.btnSaveSettings = document.getElementById('btn-save-settings');
    this.btnTestConnection = document.getElementById('btn-test-connection');
    this.btnDemoMode = document.getElementById('btn-demo-mode');
    this.settingsError = document.getElementById('settings-error');

    this.btnSync = document.getElementById('btn-sync');
    this.btnOpenSettings = document.getElementById('btn-open-settings');

    this.searchInput = document.getElementById('search-input');
    this.searchClear = document.getElementById('search-clear');
    this.folderSelect = document.getElementById('folder-filter');
    this.tagSelect = document.getElementById('tag-filter');

    this.nodeCountEl = document.getElementById('node-count');
    this.edgeCountEl = document.getElementById('edge-count');
    this.lastSyncEl = document.getElementById('last-sync-time');

    this.progressOverlay = document.getElementById('progress-overlay');
    this.progressText = document.getElementById('progress-text');
    this.toastContainer = document.getElementById('toast-container');
  }

  async start() {
    this.initViews();
    this.initEventListeners();

    // 1. 로컬 저장소에서 설정 불러오기
    const savedToken = localStorage.getItem('notion_token') || sessionStorage.getItem('notion_token') || '';
    const savedDbId = localStorage.getItem('notion_db_id') || sessionStorage.getItem('notion_db_id') || '';
    let savedProxy = localStorage.getItem('notion_proxy') || sessionStorage.getItem('notion_proxy') || '';
    if (savedProxy.includes('corsproxy.io')) {
      savedProxy = ''; // Authorization 헤더 차단되는 공용 프록시 제거
    }

    this.tokenInput.value = savedToken;
    this.dbIdInput.value = savedDbId;
    this.proxyInput.value = savedProxy;
    this.rememberCheck.checked = !!localStorage.getItem('notion_token');

    this.notionClient.setCredentials({
      token: savedToken,
      databaseId: savedDbId,
      proxyUrl: savedProxy
    });

    // 2. 저장된 정보가 있으면 자동 동기화 시작, 없으면 설정 모달 표시
    if (savedToken && savedDbId) {
      this.syncFromNotion();
    } else {
      this.openSettings();
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
        const fetchContent = this.fetchNodeContent(node);
        this.sidebarView.renderNode(node, neighborNodes, fetchContent);
      },
      onBackgroundClick: () => {
        this.sidebarView.close();
      }
    });
  }

  initEventListeners() {
    // DB ID 인풋에서 URL 입력 시 32자리 ID 자동 추출
    this.dbIdInput.addEventListener('blur', () => {
      const val = this.dbIdInput.value.trim();
      const extracted = extractNotionId(val);
      if (extracted && extracted !== val) {
        this.dbIdInput.value = extracted;
        this.showToast(`URL에서 데이터베이스 ID(${extracted})를 자동 추출했습니다.`, 2500);
      }
    });

    // 연결 테스트 버튼
    this.btnTestConnection?.addEventListener('click', async () => {
      const token = this.tokenInput.value.trim();
      const rawDbId = this.dbIdInput.value.trim();
      const dbId = extractNotionId(rawDbId);
      const proxy = this.proxyInput.value.trim() || 'https://corsproxy.io/?url=';

      if (dbId) this.dbIdInput.value = dbId;

      if (!token) {
        this.settingsError.textContent = 'Notion API 토큰을 입력하세요.';
        return;
      }
      if (!dbId) {
        this.settingsError.textContent = '데이터베이스 ID(또는 URL)를 입력하세요.';
        return;
      }

      this.settingsError.textContent = '연결 상태를 진단하는 중...';
      this.settingsError.style.color = '#93c5fd';
      this.notionClient.setCredentials({ token, databaseId: dbId, proxyUrl: proxy });

      try {
        const res = await this.notionClient.testConnection();
        this.settingsError.style.color = '#10b981';
        this.settingsError.textContent = `✅ 연결 성공!\n- 봇 이름: ${res.botName}\n- 데이터베이스 ID: ${res.dbId}\n지금 [설정 저장 및 동기화]를 누르시면 됩니다.`;
      } catch (err) {
        this.settingsError.style.color = '#ef4444';
        this.settingsError.textContent = `❌ 연결 실패:\n${err.message}`;
      }
    });

    // 설정 폼 저장
    this.settingsForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const token = this.tokenInput.value.trim();
      const rawDbId = this.dbIdInput.value.trim();
      const dbId = extractNotionId(rawDbId);
      const proxy = this.proxyInput.value.trim() || 'https://corsproxy.io/?url=';
      const remember = this.rememberCheck.checked;

      if (dbId) this.dbIdInput.value = dbId;

      if (!token || !dbId) {
        this.settingsError.textContent = 'Notion API 토큰과 데이터베이스 ID를 모두 입력하세요.';
        return;
      }

      this.settingsError.textContent = '';
      this.notionClient.setCredentials({ token, databaseId: dbId, proxyUrl: proxy });

      if (remember) {
        localStorage.setItem('notion_token', token);
        localStorage.setItem('notion_db_id', dbId);
        localStorage.setItem('notion_proxy', proxy);
        sessionStorage.removeItem('notion_token');
        sessionStorage.removeItem('notion_db_id');
      } else {
        sessionStorage.setItem('notion_token', token);
        sessionStorage.setItem('notion_db_id', dbId);
        localStorage.removeItem('notion_token');
        localStorage.removeItem('notion_db_id');
      }

      this.closeSettings();
      this.syncFromNotion();
    });

    // 데모 모드 (토큰 없이 둘러보기)
    this.btnDemoMode?.addEventListener('click', () => {
      this.closeSettings();
      this.loadDemoData();
    });

    // 동기화 버튼 (새로고침)
    this.btnSync?.addEventListener('click', () => {
      if (!this.notionClient.token || !this.notionClient.databaseId) {
        this.openSettings();
      } else {
        this.syncFromNotion();
      }
    });

    // 설정 열기 버튼
    this.btnOpenSettings?.addEventListener('click', () => this.openSettings());

    // 설정 모달 닫기
    document.getElementById('settings-close')?.addEventListener('click', () => this.closeSettings());

    // 검색 입력
    this.searchInput.addEventListener('input', () => this.handleFilterChange());
    this.searchClear.addEventListener('click', () => {
      this.searchInput.value = '';
      this.searchClear.classList.remove('visible');
      this.handleFilterChange();
    });

    // 필터 드롭다운
    this.folderSelect.addEventListener('change', () => this.handleFilterChange());
    this.tagSelect.addEventListener('change', () => this.handleFilterChange());

    // 뷰 컨트롤 버튼
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => this.graphView.zoomIn());
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => this.graphView.zoomOut());
    document.getElementById('btn-reset-view')?.addEventListener('click', () => this.graphView.resetView());

    // 단축키 (Cmd/Ctrl + K: 검색, Esc: 사이드바 닫기)
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        this.searchInput.focus();
      }
    });
  }

  openSettings() {
    this.settingsModal.classList.remove('hidden');
    this.settingsError.textContent = '';
  }

  closeSettings() {
    this.settingsModal.classList.add('hidden');
  }

  showProgress(text) {
    if (this.progressOverlay) {
      this.progressOverlay.classList.remove('hidden');
      if (this.progressText) this.progressText.textContent = text;
    }
  }

  hideProgress() {
    if (this.progressOverlay) {
      this.progressOverlay.classList.add('hidden');
    }
  }

  /**
   * Notion API로부터 실시간 동기화
   */
  async syncFromNotion() {
    this.showProgress('Notion에 연결하는 중...');
    try {
      const nodes = await this.notionClient.fetchAllPages((loaded, total, status) => {
        this.showProgress(status);
      });

      this.rawNodes = nodes;
      this.edges = this.notionClient.buildEdges(nodes);

      // 그래프 초기화
      this.graphView.init({ nodes: this.rawNodes, edges: this.edges });
      this.updateHudAndFilters(this.rawNodes, this.edges);

      // 검색 인덱스 백그라운드 빌드
      this.searchEngine.buildIndex(this.rawNodes.map(n => ({
        id: n.id,
        title: n.title,
        tags: n.tags,
        folder: n.folder,
        summary: n.summary,
        text: `${n.title} ${n.tags.join(' ')} ${n.folder} ${n.summary}`
      })));

      this.showToast(`Notion 노트 ${this.rawNodes.length}개 동기화 완료!`, 3000);
      this.hideProgress();

    } catch (err) {
      this.hideProgress();
      this.showToast(`동기화 실패: ${err.message}`, 4000);
      this.settingsError.textContent = err.message;
      this.openSettings();
    }
  }

  async fetchNodeContent(node) {
    if (node.isDemo) {
      return { md: node.content || `# ${node.title}\n\n데모 노트 본문입니다.` };
    }
    const md = await this.notionClient.fetchPageMarkdown(node.id, node.edited);
    return { md };
  }

  updateHudAndFilters(nodes, edges) {
    if (this.nodeCountEl) this.nodeCountEl.textContent = nodes.length;
    if (this.edgeCountEl) this.edgeCountEl.textContent = edges.length;

    if (this.lastSyncEl) {
      const d = new Date();
      this.lastSyncEl.textContent = `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const folders = new Set();
    const tags = new Set();

    for (const n of nodes) {
      if (n.folder) folders.add(n.folder);
      if (Array.isArray(n.tags)) {
        n.tags.forEach(t => tags.add(t));
      }
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

  loadDemoData() {
    this.rawNodes = [
      { id: 'd1', isDemo: true, title: '개인 지식 관리(PKM)', folder: '생산성', tags: ['지식관리', '옵시디언'], summary: '연결 중심의 지식 관리', content: '# 개인 지식 관리(PKM)\n\n노트 간의 연결을 시각화하여 창의적 영감을 얻습니다.' },
      { id: 'd2', isDemo: true, title: '제텔카스텐(Zettelkasten)', folder: '생산성', tags: ['지식관리', '제텔카스텐'], summary: '메모 상자 원리', content: '# 제텔카스텐\n\n단일 개념의 영구 노트를 연결하여 지식 그물을 형성합니다.' },
      { id: 'd3', isDemo: true, title: 'Notion API 브라우저 연동', folder: '개발', tags: ['노션', 'API', 'JavaScript'], summary: 'CORS 우회 및 실시간 쿼리', content: '# Notion API 브라우저 연동\n\n클라이언트 브라우저에서 직접 노션을 호출하여 실시간 그래프를 그립니다.' },
      { id: 'd4', isDemo: true, title: 'Force-Directed 지식 그래프', folder: '컴퓨터과학', tags: ['시각화', '그래프'], summary: '물리 엔진 기반 배치', content: '# Force-Directed 그래프\n\n척력과 인력을 계산하여 노드를 2차원 평면에 직관적으로 배치합니다.' }
    ];
    this.edges = [['d1', 'd2'], ['d1', 'd3'], ['d3', 'd4'], ['d4', 'd1']];

    this.graphView.init({ nodes: this.rawNodes, edges: this.edges });
    this.updateHudAndFilters(this.rawNodes, this.edges);
    this.searchEngine.buildIndex(this.rawNodes.map(n => ({
      id: n.id,
      title: n.title,
      tags: n.tags,
      folder: n.folder,
      summary: n.summary,
      text: `${n.title} ${n.tags.join(' ')} ${n.folder} ${n.summary} ${n.content}`
    })));
    this.showToast('데모 모드로 로드되었습니다.', 2500);
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
