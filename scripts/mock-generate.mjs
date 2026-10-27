// 로컬 개발/테스트용 모의 암호화 데이터 생성기
// 실제 노션 API 없이도 웹 프론트엔드의 복호화 및 그래프 기능을 즉시 검증할 수 있습니다.
import { webcrypto as crypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';

const PASSPHRASE = process.env.DATA_PASSPHRASE || 'test-passphrase-1234';
const OUT = 'dist/data';
const ITER = 600000;
const te = new TextEncoder();
const b64 = u8 => Buffer.from(u8).toString('base64');

async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function seal(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const compressed = gzipSync(te.encode(text));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

const mockNodes = [
  { id: 'n1', title: '옵시디언과 지식 관리(PKM)', folder: '생산성', tags: ['지식관리', '옵시디언', '세컨드브레인'], summary: '개인 지식 관리 시스템의 기초와 제텔카스텐 원리' },
  { id: 'n2', title: '제텔카스텐(Zettelkasten) 방법론', folder: '생산성', tags: ['지식관리', '제텔카스텐'], summary: '니클라스 루만의 메모 상자 원리와 연결 중심 노트 작성법' },
  { id: 'n3', title: '노션 API 2026 핵심 가이드', folder: '개발', tags: ['노션', 'API', 'JavaScript'], summary: 'Notion Version 2026-03-11 기준 데이터소스 쿼리 및 마크다운 엔드포인트' },
  { id: 'n4', title: '그래프 이론과 힘 기반 배치(Force-Directed)', folder: '컴퓨터과학', tags: ['알고리즘', '시각화', '그래프'], summary: 'D3 및 force-graph 라이브러리의 물리 시뮬레이션 원리' },
  { id: 'n5', title: '웹 암호화(Web Crypto API)와 PBKDF2', folder: '보안', tags: ['암호화', '보안', 'WebAPI'], summary: '브라우저 환경에서 AES-256-GCM과 PBKDF2 키 도출 안전성 확보' },
  { id: 'n6', title: 'GitHub Actions 정적 빌드 자동화', folder: '데브옵스', tags: ['CI/CD', 'GitHub', '자동화'], summary: 'GitHub Secrets와 Pages를 이용한 서버리스 빌드 및 배포 파이프라인' },
  { id: 'n7', title: '창의적인 연결과 발상법', folder: '생산성', tags: ['생각정리', '창의성'], summary: '서로 다른 도메인의 개념을 엮어 새로운 통찰을 도출하는 방법' },
  { id: 'n8', title: '클라이언트 사이드 전문 검색(FlexSearch)', folder: '개발', tags: ['검색', '성능', 'JavaScript'], summary: '수천 개의 노트를 수십 밀리초 내에 검색하는 인메모리 인덱싱' }
];

const mockEdges = [
  ['n1', 'n2'],
  ['n1', 'n3'],
  ['n1', 'n7'],
  ['n2', 'n7'],
  ['n3', 'n5'],
  ['n3', 'n6'],
  ['n4', 'n8'],
  ['n4', 'n1'],
  ['n5', 'n6'],
  ['n8', 'n3']
];

const mockContents = {
  n1: `# 옵시디언과 지식 관리(PKM)

## 개요
개인 지식 관리(Personal Knowledge Management)는 정보를 단순히 축적하는 것을 넘어, **생각의 유기적 연결망**을 구축하는 프로세스입니다.

- [x] 정보 수집 단계 확립
- [x] 정기적인 노트 연결 검토
- [ ] 주간 리뷰 루틴 자동화

### 왜 그래프 뷰인가?
노트 간의 연결(Relation)을 시각화하면 머릿속에만 있던 아이디어의 군집(Cluster)과 숨겨진 고리가 직관적으로 드러납니다.`,

  n2: `# 제텔카스텐(Zettelkasten) 방법론

사회학자 니클라스 루만이 고안한 전설적인 메모 시스템입니다.

> "하나의 생각은 다른 생각과의 연결 속에서만 진정한 가치를 가진다."

1. **임시 메모 (Fleeting notes)**: 떠오르는 순간의 메모
2. **문헌 메모 (Literature notes)**: 읽은 자료의 요약과 출처
3. **영구 메모 (Permanent notes)**: 자신의 언어로 정리된 단일 개념 노트`,

  n3: `# 노션 API 2026 핵심 가이드

노션 API의 최신 변경사항:
- \`Notion-Version: 2026-03-11\`
- \`/v1/data_sources/{id}/query\` 지원
- \`/v1/pages/{id}/markdown\` 을 통한 고속 마크다운 추출

\`\`\`javascript
const res = await fetch('https://api.notion.com/v1/pages/' + id + '/markdown', {
  headers: { Authorization: 'Bearer ' + NOTION_TOKEN }
});
\`\`\``,

  n4: `# 그래프 이론과 힘 기반 배치(Force-Directed)

노드 간의 척력(Repulsion)과 엣지의 인력(Spring force)을 물리 시뮬레이션하여 2차원/3차원 평면에 자연스럽게 배치합니다.

- 질량 및 반발 계수 설정
- 쿨롱의 법칙(Coulomb's Law)과 훅의 법칙(Hooke's Law) 적용`,

  n5: `# 웹 암호화(Web Crypto API)와 PBKDF2

깃허브 저장소가 공개(Public) 상태이더라도 클라이언트 측 암호화를 적용하면 데이터 프라이버시를 안전하게 지킬 수 있습니다.

- **PBKDF2-SHA256**: 무차별 대입(Brute-force) 공격 방어를 위해 600,000회 반복
- **AES-256-GCM**: 기밀성(Confidentiality) 및 무결성(Integrity) 검증
- **Gzip 압축**: 대역폭 절감 및 암호문 패턴 분석 방지`,

  n6: `# GitHub Actions 정적 빌드 자동화

정적 호스팅(GitHub Pages)의 한계를 Actions의 정기 스케줄(cron)로 극복합니다.
민감한 토큰은 오직 GitHub Secrets에서만 안전하게 보관됩니다.`,

  n7: `# 창의적인 연결과 발상법

스티브 잡스는 *"창의성이란 사물들을 서로 연결하는 것(Creativity is just connecting things)"*이라고 말했습니다.
서로 다른 폴더와 태그에 위치한 노트들이 엣지로 연결될 때 새로운 창의적 인사이트가 번뜩입니다.`,

  n8: `# 클라이언트 사이드 전문 검색(FlexSearch)

서버 없이 브라우저 메모리 상에서 초고속 한글/영문 전문 검색을 수행합니다.
- 토큰화(Tokenizer) 및 필터링
- 점수 기반 랭킹 및 하이라이트`
};

async function main() {
  await fs.mkdir(`${OUT}/n`, { recursive: true });

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(PASSPHRASE, salt);

  for (const node of mockNodes) {
    const md = mockContents[node.id] || `# ${node.title}\n\n내용이 작성되지 않았습니다.`;
    const enc = await seal(key, JSON.stringify({ md }));
    await fs.writeFile(`${OUT}/n/${node.id}.enc`, enc);
  }

  const slimNodes = mockNodes.map(n => ({
    ...n,
    url: `https://notion.so/mock-${n.id}`,
    edited: new Date().toISOString()
  }));

  const searchIndex = mockNodes.map(n => ({
    id: n.id,
    title: n.title,
    tags: n.tags,
    folder: n.folder,
    summary: n.summary,
    text: `${n.title} ${n.tags.join(' ')} ${n.folder} ${n.summary} ${mockContents[n.id]}`
  }));

  await fs.writeFile(`${OUT}/graph.enc`, await seal(key, JSON.stringify({ nodes: slimNodes, edges: mockEdges })));
  await fs.writeFile(`${OUT}/search.enc`, await seal(key, JSON.stringify(searchIndex)));
  await fs.writeFile(`${OUT}/meta.json`, JSON.stringify({
    v: 1,
    salt: b64(salt),
    iter: ITER,
    builtAt: new Date().toISOString(),
    isMock: true
  }));

  console.log(`[완료] 모의 데이터 생성 성공! (패스프레이즈: "${PASSPHRASE}")`);
}

main().catch(console.error);
