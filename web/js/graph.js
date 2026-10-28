// 하이브리드 2D & 3D 지식 그래프 엔진
// (3D 우주 은하 모드, 뎁스 확장, 히트맵/허브 컬러 모드, 타임랩스, 고해상도 캡처 지원)

export class GraphView {
  constructor({ containerId, onNodeClick, onBackgroundClick }) {
    this.container = document.getElementById(containerId);
    this.onNodeClick = onNodeClick;
    this.onBackgroundClick = onBackgroundClick;

    this.graphInstance = null;
    this.mode3D = false; // false = 2D, true = 3D
    this.rawNodes = [];
    this.rawEdges = [];
    this.nodes = [];
    this.links = [];
    this.nodeMap = new Map();

    // 상태 관리
    this.selectedNode = null;
    this.hoverNode = null;
    this.highlightNodes = new Set();
    this.highlightLinks = new Set();
    this.filterMatchIds = null;

    // 고급 기능 옵션
    this.colorMode = 'folder'; // folder, tag, heatmap, hub
    this.filterDepth = 0; // 0 = 전체, 1 = 1단계, 2 = 2단계, 3 = 3단계
    this.showOrphansOnly = false;
    this.timelineCutoff = null; // 타임랩스용 특정 시점

    // 물리 및 애니메이션 파라미터
    this.params = {
      chargeStrength: -160,
      linkDistance: 60,
      centerStrength: 0.15,
      nodeSizeScale: 1.0,
      particlesEnabled: true
    };

    // 폴더 및 태그 컬러 팔레트
    this.colorMap = new Map();
    this.colorPalette = [
      '#a855f7', '#3b82f6', '#10b981', '#f59e0b',
      '#ec4899', '#06b6d4', '#84cc16', '#8b5cf6',
      '#f97316', '#14b8a6', '#6366f1', '#eab308'
    ];
  }

  calcNodeRadius(node) {
    const neighborsCount = node.neighbors ? node.neighbors.size : 0;
    // 제곱근 완충 스케일링: 최소 4.2px, 최대 9.5px
    const scaledIncrement = Math.min(5.5, Math.sqrt(neighborsCount) * 1.1);
    const baseRadius = 4.2 + scaledIncrement;
    return baseRadius * (this.params.nodeSizeScale || 1.0);
  }

  getColor(node) {
    // 1. 고아 노드 강조 모드
    if (this.showOrphansOnly) {
      const isOrphan = !node.neighbors || node.neighbors.size === 0;
      return isOrphan ? '#ef4444' : 'rgba(75, 85, 99, 0.2)';
    }

    // 2. 수정일 히트맵 모드 (최신: 오렌지/핑크, 오래됨: 차가운 블루)
    if (this.colorMode === 'heatmap') {
      const edited = new Date(node.edited || 0).getTime();
      const now = Date.now();
      const diffDays = Math.max(0, (now - edited) / (1000 * 60 * 60 * 24));
      if (diffDays <= 3) return '#f43f5e'; // 3일 이내 최신: 네온 핑크
      if (diffDays <= 14) return '#fb923c'; // 2주 이내: 따뜻한 오렌지
      if (diffDays <= 30) return '#a855f7'; // 1달 이내: 퍼플
      if (diffDays <= 90) return '#3b82f6'; // 3달 이내: 블루
      return '#64748b'; // 3달 이상: 쿨 그레이
    }

    // 3. 지식 허브 모드 (연결 중심성)
    if (this.colorMode === 'hub') {
      const count = node.neighbors ? node.neighbors.size : 0;
      if (count >= 5) return '#fbbf24'; // 초거대 허브: 눈부신 골드
      if (count >= 3) return '#a855f7'; // 중간 허브: 퍼플
      if (count >= 1) return '#38bdf8'; // 일반 노드: 하늘색
      return '#6b7280'; // 고아 노드: 어두운 회색
    }

    // 4. 태그별 색상 모드
    if (this.colorMode === 'tag') {
      const tag = (node.tags && node.tags.length > 0) ? node.tags[0] : '태그없음';
      if (!this.colorMap.has('tag_' + tag)) {
        const idx = this.colorMap.size % this.colorPalette.length;
        this.colorMap.set('tag_' + tag, this.colorPalette[idx]);
      }
      return this.colorMap.get('tag_' + tag);
    }

    // 5. 기본 폴더별 색상 모드
    const folder = node.folder || '기본';
    if (!this.colorMap.has('folder_' + folder)) {
      const idx = this.colorMap.size % this.colorPalette.length;
      this.colorMap.set('folder_' + folder, this.colorPalette[idx]);
    }
    return this.colorMap.get('folder_' + folder);
  }

  init(data) {
    this.rawNodes = data.nodes || [];
    this.rawEdges = data.edges || [];

    // 만약 엣지가 0개라면 클라이언트 측 지식 연결망 보강
    if (this.rawEdges.length === 0 && this.rawNodes.length > 1) {
      this.rawEdges = this.generateFallbackEdges(this.rawNodes);
    }

    this.rebuildGraphData();
    this.render();
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

  rebuildGraphData() {
    this.nodes = this.rawNodes.map(n => ({ ...n }));
    this.links = this.rawEdges.map(([source, target]) => ({ source, target }));

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
  }

  render() {
    // 기존 인스턴스 정리
    this.container.innerHTML = '';

    if (this.mode3D) {
      this.render3D();
    } else {
      this.render2D();
    }
  }

  /* ───── 2D 평면 렌더링 ───── */
  render2D() {
    if (typeof window.ForceGraph === 'undefined') return;

    this.graphInstance = window.ForceGraph()(this.container)
      .graphData({ nodes: this.nodes, links: this.links })
      .backgroundColor('#121316')
      .nodeId('id')
      .nodeVal(n => this.calcNodeRadius(n))
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
        return 'rgba(99, 102, 241, 0.45)';
      })
      .linkDirectionalParticles(link => (this.params.particlesEnabled ? (this.highlightLinks.has(link) ? 4 : 2) : 0))
      .linkDirectionalParticleSpeed(0.007)
      .linkDirectionalParticleWidth(link => (this.highlightLinks.has(link) ? 3 : 1.8))
      .linkDirectionalParticleColor(() => '#a855f7')
      .nodeCanvasObject((node, ctx, globalScale) => {
        // 타임라인 컷오프 이전 노드만 가시화
        if (this.timelineCutoff && new Date(node.edited || 0).getTime() > this.timelineCutoff) {
          return;
        }

        const isSelected = this.selectedNode === node;
        const isHovered = this.hoverNode === node;
        const isHighlighted = this.highlightNodes.has(node);

        let isDimmed = false;
        if (this.filterMatchIds !== null && !this.filterMatchIds.has(node.id)) {
          isDimmed = true;
        } else if (this.highlightNodes.size > 0 && !isHighlighted) {
          isDimmed = true;
        }

        const size = this.calcNodeRadius(node);
        const color = this.getColor(node);

        if ((isSelected || isHovered) && !isDimmed) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, size + 4, 0, 2 * Math.PI, false);
          ctx.fillStyle = 'rgba(168, 85, 247, 0.35)';
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
        ctx.fillStyle = isDimmed ? 'rgba(75, 85, 99, 0.15)' : ((isSelected || isHovered) ? '#ffffff' : color);
        ctx.fill();

        if ((isSelected || isHovered) && !isDimmed) {
          ctx.strokeStyle = '#a855f7';
          ctx.lineWidth = 2.5 / globalScale;
          ctx.stroke();
        }

        const showLabel = !isDimmed && (globalScale > 1.2 || isSelected || isHovered || isHighlighted || size > 6);
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
        const size = this.calcNodeRadius(node) + 4;
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

    this.updatePhysics();
  }

  /* ───── 3D 우주 은하 모드 렌더링 ───── */
  render3D() {
    if (typeof window.ForceGraph3D === 'undefined') {
      console.warn('3D Force Graph 라이브러리가 로드되지 않았습니다.');
      return;
    }

    this.graphInstance = window.ForceGraph3D()(this.container)
      .graphData({ nodes: this.nodes, links: this.links })
      .backgroundColor('#0d0e12')
      .nodeId('id')
      .nodeLabel(n => `${n.title} (${n.folder || '기본'})`)
      .nodeVal(n => this.calcNodeRadius(n))
      .nodeColor(n => this.getColor(n))
      .linkWidth(link => (this.highlightLinks.has(link) ? 3 : 1))
      .linkColor(() => 'rgba(99, 102, 241, 0.5)')
      .linkDirectionalParticles(this.params.particlesEnabled ? 3 : 0)
      .linkDirectionalParticleSpeed(0.008)
      .linkDirectionalParticleWidth(2)
      .linkDirectionalParticleColor(() => '#a855f7')
      .onNodeClick(node => {
        this.selectNode(node);
        if (this.onNodeClick) this.onNodeClick(node);
      })
      .onBackgroundClick(() => {
        this.clearSelection();
        if (this.onBackgroundClick) this.onBackgroundClick();
      });

    // 3D 카메라 천천히 공전(Orbit) 애니메이션
    const distance = 400;
    let angle = 0;
    const interval = setInterval(() => {
      if (!this.mode3D || this.selectedNode) return;
      angle += Math.PI / 1200;
      this.graphInstance.cameraPosition({
        x: distance * Math.sin(angle),
        z: distance * Math.cos(angle)
      });
    }, 40);
  }

  toggle3D() {
    this.mode3D = !this.mode3D;
    this.render();
  }

  updatePhysics() {
    if (!this.graphInstance || this.mode3D) return;
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
      if (!this.mode3D) {
        this.graphInstance.linkDirectionalParticles(this.graphInstance.linkDirectionalParticles());
      }
    } else {
      this.updatePhysics();
    }
  }

  setColorMode(mode) {
    this.colorMode = mode;
    if (this.graphInstance) {
      if (this.mode3D) {
        this.graphInstance.nodeColor(n => this.getColor(n));
      } else {
        this.graphInstance.nodeColor(this.graphInstance.nodeColor());
      }
    }
  }

  setDepth(depth) {
    this.filterDepth = Number(depth);
    if (this.selectedNode) {
      this.selectNode(this.selectedNode);
    }
  }

  toggleOrphansOnly() {
    this.showOrphansOnly = !this.showOrphansOnly;
    if (this.graphInstance) {
      if (!this.mode3D) {
        this.graphInstance.nodeColor(this.graphInstance.nodeColor());
      } else {
        this.graphInstance.nodeColor(n => this.getColor(n));
      }
    }
  }

  setTimelineCutoff(timestamp) {
    this.timelineCutoff = timestamp;
    if (this.graphInstance && !this.mode3D) {
      this.graphInstance.nodeColor(this.graphInstance.nodeColor());
    }
  }

  /* ───── N단계 뎁스(Depth) 이웃 확장 계산 ───── */
  selectNode(node) {
    this.selectedNode = node;
    this.highlightNodes.clear();
    this.highlightLinks.clear();

    if (node) {
      this.highlightNodes.add(node);

      // 뎁스 1단계: 직접 연결된 이웃
      const currentLevel = new Set(node.neighbors || []);
      currentLevel.forEach(n => this.highlightNodes.add(n));
      (node.links || []).forEach(l => this.highlightLinks.add(l));

      // 뎁스 2단계 이상 확장
      const maxDepth = this.filterDepth > 0 ? this.filterDepth : 1;
      let lastVisited = new Set(currentLevel);

      for (let d = 2; d <= maxDepth; d++) {
        const nextLevel = new Set();
        for (const n of lastVisited) {
          if (n.neighbors) {
            for (const neighbor of n.neighbors) {
              if (!this.highlightNodes.has(neighbor)) {
                this.highlightNodes.add(neighbor);
                nextLevel.add(neighbor);
              }
            }
          }
          if (n.links) {
            n.links.forEach(l => this.highlightLinks.add(l));
          }
        }
        lastVisited = nextLevel;
      }

      // 카메라 부드러운 패닝
      if (!this.mode3D) {
        this.graphInstance.centerAt(node.x, node.y, 800);
        this.graphInstance.zoom(2.2, 800);
      } else {
        const distance = 120;
        const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
        this.graphInstance.cameraPosition(
          { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
          node,
          1500
        );
      }
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
    if (this.graphInstance && !this.mode3D) {
      this.graphInstance.nodeColor(this.graphInstance.nodeColor());

      if (matchedIdsSet && matchedIdsSet.size > 0) {
        this.graphInstance.zoomToFit(800, 70, node => matchedIdsSet.has(node.id));
        const matchedNodes = this.nodes.filter(n => matchedIdsSet.has(n.id));
        for (const n of matchedNodes) {
          n.vx = (n.vx || 0) * 0.5 - (n.x || 0) * 0.05;
          n.vy = (n.vy || 0) * 0.5 - (n.y || 0) * 0.05;
        }
        this.graphInstance.d3ReheatSimulation();
      }
    }
  }

  /**
   * 고해상도 이미지 내보내기 (Export PNG)
   */
  exportPng() {
    const canvas = this.container.querySelector('canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `notion-knowledge-graph-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  zoomIn() {
    if (this.graphInstance && !this.mode3D) this.graphInstance.zoom(this.graphInstance.zoom() * 1.4, 400);
  }

  zoomOut() {
    if (this.graphInstance && !this.mode3D) this.graphInstance.zoom(this.graphInstance.zoom() / 1.4, 400);
  }

  resetView() {
    this.clearSelection();
    if (this.graphInstance) {
      if (!this.mode3D) this.graphInstance.zoomToFit(800, 50);
      else this.graphInstance.cameraPosition({ x: 0, y: 0, z: 450 }, { x: 0, y: 0, z: 0 }, 1000);
    }
  }
}
