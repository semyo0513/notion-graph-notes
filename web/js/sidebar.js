export class SidebarView {
  constructor({ containerId, onSelectNode }) {
    this.container = document.getElementById(containerId);
    this.onSelectNode = onSelectNode;
    this.closeBtn = this.container.querySelector('.sidebar-close');
    this.titleEl = this.container.querySelector('.sidebar-title');
    this.metaTagsEl = this.container.querySelector('.sidebar-meta-tags');
    this.bodyEl = this.container.querySelector('.sidebar-body');
    this.footerEl = this.container.querySelector('.sidebar-footer');
    this.notionBtn = this.container.querySelector('.btn-notion');
    this.dateEl = this.container.querySelector('.sidebar-date');

    this.currentNodeId = null;
    this.initEvents();
  }

  initEvents() {
    this.closeBtn.addEventListener('click', () => this.close());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });
  }

  isOpen() {
    return this.container.classList.contains('open');
  }

  close() {
    this.container.classList.remove('open');
    this.currentNodeId = null;
  }

  open() {
    this.container.classList.add('open');
  }

  /**
   * 노드 상세 정보 및 본문 렌더링
   */
  async renderNode(node, neighborNodes, fetchContentPromise) {
    this.currentNodeId = node.id;
    this.open();

    // 1. 헤더 메타데이터
    this.titleEl.textContent = node.title || '(제목 없음)';

    // 태그 & 폴더 뱃지
    let badgesHtml = '';
    if (node.folder) {
      badgesHtml += `<span class="folder-badge">📁 ${this.escape(node.folder)}</span>`;
    }
    if (Array.isArray(node.tags)) {
      for (const t of node.tags) {
        badgesHtml += `<span class="tag-badge">#${this.escape(t)}</span>`;
      }
    }
    this.metaTagsEl.innerHTML = badgesHtml;

    // Notion 링크 버튼
    if (node.url) {
      this.notionBtn.href = node.url;
      this.notionBtn.style.display = 'inline-flex';
    } else {
      this.notionBtn.style.display = 'none';
    }

    // 수정 시각
    if (node.edited) {
      const d = new Date(node.edited);
      this.dateEl.textContent = `수정일: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      this.dateEl.textContent = '';
    }

    // 2. 본문 로딩 표시
    this.bodyEl.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; color: var(--text-muted); padding: 40px 0; justify-content: center;">
        <span class="spinner"></span> 본문 복호화 중...
      </div>
    `;

    // 3. 본문 수신 대기 및 마크다운 렌더링
    try {
      const { md } = await fetchContentPromise;
      if (this.currentNodeId !== node.id) return; // 사용자가 그 사이 다른 노드를 눌렀으면 무시

      let renderedMd = '(내용 없음)';
      if (md) {
        if (typeof window.marked !== 'undefined') {
          const rawHtml = window.marked.parse(md);
          renderedMd = typeof window.DOMPurify !== 'undefined'
            ? window.DOMPurify.sanitize(rawHtml)
            : rawHtml;
        } else {
          renderedMd = `<pre>${this.escape(md)}</pre>`;
        }
      }

      // 이웃 노드 링크 목록
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
        <div class="markdown-content">${renderedMd}</div>
        ${relationsHtml}
      `;

      // 이웃 칩 클릭 이벤트 연결
      this.bodyEl.querySelectorAll('.relation-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const targetId = chip.dataset.id;
          if (this.onSelectNode) this.onSelectNode(targetId);
        });
      });

    } catch (err) {
      if (this.currentNodeId !== node.id) return;
      this.bodyEl.innerHTML = `
        <div style="color: var(--danger-color); padding: 20px 0;">
          본문 로드 실패: ${this.escape(err.message)}
        </div>
      `;
    }
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
