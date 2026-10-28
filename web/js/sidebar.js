export class SidebarView {
  constructor({ containerId, onSelectNode, onSaveContent, onAskAi }) {
    this.container = document.getElementById(containerId);
    this.onSelectNode = onSelectNode;
    this.onSaveContent = onSaveContent;
    this.onAskAi = onAskAi;

    this.closeBtn = this.container.querySelector('.sidebar-close');
    this.titleEl = this.container.querySelector('.sidebar-title');
    this.metaTagsEl = this.container.querySelector('.sidebar-meta-tags');
    this.bodyEl = this.container.querySelector('.sidebar-body');
    this.notionBtn = this.container.querySelector('.btn-notion');
    this.dateEl = this.container.querySelector('.sidebar-date');

    this.tabNotesBtn = document.getElementById('tab-btn-note');
    this.tabAiBtn = document.getElementById('tab-btn-ai');
    this.viewNoteEl = document.getElementById('sidebar-view-note');
    this.viewAiEl = document.getElementById('sidebar-view-ai');

    this.currentNode = null;
    this.currentMd = '';
    this.isEditing = false;

    this.initEvents();
  }

  initEvents() {
    this.closeBtn.addEventListener('click', () => this.close());

    // 탭 전환 (노트 보기 vs Gemini AI 대화)
    this.tabNotesBtn?.addEventListener('click', () => this.switchTab('note'));
    this.tabAiBtn?.addEventListener('click', () => this.switchTab('ai'));

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });
  }

  switchTab(tab) {
    if (tab === 'note') {
      this.tabNotesBtn?.classList.add('active');
      this.tabAiBtn?.classList.remove('active');
      this.viewNoteEl?.classList.remove('hidden');
      this.viewAiEl?.classList.add('hidden');
    } else {
      this.tabAiBtn?.classList.add('active');
      this.tabNotesBtn?.classList.remove('active');
      this.viewAiEl?.classList.remove('hidden');
      this.viewNoteEl?.classList.add('hidden');
    }
  }

  isOpen() {
    return this.container.classList.contains('open');
  }

  close() {
    this.container.classList.remove('open');
    this.currentNode = null;
    this.isEditing = false;
  }

  open() {
    this.container.classList.add('open');
  }

  async renderNode(node, neighborNodes, fetchContentPromise) {
    this.currentNode = node;
    this.isEditing = false;
    this.open();
    this.switchTab('note');

    this.titleEl.textContent = node.title || '(제목 없음)';

    // 태그 & 폴더 뱃지
    let badgesHtml = '';
    if (node.folder) badgesHtml += `<span class="folder-badge">📁 ${this.escape(node.folder)}</span>`;
    if (Array.isArray(node.tags)) {
      for (const t of node.tags) badgesHtml += `<span class="tag-badge">#${this.escape(t)}</span>`;
    }
    this.metaTagsEl.innerHTML = badgesHtml;

    if (node.url) {
      this.notionBtn.href = node.url;
      this.notionBtn.style.display = 'inline-flex';
    } else {
      this.notionBtn.style.display = 'none';
    }

    if (node.edited) {
      const d = new Date(node.edited);
      this.dateEl.textContent = `수정: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    this.bodyEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; color:var(--text-muted); padding:40px 0; justify-content:center;">
        <span class="spinner"></span> 본문 복호화 중...
      </div>
    `;

    try {
      const { md } = await fetchContentPromise;
      if (this.currentNode?.id !== node.id) return;

      this.currentMd = md || '';
      this.currentNode.content = this.currentMd; // AI 연동용 본문 저장
      this.renderBodyContent(neighborNodes);
    } catch (err) {
      if (this.currentNode?.id !== node.id) return;
      this.bodyEl.innerHTML = `<div style="color:var(--danger-color); padding:20px 0;">본문 로드 실패: ${this.escape(err.message)}</div>`;
    }
  }

  renderBodyContent(neighborNodes) {
    let renderedMd = '(내용이 없습니다.)';
    if (this.currentMd) {
      if (typeof window.marked !== 'undefined') {
        const raw = window.marked.parse(this.currentMd);
        renderedMd = typeof window.DOMPurify !== 'undefined' ? window.DOMPurify.sanitize(raw) : raw;
      } else {
        renderedMd = `<pre>${this.escape(this.currentMd)}</pre>`;
      }
    }

    let relationsHtml = '';
    if (neighborNodes && neighborNodes.length > 0) {
      relationsHtml = `
        <div class="sidebar-relations">
          <div class="relations-title">연결된 노드 (${neighborNodes.length})</div>
          <div class="relation-chips">
            ${neighborNodes.map(n => `<button class="relation-chip" data-id="${n.id}">🔗 ${this.escape(n.title)}</button>`).join('')}
          </div>
        </div>
      `;
    }

    this.bodyEl.innerHTML = `
      <div class="content-toolbar">
        <button id="btn-toggle-edit" class="btn-sm">✏️ 인라인 편집</button>
        <button id="btn-ai-summarize" class="btn-sm" style="color:#c4b5fd;">🤖 AI 요약하기</button>
      </div>
      <div id="markdown-viewer" class="markdown-content">${renderedMd}</div>
      <div id="markdown-editor-container" class="hidden" style="margin-top:12px;">
        <textarea id="markdown-editor" class="editor-textarea" rows="12">${this.escape(this.currentMd)}</textarea>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
          <button id="btn-cancel-edit" class="btn-secondary" style="padding:6px 12px; font-size:12px;">취소</button>
          <button id="btn-save-edit" class="btn-submit" style="padding:6px 14px; font-size:12px;">로컬 저장</button>
        </div>
      </div>
      ${relationsHtml}
    `;

    // 이웃 노드 클릭
    this.bodyEl.querySelectorAll('.relation-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        if (this.onSelectNode) this.onSelectNode(chip.dataset.id);
      });
    });

    // 편집 토글
    const btnToggle = this.bodyEl.querySelector('#btn-toggle-edit');
    const viewer = this.bodyEl.querySelector('#markdown-viewer');
    const editorContainer = this.bodyEl.querySelector('#markdown-editor-container');
    const editorTextarea = this.bodyEl.querySelector('#markdown-editor');

    btnToggle?.addEventListener('click', () => {
      this.isEditing = !this.isEditing;
      if (this.isEditing) {
        viewer.classList.add('hidden');
        editorContainer.classList.remove('hidden');
        editorTextarea.focus();
        btnToggle.textContent = '👁️ 미리보기';
      } else {
        viewer.classList.remove('hidden');
        editorContainer.classList.add('hidden');
        btnToggle.textContent = '✏️ 인라인 편집';
      }
    });

    // 편집 저장
    this.bodyEl.querySelector('#btn-save-edit')?.addEventListener('click', () => {
      const newText = editorTextarea.value;
      this.currentMd = newText;
      if (this.currentNode) this.currentNode.content = newText;
      if (this.onSaveContent) this.onSaveContent(this.currentNode.id, newText);
      this.isEditing = false;
      this.renderBodyContent(neighborNodes);
    });

    // 편집 취소
    this.bodyEl.querySelector('#btn-cancel-edit')?.addEventListener('click', () => {
      this.isEditing = false;
      this.renderBodyContent(neighborNodes);
    });

    // AI 요약 버튼 클릭 시 AI 탭으로 전환 후 요약 실행
    this.bodyEl.querySelector('#btn-ai-summarize')?.addEventListener('click', () => {
      this.switchTab('ai');
      if (this.onAskAi) this.onAskAi('이 노트의 핵심 내용을 3가지 불릿 포인트로 명확히 요약해 줘.');
    });
  }

  escape(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
