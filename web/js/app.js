import { deriveKey } from './crypto.js';
import { DataManager } from './data.js';
import { SearchEngine } from './search.js';
import { GraphView } from './graph.js';
import { SidebarView } from './sidebar.js';
import { ExplorerView } from './explorer.js';
import { GeminiAssistant } from './ai.js';

class App {
  constructor() {
    this.dataManager = new DataManager();
    this.searchEngine = new SearchEngine();
    this.gemini = new GeminiAssistant();
    this.graphView = null;
    this.sidebarView = null;
    this.explorerView = null;

    this.meta = null;
    this.rawNodes = [];
    this.searchDocs = [];

    // 잠금 모달
    this.unlockModal = document.getElementById('unlock-modal');
    this.unlockForm = document.getElementById('unlock-form');
    this.passInput = document.getElementById('passphrase-input');
    this.rememberCheck = document.getElementById('remember-passphrase');
    this.btnUnlock = document.getElementById('btn-unlock');
    this.unlockError = document.getElementById('unlock-error');

    // 검색 & 필터
    this.searchInput = document.getElementById('search-input');
    this.searchClear = document.getElementById('search-clear');
    this.folderSelect = document.getElementById('folder-filter');
    this.tagSelect = document.getElementById('tag-filter');

    // HUD 정보
    this.nodeCountEl = document.getElementById('node-count');
    this.edgeCountEl = document.getElementById('edge-count');
    this.lastSyncEl = document.getElementById('last-sync-time');
    this.toastContainer = document.getElementById('toast-container');

    // 물리 제어 패널
    this.physicsPanel = document.getElementById('physics-panel');
    this.btnTogglePhysics = document.getElementById('btn-toggle-physics');

    // Gemini AI 모달 & 패널
    this.geminiModal = document.getElementById('gemini-key-modal');
    this.geminiKeyInput = document.getElementById('gemini-key-input');
    this.geminiForm = document.getElementById('gemini-key-form');
    this.aiMessages = document.getElementById('ai-messages');
    this.aiChatForm = document.getElementById('ai-chat-form');
    this.aiChatInput = document.getElementById('ai-chat-input');
  }

  async start() {
    this.initViews();
    this.initEventListeners();

    try {
      this.meta = await this.dataManager.loadMeta();
    } catch (err) {
      this.unlockError.textContent = `데이터 로드 대기 중: GitHub Actions 동기화가 진행 중이거나 아직 실행되지 않았습니다. (${err.message})`;
      return;
    }

    const savedPass = localStorage.getItem('notion_passphrase');
    if (savedPass) {
      this.passInput.value = savedPass;
      this.rememberCheck.checked = true;
      this.attemptUnlock(savedPass, true);
    }
  }

  initViews() {
    this.explorerView = new ExplorerView({
      containerId: 'explorer-sidebar',
      onSelectNode: (nodeId) => {
        if (this.graphView) this.graphView.selectNodeById(nodeId);
      }
    });

    this.sidebarView = new SidebarView({
      containerId: 'sidebar',
      onSelectNode: (nodeId) => {
        if (this.graphView) this.graphView.selectNodeById(nodeId);
      },
      onSaveContent: (nodeId, newText) => {
        this.dataManager.noteCache.set(nodeId, { md: newText });
        this.showToast('노트 내용이 브라우저에 임시 저장되었습니다.', 2000);
      },
      onAskAi: (prompt) => {
        this.sendAiMessage(prompt);
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
    // 잠금 해제
    this.unlockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = this.passInput.value.trim();
      if (!pass) return;
      await this.attemptUnlock(pass, false);
    });

    // 검색창 입력 이벤트 -> 중앙 집중 정렬
    this.searchInput.addEventListener('input', () => this.handleFilterChange());
    this.searchClear.addEventListener('click', () => {
      this.searchInput.value = '';
      this.searchClear.classList.remove('visible');
      this.handleFilterChange();
    });

    // 모바일 드롭다운 검색창 제어
    const mobileSearchBar = document.getElementById('mobile-search-bar');
    const mobileSearchInput = document.getElementById('mobile-search-input');
    const mobileSearchClear = document.getElementById('mobile-search-clear');

    document.getElementById('btn-mobile-search-toggle')?.addEventListener('click', () => {
      mobileSearchBar?.classList.toggle('hidden');
      if (!mobileSearchBar?.classList.contains('hidden')) {
        mobileSearchInput?.focus();
      }
    });

    mobileSearchInput?.addEventListener('input', (e) => {
      this.searchInput.value = e.target.value;
      this.handleFilterChange();
    });

    mobileSearchClear?.addEventListener('click', () => {
      if (mobileSearchInput) mobileSearchInput.value = '';
      this.searchInput.value = '';
      this.handleFilterChange();
      mobileSearchBar?.classList.add('hidden');
    });

    // 모바일 바텀시트 제어
    const mobileSheet = document.getElementById('mobile-tools-sheet');
    document.getElementById('btn-mobile-menu')?.addEventListener('click', () => {
      mobileSheet?.classList.remove('hidden');
    });
    document.getElementById('btn-close-sheet')?.addEventListener('click', () => {
      mobileSheet?.classList.add('hidden');
    });

    // 모바일 바텀시트 내부 액션 버튼들
    document.getElementById('mobile-color-select')?.addEventListener('change', (e) => {
      this.graphView.setColorMode(e.target.value);
      const desktopColorSelect = document.getElementById('color-mode-select');
      if (desktopColorSelect) desktopColorSelect.value = e.target.value;
      mobileSheet?.classList.add('hidden');
    });

    document.getElementById('mobile-folder-filter')?.addEventListener('change', (e) => {
      this.folderSelect.value = e.target.value;
      this.handleFilterChange();
      mobileSheet?.classList.add('hidden');
    });

    document.getElementById('mobile-tag-filter')?.addEventListener('change', (e) => {
      this.tagSelect.value = e.target.value;
      this.handleFilterChange();
      mobileSheet?.classList.add('hidden');
    });

    document.getElementById('mobile-btn-3d')?.addEventListener('click', () => {
      mobileSheet?.classList.add('hidden');
      document.getElementById('btn-toggle-3d')?.click();
    });

    document.getElementById('mobile-btn-orphan')?.addEventListener('click', () => {
      mobileSheet?.classList.add('hidden');
      document.getElementById('btn-orphan-filter')?.click();
    });

    document.getElementById('mobile-btn-timeline')?.addEventListener('click', () => {
      mobileSheet?.classList.add('hidden');
      document.getElementById('btn-toggle-timeline')?.click();
    });

    document.getElementById('mobile-btn-export')?.addEventListener('click', () => {
      mobileSheet?.classList.add('hidden');
      document.getElementById('btn-export-png')?.click();
    });

    document.getElementById('mobile-btn-physics')?.addEventListener('click', () => {
      mobileSheet?.classList.add('hidden');
      this.physicsPanel?.classList.toggle('hidden');
    });

    document.getElementById('mobile-btn-gemini')?.addEventListener('click', () => {
      mobileSheet?.classList.add('hidden');
      document.getElementById('btn-gemini-settings')?.click();
    });

    document.getElementById('mobile-btn-reset')?.addEventListener('click', () => {
      mobileSheet?.classList.add('hidden');
      this.graphView.resetView();
    });

    document.getElementById('mobile-btn-lock')?.addEventListener('click', () => {
      mobileSheet?.classList.add('hidden');
      document.getElementById('btn-lock')?.click();
    });

    // 필터
    this.folderSelect.addEventListener('change', () => this.handleFilterChange());
    this.tagSelect.addEventListener('change', () => this.handleFilterChange());

    // 색상 테마 모드 선택
    document.getElementById('color-mode-select')?.addEventListener('change', (e) => {
      this.graphView.setColorMode(e.target.value);
    });

    // 3D / 2D 우주 모드 전환
    document.getElementById('btn-toggle-3d')?.addEventListener('click', (e) => {
      this.graphView.toggle3D();
      const is3D = this.graphView.mode3D;
      e.currentTarget.style.color = is3D ? '#a855f7' : 'inherit';
      this.showToast(is3D ? '🌐 3D 우주 은하 모드로 전환되었습니다.' : '2D 평면 그래프로 전환되었습니다.', 2000);
    });

    // 고아 노트(Orphan) 발굴 필터
    document.getElementById('btn-orphan-filter')?.addEventListener('click', (e) => {
      this.graphView.toggleOrphansOnly();
      const active = this.graphView.showOrphansOnly;
      e.currentTarget.style.color = active ? '#ef4444' : 'inherit';
      const orphans = this.rawNodes.filter(n => !n.neighbors || n.neighbors.size === 0);
      this.showToast(active ? `🔍 연결선 없는 고아 노트 ${orphans.length}개 강조` : '전체 노드 표시로 복귀', 2000);
    });

    // 고해상도 PNG 이미지 내보내기
    document.getElementById('btn-export-png')?.addEventListener('click', () => {
      this.graphView.exportPng();
      this.showToast('📸 그래프 고해상도 이미지가 다운로드되었습니다.', 2000);
    });

    // 이웃 탐색 뎁스 (Depth 1, 2, 3)
    document.querySelectorAll('.btn-depth').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-depth').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const depth = btn.dataset.depth;
        this.graphView.setDepth(depth);
        this.showToast(`이웃 탐색 뎁스: ${depth}단계 적용`, 1500);
      });
    });

    // 시간 여행 타임랩스 토글 & 제어
    const timelinePlayer = document.getElementById('timeline-player');
    const btnTimelinePlay = document.getElementById('btn-timeline-play');
    const sliderTimeline = document.getElementById('slider-timeline');
    const labelTimelineDate = document.getElementById('timeline-date-label');
    let timelineTimer = null;

    document.getElementById('btn-toggle-timeline')?.addEventListener('click', () => {
      timelinePlayer?.classList.toggle('hidden');
    });
    document.getElementById('btn-timeline-close')?.addEventListener('click', () => {
      timelinePlayer?.classList.add('hidden');
      if (timelineTimer) clearInterval(timelineTimer);
      btnTimelinePlay.textContent = '▶';
      this.graphView.setTimelineCutoff(null);
    });

    // 타임라인 재생/일시정지
    btnTimelinePlay?.addEventListener('click', () => {
      if (timelineTimer) {
        clearInterval(timelineTimer);
        timelineTimer = null;
        btnTimelinePlay.textContent = '▶';
      } else {
        btnTimelinePlay.textContent = '⏸';
        if (Number(sliderTimeline.value) >= 100) sliderTimeline.value = 0;

        timelineTimer = setInterval(() => {
          let val = Number(sliderTimeline.value) + 2;
          if (val > 100) {
            val = 100;
            clearInterval(timelineTimer);
            timelineTimer = null;
            btnTimelinePlay.textContent = '▶';
          }
          sliderTimeline.value = val;
          updateTimelineView(val);
        }, 120);
      }
    });

    const updateTimelineView = (percent) => {
      if (!this.rawNodes.length) return;
      const sortedTimestamps = this.rawNodes
        .map(n => new Date(n.edited || 0).getTime())
        .sort((a, b) => a - b);
      const minTime = sortedTimestamps[0] || Date.now();
      const maxTime = sortedTimestamps[sortedTimestamps.length - 1] || Date.now();

      if (percent >= 100) {
        labelTimelineDate.textContent = '전체 기간';
        this.graphView.setTimelineCutoff(null);
      } else {
        const targetTime = minTime + (maxTime - minTime) * (percent / 100);
        const d = new Date(targetTime);
        labelTimelineDate.textContent = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
        this.graphView.setTimelineCutoff(targetTime);
      }
    };

    sliderTimeline?.addEventListener('input', (e) => {
      updateTimelineView(Number(e.target.value));
    });

    // 뷰 컨트롤
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => this.graphView.zoomIn());
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => this.graphView.zoomOut());
    document.getElementById('btn-reset-view')?.addEventListener('click', () => this.graphView.resetView());

    // 물리 제어 패널 토글
    this.btnTogglePhysics?.addEventListener('click', () => {
      this.physicsPanel?.classList.toggle('hidden');
    });
    document.getElementById('physics-close')?.addEventListener('click', () => {
      this.physicsPanel?.classList.add('hidden');
    });

    // 슬라이더 이벤트
    document.getElementById('slider-charge')?.addEventListener('input', (e) => {
      this.graphView.setParam('chargeStrength', Number(e.target.value));
      document.getElementById('val-charge').textContent = e.target.value;
    });
    document.getElementById('slider-link-dist')?.addEventListener('input', (e) => {
      this.graphView.setParam('linkDistance', Number(e.target.value));
      document.getElementById('val-link-dist').textContent = e.target.value;
    });
    document.getElementById('slider-gravity')?.addEventListener('input', (e) => {
      this.graphView.setParam('centerStrength', Number(e.target.value));
      document.getElementById('val-gravity').textContent = e.target.value;
    });
    document.getElementById('slider-node-size')?.addEventListener('input', (e) => {
      this.graphView.setParam('nodeSizeScale', Number(e.target.value));
      document.getElementById('val-node-size').textContent = `${e.target.value}x`;
    });
    document.getElementById('check-particles')?.addEventListener('change', (e) => {
      this.graphView.setParam('particlesEnabled', e.target.checked);
    });

    // Gemini API 키 설정 모달
    document.getElementById('btn-gemini-settings')?.addEventListener('click', () => {
      this.geminiKeyInput.value = this.gemini.apiKey;
      this.geminiModal?.classList.remove('hidden');
    });
    document.getElementById('gemini-modal-close')?.addEventListener('click', () => {
      this.geminiModal?.classList.add('hidden');
    });
    this.geminiForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const key = this.geminiKeyInput.value.trim();
      this.gemini.setApiKey(key);
      this.geminiModal?.classList.add('hidden');
      this.showToast(key ? 'Gemini API 키가 저장되었습니다.' : 'Gemini API 키가 제거되었습니다.', 2000);
    });

    // AI 챗봇 폼 전송
    this.aiChatForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = this.aiChatInput.value.trim();
      if (!q) return;
      this.aiChatInput.value = '';
      this.sendAiMessage(q);
    });

    // 로그아웃
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

      // 1. 그래프 렌더링
      this.graphView.init(graph);
      this.updateHudAndFilters(graph);

      // 2. 좌측 탐색기 목록 렌더링
      this.explorerView.setNodes(this.rawNodes);

      this.showToast(`노트 ${this.rawNodes.length}개와 지식망을 불러왔습니다!`, 2500);

      // 3. 백그라운드 검색 인덱스 로드
      this.dataManager.loadSearch().then(searchDocs => {
        this.searchDocs = searchDocs;
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
    const mobileFolder = document.getElementById('mobile-folder-filter');
    if (mobileFolder) mobileFolder.innerHTML = '<option value="">모든 폴더</option>';

    Array.from(folders).sort().forEach(f => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = `📁 ${f}`;
      this.folderSelect.appendChild(opt);
      if (mobileFolder) mobileFolder.appendChild(opt.cloneNode(true));
    });

    this.tagSelect.innerHTML = '<option value="">모든 태그</option>';
    const mobileTag = document.getElementById('mobile-tag-filter');
    if (mobileTag) mobileTag.innerHTML = '<option value="">모든 태그</option>';

    Array.from(tags).sort().forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = `#${t}`;
      this.tagSelect.appendChild(opt);
      if (mobileTag) mobileTag.appendChild(opt.cloneNode(true));
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

    // 그래프 뷰에 필터 및 중앙 집중 재정렬 적용
    this.graphView.applyFilter(matchedIds);
  }

  async sendAiMessage(question) {
    if (!this.aiMessages) return;

    if (!this.gemini.hasApiKey()) {
      document.getElementById('btn-gemini-settings')?.click();
      return;
    }

    // 사용자 메시지 버블
    this.appendAiChatBubble(question, 'user');

    // AI 로딩 버블
    const loadingBubble = this.appendAiChatBubble('<span class="spinner"></span> 지식창고를 검색하여 답변을 작성하고 있습니다...', 'assistant');

    try {
      const currentNode = this.sidebarView?.currentNode;
      const answer = await this.gemini.ask({
        question,
        currentNode,
        allSearchDocs: this.searchDocs
      });

      let formattedAnswer = answer;
      if (typeof window.marked !== 'undefined') {
        const raw = window.marked.parse(answer);
        formattedAnswer = typeof window.DOMPurify !== 'undefined' ? window.DOMPurify.sanitize(raw) : raw;
      }
      loadingBubble.innerHTML = formattedAnswer;
    } catch (err) {
      loadingBubble.innerHTML = `<span style="color:var(--danger-color);">${err.message}</span>`;
    }
  }

  appendAiChatBubble(htmlText, role) {
    const bubble = document.createElement('div');
    bubble.className = `ai-chat-bubble ${role}`;
    bubble.innerHTML = htmlText;
    this.aiMessages.appendChild(bubble);
    this.aiMessages.scrollTop = this.aiMessages.scrollHeight;
    return bubble;
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
