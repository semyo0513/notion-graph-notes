export class GraphView {
  constructor({ containerId, onNodeClick, onBackgroundClick }) {
    this.container = document.getElementById(containerId);
    this.onNodeClick = onNodeClick;
    this.onBackgroundClick = onBackgroundClick;

    this.graphInstance = null;
    this.nodes = [];
    this.links = [];
    this.nodeMap = new Map();

    // 상태 관리
    this.selectedNode = null;
    this.hoverNode = null;
    this.highlightNodes = new Set();
    this.highlightLinks = new Set();
    this.filterMatchIds = null; // null이면 전체 표시

    // 폴더별 고유 컬러 팔레트
    this.folderColors = new Map();
    this.colorPalette = [
      '#a855f7', '#3b82f6', '#10b981', '#f59e0b',
      '#ec4899', '#06b6d4', '#84cc16', '#8b5cf6',
      '#f97316', '#14b8a6', '#6366f1', '#eab308'
    ];
  }

  getFolderColor(folder) {
    const key = folder || '기본';
    if (!this.folderColors.has(key)) {
      const idx = this.folderColors.size % this.colorPalette.length;
      this.folderColors.set(key, this.colorPalette[idx]);
    }
    return this.folderColors.get(key);
  }

  init(data) {
    this.nodes = (data.nodes || []).map(n => ({ ...n }));
    this.links = (data.edges || []).map(([source, target]) => ({ source, target }));

    this.nodeMap.clear();
    for (const n of this.nodes) {
      n.neighbors = new Set();
      n.links = new Set();
      this.nodeMap.set(n.id, n);
    }

    // 이웃 노드 및 링크 참조 바인딩
    for (const l of this.links) {
      const a = this.nodeMap.get(typeof l.source === 'object' ? l.source.id : l.source);
      const b = this.nodeMap.get(typeof l.target === 'object' ? l.target.id : l.target);
      if (a && b) {
        a.neighbors.add(b);
        b.neighbors.add(a);
        a.links.add(l);
        b.links.add(l);
      }
    }

    if (typeof window.ForceGraph === 'undefined') {
      console.error('ForceGraph 라이브러리가 로드되지 않았습니다.');
      return;
    }

    // force-graph 인스턴스 생성
    this.graphInstance = window.ForceGraph()(this.container)
      .graphData({ nodes: this.nodes, links: this.links })
      .backgroundColor('#121316')
      .nodeId('id')
      .nodeVal(n => 2 + (n.neighbors ? n.neighbors.size * 0.8 : 1))
      .linkSource('source')
      .linkTarget('target')
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .cooldownTicks(150)
      .linkWidth(link => (this.highlightLinks.has(link) ? 2.5 : 1))
      .linkColor(link => {
        if (this.highlightLinks.size > 0) {
          return this.highlightLinks.has(link) ? 'rgba(168, 85, 247, 0.9)' : 'rgba(46, 51, 66, 0.15)';
        }
        return 'rgba(75, 85, 99, 0.4)';
      })
      .nodeCanvasObject((node, ctx, globalScale) => {
        const isSelected = this.selectedNode === node;
        const isHovered = this.hoverNode === node;
        const isHighlighted = this.highlightNodes.has(node);

        let isDimmed = false;
        if (this.filterMatchIds !== null && !this.filterMatchIds.has(node.id)) {
          isDimmed = true;
        } else if (this.highlightNodes.size > 0 && !isHighlighted) {
          isDimmed = true;
        }

        const size = Math.max(3, 2 + (node.neighbors ? node.neighbors.size * 0.6 : 1));
        const color = this.getFolderColor(node.folder);

        // 노드 원 그리기
        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);

        if (isDimmed) {
          ctx.fillStyle = 'rgba(75, 85, 99, 0.15)';
        } else if (isSelected || isHovered) {
          ctx.fillStyle = '#ffffff';
        } else {
          ctx.fillStyle = color;
        }
        ctx.fill();

        // 선택/호버 테두리 링
        if ((isSelected || isHovered) && !isDimmed) {
          ctx.strokeStyle = '#a855f7';
          ctx.lineWidth = 2.5 / globalScale;
          ctx.stroke();
        }

        // 텍스트 라벨 렌더링
        const showLabel = !isDimmed && (globalScale > 1.4 || isSelected || isHovered || isHighlighted || size > 6);
        if (showLabel) {
          const label = node.title || '';
          const fontSize = Math.max(10 / globalScale, 3);
          ctx.font = `${fontSize}px -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';

          ctx.fillStyle = isDimmed ? 'rgba(156, 163, 175, 0.2)' : (isSelected ? '#a855f7' : '#e5e7eb');
          ctx.fillText(label, node.x, node.y + size + 2);
        }
      })
      .nodePointerAreaPaint((node, color, ctx) => {
        const size = Math.max(6, 2 + (node.neighbors ? node.neighbors.size * 0.6 : 1) + 4);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
        ctx.fill();
      })
      .onNodeHover(node => {
        this.hoverNode = node || null;
        this.container.style.cursor = node ? 'pointer' : 'default';
      })
      .onNodeClick(node => {
        this.selectNode(node);
        if (this.onNodeClick) this.onNodeClick(node);
      })
      .onBackgroundClick(() => {
        this.clearSelection();
        if (this.onBackgroundClick) this.onBackgroundClick();
      });

    // 윈도우 리사이즈 대응
    window.addEventListener('resize', () => {
      if (this.graphInstance) {
        this.graphInstance.width(this.container.clientWidth);
        this.graphInstance.height(this.container.clientHeight);
      }
    });
  }

  selectNode(node) {
    this.selectedNode = node;
    this.highlightNodes.clear();
    this.highlightLinks.clear();

    if (node) {
      this.highlightNodes.add(node);
      if (node.neighbors) {
        node.neighbors.forEach(neighbor => this.highlightNodes.add(neighbor));
      }
      if (node.links) {
        node.links.forEach(link => this.highlightLinks.add(link));
      }

      // 카메라 부드러운 패닝
      this.graphInstance.centerAt(node.x, node.y, 800);
      this.graphInstance.zoom(2.2, 800);
    }
  }

  selectNodeById(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (node) {
      this.selectNode(node);
      if (this.onNodeClick) this.onNodeClick(node);
    }
  }

  clearSelection() {
    this.selectedNode = null;
    this.highlightNodes.clear();
    this.highlightLinks.clear();
  }

  applyFilter(matchedIdsSet) {
    this.filterMatchIds = matchedIdsSet;
    if (this.graphInstance) {
      // 캔버스 재렌더링 트리거
      this.graphInstance.nodeColor(this.graphInstance.nodeColor());
    }
  }

  zoomIn() {
    if (this.graphInstance) {
      this.graphInstance.zoom(this.graphInstance.zoom() * 1.4, 400);
    }
  }

  zoomOut() {
    if (this.graphInstance) {
      this.graphInstance.zoom(this.graphInstance.zoom() / 1.4, 400);
    }
  }

  resetView() {
    this.clearSelection();
    if (this.graphInstance) {
      this.graphInstance.zoomToFit(800, 50);
    }
  }
}
