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
    this.filterMatchIds = null;

    // 물리 및 애니메이션 파라미터 기본값
    this.params = {
      chargeStrength: -160,
      linkDistance: 60,
      centerStrength: 0.15,
      nodeSizeScale: 1.0,
      particlesEnabled: true
    };

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
    let rawEdges = data.edges || [];

    // 만약 엣지가 0개라면 클라이언트에서 태그/폴더 기반 연결선 자동 생성 보강
    if (rawEdges.length === 0 && this.nodes.length > 1) {
      console.log('• 연결선이 없어 클라이언트 측 지식 연결망을 자동 생성합니다.');
      rawEdges = this.generateFallbackEdges(this.nodes);
    }

    this.links = rawEdges.map(([source, target]) => ({ source, target }));

    this.nodeMap.clear();
    for (const n of this.nodes) {
      n.neighbors = new Set();
      n.links = new Set();
      this.nodeMap.set(n.id, n);
    }

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

    if (typeof window.ForceGraph === 'undefined') return;

    this.graphInstance = window.ForceGraph()(this.container)
      .graphData({ nodes: this.nodes, links: this.links })
      .backgroundColor('#121316')
      .nodeId('id')
      .nodeVal(n => (2 + (n.neighbors ? n.neighbors.size * 0.8 : 1)) * this.params.nodeSizeScale)
      .linkSource('source')
      .linkTarget('target')
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .cooldownTicks(150)
      .linkWidth(link => (this.highlightLinks.has(link) ? 2.5 : 1.2))
      .linkColor(link => {
        if (this.highlightLinks.size > 0) {
          return this.highlightLinks.has(link) ? 'rgba(168, 85, 247, 0.95)' : 'rgba(46, 51, 66, 0.12)';
        }
        return 'rgba(99, 102, 241, 0.45)'; // 세련된 퍼플블루 엣지
      })
      // 연결선 파티클 흐름 애니메이션
      .linkDirectionalParticles(link => (this.params.particlesEnabled ? (this.highlightLinks.has(link) ? 4 : 2) : 0))
      .linkDirectionalParticleSpeed(0.007)
      .linkDirectionalParticleWidth(link => (this.highlightLinks.has(link) ? 3 : 1.8))
      .linkDirectionalParticleColor(() => '#a855f7')
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

        const baseSize = Math.max(3, 2 + (node.neighbors ? node.neighbors.size * 0.6 : 1));
        const size = baseSize * this.params.nodeSizeScale;
        const color = this.getFolderColor(node.folder);

        // 글로우 효과 (하이라이트된 노드)
        if ((isSelected || isHovered) && !isDimmed) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, size + 4, 0, 2 * Math.PI, false);
          ctx.fillStyle = 'rgba(168, 85, 247, 0.35)';
          ctx.fill();
        }

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

        if ((isSelected || isHovered) && !isDimmed) {
          ctx.strokeStyle = '#a855f7';
          ctx.lineWidth = 2.5 / globalScale;
          ctx.stroke();
        }

        // 라벨 렌더링
        const showLabel = !isDimmed && (globalScale > 1.2 || isSelected || isHovered || isHighlighted || size > 6);
        if (showLabel) {
          const label = node.title || '';
          const fontSize = Math.max(10 / globalScale, 3);
          ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';

          ctx.fillStyle = isDimmed ? 'rgba(156, 163, 175, 0.2)' : (isSelected ? '#a855f7' : '#e5e7eb');
          ctx.fillText(label, node.x, node.y + size + 2);
        }
      })
      .nodePointerAreaPaint((node, color, ctx) => {
        const size = Math.max(6, (2 + (node.neighbors ? node.neighbors.size * 0.6 : 1) + 4) * this.params.nodeSizeScale);
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

    // 물리 엔진 초기 파라미터 적용
    this.updatePhysics();

    window.addEventListener('resize', () => {
      if (this.graphInstance) {
        this.graphInstance.width(this.container.clientWidth);
        this.graphInstance.height(this.container.clientHeight);
      }
    });
  }

  generateFallbackEdges(nodes) {
    const edges = [];
    const seen = new Set();
    const add = (a, b) => {
      if (a === b) return;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push([a, b]);
      }
    };

    // 공통 태그 또는 공통 폴더
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        if (a.tags && b.tags && a.tags.some(t => b.tags.includes(t))) {
          add(a.id, b.id);
        } else if (a.folder && b.folder && a.folder === b.folder && a.folder !== '기본') {
          add(a.id, b.id);
        }
      }
    }
    return edges;
  }

  updatePhysics() {
    if (!this.graphInstance) return;
    const charge = this.graphInstance.d3Force('charge');
    if (charge) charge.strength(this.params.chargeStrength);

    const link = this.graphInstance.d3Force('link');
    if (link) link.distance(this.params.linkDistance);

    const center = this.graphInstance.d3Force('center');
    if (center) center.strength(this.params.centerStrength);

    this.graphInstance.d3ReheatSimulation();
  }

  setParam(name, value) {
    this.params[name] = value;
    if (name === 'particlesEnabled' && this.graphInstance) {
      this.graphInstance.linkDirectionalParticles(this.graphInstance.linkDirectionalParticles());
    } else {
      this.updatePhysics();
    }
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

  /**
   * 검색어 필터링 시: 검색된 노드들을 중앙으로 모으고 화면 맞춤
   */
  applyFilter(matchedIdsSet) {
    this.filterMatchIds = matchedIdsSet;

    if (this.graphInstance) {
      // 캔버스 재렌더링 트리거
      this.graphInstance.nodeColor(this.graphInstance.nodeColor());

      if (matchedIdsSet && matchedIdsSet.size > 0) {
        // 검색된 노드들이 있으면 부드럽게 화면 중앙으로 집중 줌 인
        this.graphInstance.zoomToFit(800, 70, node => matchedIdsSet.has(node.id));

        // 검색된 노드들에게 중앙 중력을 강하게 부여하여 모이게 함
        const matchedNodes = this.nodes.filter(n => matchedIdsSet.has(n.id));
        for (const n of matchedNodes) {
          n.vx = (n.vx || 0) * 0.5 - (n.x || 0) * 0.05;
          n.vy = (n.vy || 0) * 0.5 - (n.y || 0) * 0.05;
        }
        this.graphInstance.d3ReheatSimulation();
      }
    }
  }

  zoomIn() {
    if (this.graphInstance) this.graphInstance.zoom(this.graphInstance.zoom() * 1.4, 400);
  }

  zoomOut() {
    if (this.graphInstance) this.graphInstance.zoom(this.graphInstance.zoom() / 1.4, 400);
  }

  resetView() {
    this.clearSelection();
    if (this.graphInstance) this.graphInstance.zoomToFit(800, 50);
  }
}
