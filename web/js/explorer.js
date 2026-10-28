// 좌측 파일 탐색기 및 노트 목록 뷰어 (Obsidian File Explorer 스타일)
export class ExplorerView {
  constructor({ containerId, onSelectNode }) {
    this.container = document.getElementById(containerId);
    this.onSelectNode = onSelectNode;

    this.toggleBtn = document.getElementById('btn-toggle-explorer');
    this.closeBtn = this.container.querySelector('.explorer-close');
    this.listEl = this.container.querySelector('.explorer-list');
    this.searchInput = this.container.querySelector('.explorer-search');
    this.tabFolderBtn = this.container.querySelector('#tab-folder');
    this.tabTagBtn = this.container.querySelector('#tab-tag');
    this.tabRecentBtn = this.container.querySelector('#tab-recent');

    this.nodes = [];
    this.currentMode = 'folder'; // folder, tag, recent
    this.filterText = '';

    this.initEvents();
  }

  initEvents() {
    this.toggleBtn?.addEventListener('click', () => this.toggle());
    this.closeBtn?.addEventListener('click', () => this.close());

    this.tabFolderBtn?.addEventListener('click', () => this.setMode('folder'));
    this.tabTagBtn?.addEventListener('click', () => this.setMode('tag'));
    this.tabRecentBtn?.addEventListener('click', () => this.setMode('recent'));

    this.searchInput?.addEventListener('input', (e) => {
      this.filterText = e.target.value.trim().toLowerCase();
      this.render();
    });
  }

  toggle() {
    this.container.classList.toggle('open');
  }

  open() {
    this.container.classList.add('open');
  }

  close() {
    this.container.classList.remove('open');
  }

  setNodes(nodes) {
    this.nodes = nodes || [];
    this.render();
  }

  setMode(mode) {
    this.currentMode = mode;
    [this.tabFolderBtn, this.tabTagBtn, this.tabRecentBtn].forEach(b => b?.classList.remove('active'));
    if (mode === 'folder') this.tabFolderBtn?.classList.add('active');
    if (mode === 'tag') this.tabTagBtn?.classList.add('active');
    if (mode === 'recent') this.tabRecentBtn?.classList.add('active');
    this.render();
  }

  render() {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';

    const filtered = this.nodes.filter(n => {
      if (!this.filterText) return true;
      return (n.title || '').toLowerCase().includes(this.filterText) ||
             (n.folder || '').toLowerCase().includes(this.filterText) ||
             (n.tags || []).some(t => t.toLowerCase().includes(this.filterText));
    });

    if (filtered.length === 0) {
      this.listEl.innerHTML = '<div style="padding:20px; color:var(--text-muted); font-size:13px; text-align:center;">노트가 없습니다.</div>';
      return;
    }

    if (this.currentMode === 'folder') {
      this.renderFolderView(filtered);
    } else if (this.currentMode === 'tag') {
      this.renderTagView(filtered);
    } else {
      this.renderRecentView(filtered);
    }
  }

  renderFolderView(nodes) {
    const folders = new Map();
    for (const n of nodes) {
      const f = n.folder || '기본';
      if (!folders.has(f)) folders.set(f, []);
      folders.get(f).push(n);
    }

    for (const [folderName, items] of Array.from(folders.entries()).sort()) {
      const folderDiv = document.createElement('div');
      folderDiv.className = 'explorer-group';

      const folderHeader = document.createElement('div');
      folderHeader.className = 'explorer-group-title';
      folderHeader.innerHTML = `<span>📁 ${this.escape(folderName)}</span> <span class="badge" style="font-size:10px;">${items.length}</span>`;
      folderDiv.appendChild(folderHeader);

      const itemsDiv = document.createElement('div');
      itemsDiv.className = 'explorer-items';

      for (const item of items) {
        const itemEl = this.createItemElement(item);
        itemsDiv.appendChild(itemEl);
      }

      folderHeader.addEventListener('click', () => {
        itemsDiv.classList.toggle('collapsed');
      });

      folderDiv.appendChild(itemsDiv);
      this.listEl.appendChild(folderDiv);
    }
  }

  renderTagView(nodes) {
    const tags = new Map();
    for (const n of nodes) {
      const tList = (n.tags && n.tags.length > 0) ? n.tags : ['태그없음'];
      for (const t of tList) {
        if (!tags.has(t)) tags.set(t, []);
        tags.get(t).push(n);
      }
    }

    for (const [tagName, items] of Array.from(tags.entries()).sort()) {
      const tagDiv = document.createElement('div');
      tagDiv.className = 'explorer-group';

      const tagHeader = document.createElement('div');
      tagHeader.className = 'explorer-group-title';
      tagHeader.innerHTML = `<span>#️⃣ ${this.escape(tagName)}</span> <span class="badge" style="font-size:10px;">${items.length}</span>`;
      tagDiv.appendChild(tagHeader);

      const itemsDiv = document.createElement('div');
      itemsDiv.className = 'explorer-items';

      for (const item of items) {
        const itemEl = this.createItemElement(item);
        itemsDiv.appendChild(itemEl);
      }

      tagHeader.addEventListener('click', () => {
        itemsDiv.classList.toggle('collapsed');
      });

      tagDiv.appendChild(itemsDiv);
      this.listEl.appendChild(tagDiv);
    }
  }

  renderRecentView(nodes) {
    const sorted = [...nodes].sort((a, b) => new Date(b.edited || 0) - new Date(a.edited || 0));
    const container = document.createElement('div');
    container.className = 'explorer-items';

    for (const item of sorted) {
      const itemEl = this.createItemElement(item, true);
      container.appendChild(itemEl);
    }
    this.listEl.appendChild(container);
  }

  createItemElement(node, showDate = false) {
    const el = document.createElement('div');
    el.className = 'explorer-item';

    let dateText = '';
    if (showDate && node.edited) {
      const d = new Date(node.edited);
      dateText = `<span style="font-size:10px; color:var(--text-muted); margin-left:auto;">${d.getMonth()+1}/${d.getDate()}</span>`;
    }

    el.innerHTML = `
      <span class="explorer-item-icon">📄</span>
      <span class="explorer-item-title">${this.escape(node.title || '(제목 없음)')}</span>
      ${dateText}
    `;

    el.addEventListener('click', () => {
      if (this.onSelectNode) this.onSelectNode(node.id);
    });

    return el;
  }

  escape(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
