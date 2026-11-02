// Notion API 최신 규격 대응 - 워크스페이스 진단 및 완전 탐색(DB + Page 트리) 동기화 스크립트
import { webcrypto as crypto } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';

const { NOTION_TOKEN, DATA_SOURCE_ID, DATA_PASSPHRASE } = process.env;

console.log('====================================================');
console.log('=== [1/4] GitHub Secrets 환경변수 확인 ===');
console.log(`• NOTION_TOKEN: ${NOTION_TOKEN ? '설정됨 (길이: ' + NOTION_TOKEN.length + '자)' : '❌ 누락됨!'}`);
console.log(`• DATA_SOURCE_ID: ${DATA_SOURCE_ID ? '설정됨' : '❌ 누락됨!'}`);
console.log(`• DATA_PASSPHRASE: ${DATA_PASSPHRASE ? '설정됨' : '❌ 누락됨!'}`);

if (!NOTION_TOKEN || !DATA_SOURCE_ID || !DATA_PASSPHRASE) {
  console.error('\n[치명적 오류] GitHub Secrets에 3가지 값이 모두 등록되어 있어야 합니다.');
  process.exit(1);
}

function extractNotionId(input) {
  if (!input) return '';
  const str = String(input).trim();
  const uuidMatch = str.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (uuidMatch) return uuidMatch[0].replace(/-/g, '').toLowerCase();

  const hex32Match = str.match(/[0-9a-fA-F]{32}/);
  if (hex32Match) return hex32Match[0].toLowerCase();

  const cleanUrl = str.split('?')[0].split('#')[0];
  const lastSegment = cleanUrl.split('/').filter(Boolean).pop() || '';
  const hexInLast = lastSegment.replace(/[^0-9a-fA-F]/g, '');
  if (hexInLast.length >= 32) return hexInLast.slice(-32).toLowerCase();

  return str.replace(/[^a-zA-Z0-9_-]/g, '');
}

const RAW_ID = extractNotionId(DATA_SOURCE_ID);
const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const OUT = 'dist/data';
const ITER = 600000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const te = new TextEncoder(), td = new TextDecoder();
const b64 = u8 => Buffer.from(u8).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const exists = p => fs.access(p).then(() => true, () => false);

/* ───── 텍스트 추출 헬퍼 (배열/객체/문자열 방어) ───── */
function getPlainText(field) {
  if (!field) return '';
  if (Array.isArray(field)) {
    return field.map(t => t?.plain_text || t?.text?.content || '').filter(Boolean).join('');
  }
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && field.plain_text) return String(field.plain_text);
  return '';
}

/* ───── Notion API 직접 호출 ───── */
async function notion(method, path, body) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(NOTION + path, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN.trim()}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (res.status === 429 || res.status === 529) {
      const retryAfter = Number(res.headers.get('retry-after') || 1);
      await sleep(Math.min(retryAfter, 30) * 1000 + i * 300);
      continue;
    }

    if (res.ok) return res.json();

    const errText = await res.text().catch(() => '');
    let errMsg = errText;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson.message || errText;
    } catch {}

    const err = new Error(`Notion API [${res.status}] ${method} ${path.split('?')[0]}: ${errMsg}`);
    err.status = res.status;
    err.details = errMsg;
    throw err;
  }
  throw new Error('Notion API 요청 실패 (최대 재시도 초과)');
}

/* ───── 노션 페이지 오브젝트 -> 그래프 노드 변환 (완전 방어) ───── */
function extractTitleFromProperties(P, iconEmoji = '') {
  let title = '';
  if (P && typeof P === 'object') {
    // 1. type === 'title' 속성 검색
    const titleKey = Object.keys(P).find(k => P[k]?.type === 'title');
    if (titleKey && P[titleKey]?.title) {
      title = getPlainText(P[titleKey].title);
    }
    // 2. 주요 속성명 안전 검색
    const candidates = ['이름', '제목', 'title', 'Name', '페이지'];
    for (const key of candidates) {
      if (!title && P[key]) {
        title = getPlainText(P[key].title) || getPlainText(P[key].rich_text);
      }
    }
    // 3. 아무것도 못 찾았을 경우 첫 번째 rich_text
    if (!title) {
      const richKey = Object.keys(P).find(k => P[k]?.type === 'rich_text');
      if (richKey && P[richKey]?.rich_text) {
        title = getPlainText(P[richKey].rich_text);
      }
    }
  }

  title = title.trim();
  if (iconEmoji) {
    title = `${iconEmoji} ${title}`.trim();
  }
  return title || '(제목 없음)';
}

function toNode(p, fallbackFolder = '기본') {
  const P = p.properties || {};
  const iconEmoji = p.icon?.emoji || '';
  const title = extractTitleFromProperties(P, iconEmoji);

  // 태그
  let tagsProp = P['태그']?.multi_select;
  if (!tagsProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'multi_select');
    if (key) tagsProp = P[key].multi_select;
  }
  const tags = Array.isArray(tagsProp) ? tagsProp.map(t => t?.name).filter(Boolean) : [];

  // 폴더
  let folderProp = P['폴더']?.select?.name;
  if (!folderProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'select');
    if (key) folderProp = P[key]?.select?.name;
  }
  const folder = folderProp || fallbackFolder || '기본';

  const summary = getPlainText(P['요약']?.rich_text);

  // 연결
  let linksProp = P['연결']?.relation;
  if (!linksProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'relation');
    if (key) linksProp = P[key].relation;
  }
  const links = Array.isArray(linksProp) ? linksProp.map(r => r?.id).filter(Boolean) : [];

  return {
    id: p.id,
    title,
    tags,
    folder,
    summary,
    links,
    url: p.url,
    edited: p.last_edited_time
  };
}

/* ───── Database ID -> Data Source ID 도출 ───── */
async function resolveDbToDataSource(dbId) {
  try {
    const cleanId = dbId.replace(/-/g, '');
    const dbObj = await notion('GET', `/databases/${cleanId}`);
    if (Array.isArray(dbObj.data_sources) && dbObj.data_sources.length > 0) {
      return dbObj.data_sources[0].id.replace(/-/g, '');
    }
    return cleanId;
  } catch {
    return dbId.replace(/-/g, '');
  }
}

/* ───── 데이터 소스 쿼리 (Table 형태 데이터베이스) ───── */
async function queryDataSource(dsId) {
  const nodes = [];
  let cursor = null;
  const cleanId = dsId.replace(/-/g, '');
  do {
    const r = await notion('POST', `/data_sources/${cleanId}/query`, {
      page_size: 100,
      ...(cursor && { start_cursor: cursor })
    });
    for (const p of r.results || []) {
      nodes.push(toNode(p));
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return nodes;
}

/* ───── 노션 페이지 하위 트리 재귀 탐색 (child_page + child_database) ───── */
async function collectPageTree(rootPageId, visitedIds = new Set(), depth = 0, parentTitle = '기본') {
  const nodes = [];
  const cleanId = rootPageId.replace(/-/g, '');
  if (visitedIds.has(cleanId) || depth > 8) return nodes;
  visitedIds.add(cleanId);

  // 1. 현재 페이지 메타데이터 조회
  try {
    const currentPageObj = await notion('GET', `/pages/${cleanId}`);
    const currentNode = toNode(currentPageObj, parentTitle);
    nodes.push(currentNode);
    console.log(`  ${'  '.repeat(depth)}📄 [페이지] "${currentNode.title}" (ID: ${cleanId})`);
    parentTitle = currentNode.title;
  } catch (err) {
    console.log(`  ${'  '.repeat(depth)}⚠️ 페이지 조회 실패 (${cleanId}): ${err.message}`);
  }

  // 2. 현재 페이지의 자식 블록들 조회
  let cursor = null;
  do {
    let blocksRes;
    try {
      blocksRes = await notion('GET', `/blocks/${cleanId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    } catch (err) {
      break;
    }

    for (const b of blocksRes.results || []) {
      // (A) 하위 자식 페이지(child_page) 재귀 수집
      if (b.type === 'child_page') {
        const subNodes = await collectPageTree(b.id, visitedIds, depth + 1, parentTitle);
        nodes.push(...subNodes);
      }
      // (B) 하위 자식 데이터베이스(child_database) 행 수집
      else if (b.type === 'child_database') {
        const dbTitle = b.child_database?.title || '데이터베이스';
        console.log(`  ${'  '.repeat(depth + 1)}📊 [자식 DB] "${dbTitle}" (ID: ${b.id})`);
        try {
          const dsId = await resolveDbToDataSource(b.id);
          const dbNodes = await queryDataSource(dsId);
          console.log(`  ${'  '.repeat(depth + 1)}  -> DB 내부 ${dbNodes.length}개 노트 수집 완료`);
          for (const dn of dbNodes) {
            const cleanDnId = dn.id.replace(/-/g, '');
            if (!visitedIds.has(cleanDnId)) {
              visitedIds.add(cleanDnId);
              dn.folder = dbTitle;
              nodes.push(dn);
            }
          }
        } catch (dbErr) {
          console.log(`  ${'  '.repeat(depth + 1)}  ⚠️ DB 행 수집 실패: ${dbErr.message}`);
        }
      }
    }
    cursor = blocksRes.has_more ? blocksRes.next_cursor : null;
  } while (cursor);

  return nodes;
}

/* ───── 봇에게 공유된 최상위 항목 가벼운 탐색 (최대 100건) ───── */
async function getTopAccessibleItems() {
  const items = [];
  try {
    const res = await notion('POST', '/search', { page_size: 50 });
    items.push(...(res.results || []));
  } catch {}

  const uniqueItems = [];
  const seen = new Set();
  for (const it of items) {
    const clean = it.id.replace(/-/g, '');
    if (!seen.has(clean)) {
      seen.add(clean);
      uniqueItems.push(it);
    }
  }
  return uniqueItems;
}

/* ───── 스마트 통합 수집 엔진 ───── */
async function collectAllNotionNotes() {
  console.log('\n=== [2/4] Notion 통합 봇 및 워크스페이스 진단 ===');

  let botInfo;
  try {
    botInfo = await notion('GET', '/users/me');
    const wsName = botInfo.bot?.owner?.workspace_name || botInfo.bot?.workspace_name || '(확인불가)';
    console.log(`• 통합 봇 인증 성공!`);
    console.log(`  - 봇 이름: "${botInfo.name}"`);
    console.log(`  - 소속 워크스페이스: "${wsName}"`);
  } catch (err) {
    console.error(`❌ 토큰 인증 실패: ${err.message}`);
    throw err;
  }

  const allNodesMap = new Map();
  const visitedIds = new Set();

  // (1) [최우선] 사용자가 지정한 DATA_SOURCE_ID(RAW_ID)가 있는 경우
  if (RAW_ID) {
    console.log(`\n• [타겟 분석] 사용자 지정 ID (${RAW_ID}) 탐색 중...`);

    // A. Page인지 확인 -> Page 및 하위 자식 문서 트리 재귀 수집!
    try {
      const pageTest = await notion('GET', `/pages/${RAW_ID}`);
      if (pageTest && pageTest.object === 'page') {
        const pageTitle = extractTitleFromProperties(pageTest.properties, pageTest.icon?.emoji);
        console.log(`🎉 [확인 성공] 입력된 ID는 노션 [Page] "${pageTitle}" 입니다!`);
        console.log(`• 하위 자식 문서 트리를 재귀적으로 수집합니다...`);
        const treeNodes = await collectPageTree(RAW_ID, visitedIds, 0, pageTitle);
        for (const n of treeNodes) allNodesMap.set(n.id, n);
        console.log(`✓ 트리 수집 완료: 총 ${treeNodes.length}개 노트 수집됨!`);
      }
    } catch (e1) {
      console.log(`  (Page 직접 조회 실패: ${e1.details || e1.message})`);
    }

    // B. Database인지 확인 -> Data Source 도출 후 행(rows) 수집!
    if (allNodesMap.size === 0) {
      try {
        const dbTest = await notion('GET', `/databases/${RAW_ID}`);
        if (dbTest && dbTest.object === 'database') {
          const dbTitle = (dbTest.title || []).map(t => t.plain_text).join('') || '데이터베이스';
          console.log(`🎉 [확인 성공] 입력된 ID는 노션 [Database] "${dbTitle}" 입니다!`);
          const dsId = await resolveDbToDataSource(RAW_ID);
          const dbNodes = await queryDataSource(dsId);
          for (const n of dbNodes) allNodesMap.set(n.id, n);
          console.log(`✓ DB 수집 완료: 총 ${dbNodes.length}개 노트 수집됨!`);
        }
      } catch (e2) {
        console.log(`  (Database 직접 조회 실패: ${e2.details || e2.message})`);
      }
    }

    // C. Data Source 직접 쿼리
    if (allNodesMap.size === 0) {
      try {
        const dsNodes = await queryDataSource(RAW_ID);
        if (dsNodes.length > 0) {
          console.log(`🎉 [확인 성공] 입력된 ID는 유효한 [Data Source] 입니다! (총 ${dsNodes.length}개 노트 수집)`);
          for (const n of dsNodes) allNodesMap.set(n.id, n);
        }
      } catch (e3) {
        console.log(`  (Data Source 직접 쿼리 실패: ${e3.details || e3.message})`);
      }
    }
  }

  // (2) 만약 아직 노드가 0개이거나, 봇에게 공유된 다른 최상위 페이지들이 있다면 가볍게 보강
  if (allNodesMap.size === 0) {
    console.log(`\n• [공유 항목 탐색] 봇에게 연결된 다른 페이지들을 탐색합니다...`);
    const accessibleItems = await getTopAccessibleItems();
    console.log(`• 발견된 항목: ${accessibleItems.length}개`);

    for (const item of accessibleItems) {
      const cleanId = item.id.replace(/-/g, '');
      if (visitedIds.has(cleanId)) continue;

      if (item.object === 'page') {
        const pTitle = extractTitleFromProperties(item.properties, item.icon?.emoji);
        console.log(`• 공유 페이지 [${pTitle}] (ID: ${cleanId}) 트리 수집 시작...`);
        const subTree = await collectPageTree(cleanId, visitedIds, 0, pTitle);
        for (const n of subTree) allNodesMap.set(n.id, n);
        if (allNodesMap.size >= 100) break; // 과도한 수집 방지
      } else if (item.object === 'data_source' || item.object === 'database') {
        try {
          const dsId = item.object === 'database' ? await resolveDbToDataSource(cleanId) : cleanId;
          const rows = await queryDataSource(dsId);
          if (rows.length > 0) {
            console.log(`• 공유 DB/데이터소스 [${cleanId}]에서 ${rows.length}개 노트 수집 완료`);
            for (const n of rows) allNodesMap.set(n.id, n);
            break;
          }
        } catch {}
      }
    }
  }

  const finalNodes = Array.from(allNodesMap.values());
  if (finalNodes.length === 0) {
    const ws = botInfo.bot?.owner?.workspace_name || '(소속 워크스페이스)';
    throw new Error(
      `통합 봇 "${botInfo.name}" 에게서 노션 노트를 수집하지 못했습니다.\n\n` +
      `[확인 사항]:\n` +
      `1. 노션 워크스페이스: [${ws}]\n` +
      `2. 대상 페이지 우측 상단 [···] -> [연결]에 "${botInfo.name}" 봇이 추가되었는지 확인하세요.`
    );
  }

  return finalNodes;
}

/* ───── 암호화 유틸 ───── */
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

async function open(key, buf) {
  const iv = buf.subarray(0, 12);
  const ct = buf.subarray(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return td.decode(gunzipSync(new Uint8Array(decrypted)));
}

/* ───── 본문 기반 연결선(Edges) 및 위키링크 자동 생성 ───── */
function buildContentBasedEdges(nodes, contentsMap) {
  const ids = new Set(nodes.map(n => n.id));
  const seen = new Set();
  const edges = [];

  function addEdge(a, b, reason = 'relation') {
    if (!a || !b || a === b) return;
    if (!ids.has(a) || !ids.has(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push([a, b]);
    }
  }

  // 1. 노션 공식 Relation 속성
  for (const n of nodes) {
    for (const targetId of n.links || []) {
      addEdge(n.id, targetId, 'relation');
    }
  }

  // 2. 본문 내용 기반 링크 (위키링크 [[제목]], 멘션, 제목 단어 매칭)
  const titleToNode = new Map();
  for (const n of nodes) {
    const cleanTitle = (n.title || '').replace(/^[\p{Emoji}\s]+/u, '').trim().toLowerCase();
    if (cleanTitle && cleanTitle.length >= 2 && cleanTitle !== '(제목 없음)') {
      titleToNode.set(cleanTitle, n.id);
    }
  }

  for (const n of nodes) {
    const md = (contentsMap.get(n.id) || '').toLowerCase();
    if (!md) continue;

    // 위키링크 [[노트제목]]
    const wikiMatches = md.matchAll(/\[\[(.*?)\]\]/g);
    for (const match of wikiMatches) {
      const targetTitle = match[1].trim().toLowerCase();
      const targetId = titleToNode.get(targetTitle);
      if (targetId) addEdge(n.id, targetId, 'wikilink');
    }

    // 다른 노트 제목이 본문에 언급된 경우 (3자 이상 우선 매칭)
    for (const [title, targetId] of titleToNode.entries()) {
      if (targetId === n.id) continue;
      if (title.length >= 3 && md.includes(title)) {
        addEdge(n.id, targetId, 'mention');
      }
    }

    // 노션 고유 ID가 본문 링크에 포함된 경우
    for (const other of nodes) {
      if (other.id === n.id) continue;
      const cleanOtherId = other.id.replace(/-/g, '').toLowerCase();
      if (md.includes(cleanOtherId)) {
        addEdge(n.id, other.id, 'link');
      }
    }
  }

  // 3. 공통 폴더/태그 기반 연결 보강 (옵시디언 성운 형성)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      // 동일 태그 공유
      if (a.tags && b.tags && a.tags.length > 0 && b.tags.length > 0) {
        const commonTags = a.tags.filter(t => b.tags.includes(t));
        if (commonTags.length >= 1) {
          addEdge(a.id, b.id, 'tag');
        }
      }
      // 동일 상위 폴더인 경우 부드러운 연결
      if (a.folder && b.folder && a.folder !== '기본' && a.folder === b.folder && edges.length < nodes.length * 2) {
        addEdge(a.id, b.id, 'folder');
      }
    }
  }

  return edges;
}

/* ───── 본문 마크다운 파싱 ───── */
async function fetchPageMarkdown(pageId) {
  try {
    const res = await notion('GET', `/pages/${pageId}/markdown`);
    if (res && typeof res.markdown === 'string') return res.markdown;
  } catch {}

  try {
    const blocksRes = await notion('GET', `/blocks/${pageId}/children?page_size=100`);
    const lines = [];
    for (const b of blocksRes.results || []) {
      const type = b.type;
      const rich = b[type]?.rich_text;
      const text = getPlainText(rich);
      if (type.startsWith('heading_1')) lines.push(`# ${text}`);
      else if (type.startsWith('heading_2')) lines.push(`## ${text}`);
      else if (type.startsWith('heading_3')) lines.push(`### ${text}`);
      else if (type === 'bulleted_list_item') lines.push(`- ${text}`);
      else if (type === 'numbered_list_item') lines.push(`1. ${text}`);
      else if (type === 'to_do') lines.push(`- [${b.to_do?.checked ? 'x' : ' '}] ${text}`);
      else if (type === 'code') lines.push(`\`\`\`\n${text}\n\`\`\``);
      else if (type === 'quote') lines.push(`> ${text}`);
      else if (type === 'child_page') lines.push(`📄 [[${b.child_page?.title || '하위 페이지'}]]`);
      else if (text) lines.push(text);
    }
    return lines.join('\n\n') || '(내용 없음)';
  } catch {
    return '(본문을 불러올 수 없습니다.)';
  }
}

/* ───── 메인 실행 ───── */
async function main() {
  await fs.mkdir(`${OUT}/n`, { recursive: true });

  const nodes = await collectAllNotionNotes();
  console.log(`\n• 노션 최종 수집 결과: 총 ${nodes.length}개 노트 확보 완료!`);

  console.log(`\n=== [3/4] 암호화 키 도출 및 캐시 검사 ===`);
  const prevMeta = await fs.readFile(`${OUT}/meta.json`, 'utf8').then(JSON.parse, () => null);
  const salt = prevMeta?.salt ? unb64(prevMeta.salt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(DATA_PASSPHRASE, salt);

  let prev = new Map();
  try {
    const prevBuf = await fs.readFile(`${OUT}/graph.enc`);
    const prevGraph = JSON.parse(await open(key, prevBuf));
    prev = new Map((prevGraph.nodes || []).map(n => [n.id, n.edited]));
    console.log(`• 이전 캐시 복호화 성공: ${prev.size}개 노트 캐시됨`);
  } catch {
    console.log(`• 신규 빌드 (전체 동기화 시작)`);
  }

  console.log(`\n=== [4/4] 노트 본문 수집 및 검색 색인 생성 ===`);
  let fetched = 0;
  for (const n of nodes) {
    const f = `${OUT}/n/${n.id}.enc`;
    if (prev.get(n.id) === n.edited && (await exists(f))) continue;

    const md = await fetchPageMarkdown(n.id);
    await fs.writeFile(f, await seal(key, JSON.stringify({ md })));
    fetched++;
    await sleep(340);
  }

  const liveIds = new Set(nodes.map(n => `${n.id}.enc`));
  const existingFiles = await fs.readdir(`${OUT}/n`);
  for (const f of existingFiles) {
    if (!liveIds.has(f)) await fs.unlink(`${OUT}/n/${f}`);
  }

  const searchIndex = [];
  const contentsMap = new Map();

  for (const n of nodes) {
    let fullMd = '';
    try {
      const { md } = JSON.parse(await open(key, await fs.readFile(`${OUT}/n/${n.id}.enc`)));
      fullMd = md || '';
    } catch {}

    contentsMap.set(n.id, fullMd);
    const body = fullMd.replace(/[#>*_`\[\]()!|-]+/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);

    searchIndex.push({
      id: n.id,
      title: n.title,
      tags: n.tags,
      folder: n.folder,
      summary: n.summary,
      text: [n.title, n.tags.join(' '), n.folder, n.summary, body].join(' ')
    });
  }

  // 본문 및 관계망 기반 엣지 계산
  const edges = buildContentBasedEdges(nodes, contentsMap);
  console.log(`• 내용 및 관계망 기반 연결선(Edges): 총 ${edges.length}개 생성됨`);

  const slimNodes = nodes.map(({ links, summary, ...rest }) => rest);
  await fs.writeFile(`${OUT}/graph.enc`, await seal(key, JSON.stringify({ nodes: slimNodes, edges })));
  await fs.writeFile(`${OUT}/search.enc`, await seal(key, JSON.stringify(searchIndex)));
  await fs.writeFile(`${OUT}/meta.json`, JSON.stringify({
    v: 1,
    salt: b64(salt),
    iter: ITER,
    builtAt: new Date().toISOString()
  }));

  console.log(`\n🎉 [동기화 성공] 노션 노트 ${nodes.length}개 수집 및 AES-256-GCM 암호화 완료! (갱신 본문: ${fetched}개)`);
}

main().catch(err => {
  console.error(`\n❌ [동기화 실패]: ${err.message}`);
  process.exit(1);
});
