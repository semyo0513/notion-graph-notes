// Notion API 최신 규격 대응 - 워크스페이스 진단 및 완벽 탐색 동기화 스크립트
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

/* ───── 데이터 소스 쿼리 테스트 (정상 여부 및 행 개수 체크) ───── */
async function testDataSource(dsId) {
  if (!dsId) return { ok: false, count: 0 };
  const cleanId = dsId.replace(/-/g, '');
  try {
    const res = await notion('POST', `/data_sources/${cleanId}/query`, { page_size: 5 });
    const count = Array.isArray(res.results) ? res.results.length : 0;
    return { ok: true, count, hasMore: Boolean(res.has_more) };
  } catch (err) {
    return { ok: false, count: 0, error: err.details || err.message };
  }
}

/* ───── Database ID -> Data Source ID 해석 ───── */
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

/* ───── Page ID 내 하위 자식 DB 탐색 ───── */
async function findChildDatabaseInPage(pageId) {
  try {
    const cleanId = pageId.replace(/-/g, '');
    const blocks = await notion('GET', `/blocks/${cleanId}/children?page_size=50`);
    for (const b of blocks.results || []) {
      if (b.type === 'child_database') {
        const childId = b.id.replace(/-/g, '');
        console.log(`  ✓ 페이지 내 자식 데이터베이스 발견: [${b.child_database?.title || '제목 없음'}] (ID: ${childId})`);
        return await resolveDbToDataSource(childId);
      }
    }
  } catch {}
  return null;
}

/* ───── 스마트 탐색: 사용자 입력 ID 최우선 매칭 및 자가 복구 ───── */
async function resolveDataSourceId() {
  console.log('\n=== [2/4] Notion 통합 봇 및 워크스페이스 진단 ===');

  // 1. 봇 및 소유자 워크스페이스 확인
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

  // 2. 통합 봇에게 공유된 노션 항목 검색
  let accessibleItems = [];
  try {
    const searchRes = await notion('POST', '/search', {});
    accessibleItems = searchRes.results || [];
  } catch (err) {
    console.log(`  (기본 /search 실패, in_trash: false 재시도: ${err.message})`);
    try {
      const searchRes2 = await notion('POST', '/search', { in_trash: false });
      accessibleItems = searchRes2.results || [];
    } catch {}
  }

  console.log(`\n• 현재 봇 "${botInfo.name}" 에게 연결된 노션 항목: 총 ${accessibleItems.length}개 발견`);
  for (const item of accessibleItems) {
    const objType = item.object;
    let title = '(제목 없음)';
    if (item.title && Array.isArray(item.title)) {
      title = item.title.map(t => t.plain_text).join('');
    } else if (item.properties?.['이름']?.title) {
      title = item.properties['이름'].title.map(t => t.plain_text).join('');
    } else if (item.properties) {
      const titlePropKey = Object.keys(item.properties).find(k => item.properties[k]?.type === 'title');
      if (titlePropKey) {
        title = (item.properties[titlePropKey].title || []).map(t => t.plain_text).join('');
      }
    }
    const cleanId = item.id.replace(/-/g, '');
    console.log(`  - [${objType}] "${title}" (ID: ${cleanId})`);
  }

  // 3. [최우선] 사용자가 DATA_SOURCE_ID를 명시한 경우: 해당 ID를 철저히 검증 및 도출
  if (RAW_ID) {
    console.log(`\n• [1순위 검증] 사용자가 입력한 DATA_SOURCE_ID(${RAW_ID}) 분석 중...`);

    // (A) 입력된 ID가 곧바로 data_source ID인지 테스트
    const directDsTest = await testDataSource(RAW_ID);
    if (directDsTest.ok) {
      console.log(`🎉 [매칭 성공] 입력된 ID는 유효한 Data Source ID입니다! (발견된 샘플 노트: ${directDsTest.count}개)`);
      return RAW_ID;
    }

    // (B) 입력된 ID가 database ID인지 확인 -> data_sources 추출
    try {
      const dbObj = await notion('GET', `/databases/${RAW_ID}`);
      const title = (dbObj.title || []).map(t => t.plain_text).join('') || '이름 없음';
      console.log(`✓ 입력된 ID로 Database 컨테이너 조회 성공: "${title}"`);
      if (Array.isArray(dbObj.data_sources) && dbObj.data_sources.length > 0) {
        const derivedDsId = dbObj.data_sources[0].id.replace(/-/g, '');
        console.log(`🎉 [매칭 성공] Database 컨테이너 내의 Data Source ID(${derivedDsId})를 획득했습니다!`);
        return derivedDsId;
      }
      return RAW_ID;
    } catch (eDb) {
      console.log(`  - Database 직접 조회 불가: ${eDb.details || eDb.message}`);
    }

    // (C) 입력된 ID가 page ID인지 확인 -> 하위 child_database 탐색
    try {
      const pageObj = await notion('GET', `/pages/${RAW_ID}`);
      console.log(`✓ 입력된 ID는 Page입니다. 페이지 내부 데이터베이스를 탐색합니다...`);
      const childDs = await findChildDatabaseInPage(RAW_ID);
      if (childDs) {
        console.log(`🎉 [매칭 성공] Page 내부 자식 데이터베이스 Data Source ID(${childDs}) 도출 완료!`);
        return childDs;
      }
    } catch (ePg) {
      console.log(`  - Page 직접 조회 불가: ${ePg.details || ePg.message}`);
    }

    // (D) accessibleItems 목록에서 RAW_ID와 매칭되는 항목 확인
    const matchedItem = accessibleItems.find(i => i.id.replace(/-/g, '').toLowerCase() === RAW_ID.toLowerCase());
    if (matchedItem) {
      console.log(`✓ 봇 검색 결과에서 입력 ID와 일치하는 [${matchedItem.object}] 발견!`);
      if (matchedItem.object === 'data_source') return matchedItem.id.replace(/-/g, '');
      if (matchedItem.object === 'database') return await resolveDbToDataSource(matchedItem.id);
      if (matchedItem.object === 'page') {
        const childDs = await findChildDatabaseInPage(matchedItem.id);
        if (childDs) return childDs;
      }
    }

    // [중요] 사용자가 DATA_SOURCE_ID를 명시했으나 해당 ID가 유효하지 않은 경우:
    // 엉뚱한 다른 DB(예: 기분/트래커 DB 등)를 멋대로 자동 선택하여 덮어쓰지 않도록 차단합니다!
    const availableList = accessibleItems
      .map(i => {
        let t = '(제목 없음)';
        if (i.title && Array.isArray(i.title)) t = i.title.map(x => x.plain_text).join('');
        else if (i.properties?.['이름']?.title) t = i.properties['이름'].title.map(x => x.plain_text).join('');
        return `   • [${i.object}] "${t}" (ID: ${i.id.replace(/-/g, '')})`;
      })
      .join('\n');

    throw new Error(
      `입력하신 DATA_SOURCE_ID (${RAW_ID})에 해당하는 노션 데이터베이스를 찾을 수 없습니다.\n\n` +
      `[현재 통합 봇 "${botInfo.name}" 에게 연결된 항목 목록]:\n` +
      (availableList || '   (연결된 항목이 전혀 없습니다)') + '\n\n' +
      `[해결 방법]:\n` +
      `1. 연동하고자 하는 '진짜 노션 데이터베이스' 페이지를 노션 웹/앱에서 엽니다.\n` +
      `2. 페이지 우측 상단 [···] -> 맨 아래 [연결(Connections)] -> [${botInfo.name}] 봇을 반드시 추가해 주세요!\n` +
      `3. 데이터베이스 제목 우측 [···] -> [데이터 소스 관리] -> [데이터 소스 ID 복사]하여 GitHub Secrets의 DATA_SOURCE_ID에 입력하세요.`
    );
  }

  // 4. [2순위 자동 탐색 Fallback] 사용자가 ID를 전혀 입력하지 않은 경우에만 자동 매칭 진행
  console.log(`\n• [2순위 자동 탐색] DATA_SOURCE_ID가 비어 있어 워크스페이스 내 최적의 데이터 소스 후보를 탐색합니다...`);

  // 가능한 모든 Data Source 후보 수집
  const candidates = [];

  for (const item of accessibleItems) {
    const cleanId = item.id.replace(/-/g, '');
    let title = item.title?.map?.(t => t.plain_text).join('') || item.object;

    if (item.object === 'data_source') {
      candidates.push({ id: cleanId, title, source: 'data_source' });
    } else if (item.object === 'database') {
      const dsId = await resolveDbToDataSource(cleanId);
      candidates.push({ id: dsId, title, source: 'database' });
    } else if (item.object === 'page') {
      const childDs = await findChildDatabaseInPage(cleanId);
      if (childDs) {
        candidates.push({ id: childDs, title: `(Page ${cleanId} 하위 DB)`, source: 'child_database' });
      }
    }
  }

  // 중복 ID 제거
  const uniqueCandidates = [];
  const seenIds = new Set();
  for (const c of candidates) {
    if (!seenIds.has(c.id)) {
      seenIds.add(c.id);
      uniqueCandidates.push(c);
    }
  }

  console.log(`• 발견된 데이터 소스 후보군: ${uniqueCandidates.length}개`);

  // 각 후보의 실제 노트(row) 개수 검사하여 데이터가 있는 소스를 최우선 선택
  let bestCandidate = null;
  for (const c of uniqueCandidates) {
    const test = await testDataSource(c.id);
    console.log(`  - 후보 [${c.source}] "${c.title}" (ID: ${c.id}) -> 유효: ${test.ok}, 샘플 노트: ${test.count}개`);
    if (test.ok && test.count > 0) {
      bestCandidate = c.id;
      console.log(`🎉 [자동 매칭 성공] 노트가 존재하는 데이터 소스(${c.id})를 최우선 선택합니다!`);
      return bestCandidate;
    }
  }

  if (uniqueCandidates.length > 0) {
    const fallbackId = uniqueCandidates[0].id;
    console.log(`⚠️ 노트가 있는 데이터 소스를 찾지 못하여 첫 번째 후보(${fallbackId})를 선택합니다.`);
    return fallbackId;
  }

  // 5. 아무것도 발견되지 않은 경우
  const ws = botInfo.bot?.owner?.workspace_name || '(소속 워크스페이스)';
  throw new Error(
    `통합 봇 "${botInfo.name}" 에게 공유된 유효한 데이터베이스 또는 데이터 소스를 찾을 수 없습니다.\n\n` +
    `[점검 사항]\n` +
    `1. 현재 토큰의 소속 워크스페이스: [${ws}]\n` +
    `2. 노션 웹 화면에서 대상 데이터베이스 우측 상단 [···] -> [연결(Connections)]에 "${botInfo.name}" 봇이 추가되어 있는지 확인하세요.\n` +
    `3. 데이터베이스 제목 우측 [···] -> [데이터 소스 관리] -> [데이터 소스 ID 복사]를 눌러 GitHub Secret에 DATA_SOURCE_ID를 업데이트해 주세요.`
  );
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

/* ───── 전체 노션 페이지 쿼리 ───── */
async function queryAll(targetId) {
  const nodes = [];
  let cursor = null;
  let activeId = targetId.replace(/-/g, '');

  // 1차로 /data_sources/:id/query 테스트, 실패 시 DB에서 data_source ID 재추출
  try {
    await notion('POST', `/data_sources/${activeId}/query`, { page_size: 1 });
  } catch (err) {
    console.log(`• data_sources/${activeId}/query 호출 실패 (${err.details || err.message}). Database 컨테이너 조회로 data_sources 재탐색...`);
    const resolved = await resolveDbToDataSource(activeId);
    if (resolved && resolved !== activeId) {
      console.log(`  -> 추출된 Data Source ID(${resolved})로 전환합니다.`);
      activeId = resolved;
    }
  }

  const endpoint = `/data_sources/${activeId}/query`;
  console.log(`• 쿼리 대상 엔드포인트: POST ${endpoint}`);

  do {
    const r = await notion('POST', endpoint, {
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

function toNode(p) {
  const P = p.properties || {};

  let titleProp = P['이름']?.title;
  if (!titleProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'title');
    if (key) titleProp = P[key].title;
  }
  const title = (titleProp || []).map(t => t.plain_text).join('') || '(제목 없음)';

  let tagsProp = P['태그']?.multi_select;
  if (!tagsProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'multi_select');
    if (key) tagsProp = P[key].multi_select;
  }
  const tags = (tagsProp || []).map(t => t.name);

  let folderProp = P['폴더']?.select?.name;
  if (!folderProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'select');
    if (key) folderProp = P[key]?.select?.name;
  }
  const folder = folderProp || '기본';

  const summary = ((P['요약']?.rich_text) || []).map(t => t.plain_text).join('');

  let linksProp = P['연결']?.relation;
  if (!linksProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'relation');
    if (key) linksProp = P[key].relation;
  }
  const links = (linksProp || []).map(r => r.id);

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
    const cleanTitle = (n.title || '').trim().toLowerCase();
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

  // 3. 연결선이 적은 경우 공통 태그/폴더 기반 연결 보강 (지식 그물망 형성)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      // 동일 태그 1개 이상 공유 시 연결
      if (a.tags && b.tags && a.tags.length > 0 && b.tags.length > 0) {
        const commonTags = a.tags.filter(t => b.tags.includes(t));
        if (commonTags.length >= 1) {
          addEdge(a.id, b.id, 'tag');
        }
      }
      // 또는 같은 폴더(기본 제외)인 경우 연결선 보강
      if (a.folder && b.folder && a.folder !== '기본' && a.folder === b.folder && edges.length < nodes.length * 1.5) {
        addEdge(a.id, b.id, 'folder');
      }
    }
  }

  return edges;
}

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
      const text = (rich || []).map(t => t.plain_text).join('');
      if (type.startsWith('heading_1')) lines.push(`# ${text}`);
      else if (type.startsWith('heading_2')) lines.push(`## ${text}`);
      else if (type.startsWith('heading_3')) lines.push(`### ${text}`);
      else if (type === 'bulleted_list_item') lines.push(`- ${text}`);
      else if (type === 'numbered_list_item') lines.push(`1. ${text}`);
      else if (type === 'to_do') lines.push(`- [${b.to_do?.checked ? 'x' : ' '}] ${text}`);
      else if (type === 'code') lines.push(`\`\`\`\n${text}\n\`\`\``);
      else if (type === 'quote') lines.push(`> ${text}`);
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

  const targetId = await resolveDataSourceId();

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

  console.log(`\n=== [4/4] 노션 노트 및 본문 수집 시작 ===`);
  let nodes = await queryAll(targetId);
  console.log(`• 쿼리 결과: ${nodes.length}개 노트 수집됨 (타겟 ID: ${targetId})`);

  // [0건 방어 안전장치]: 만약 0개가 반환되었는데 이전 캐시가 있다면 이전 데이터 유실 방지
  if (nodes.length === 0 && prev.size > 0) {
    console.warn(`\n⚠️ [주의]: 노션에서 0개의 노트가 반환되었습니다!`);
    console.warn(`• 데이터 유실 방지를 위해 이전 캐시(${prev.size}개 노트)를 보존하고 빌드를 유지합니다.`);
    console.warn(`• 노션 데이터베이스에 실제 페이지가 있는지, 혹은 통합 봇 권한을 확인해 주세요.`);
  }

  let fetched = 0;
  for (const n of nodes) {
    const f = `${OUT}/n/${n.id}.enc`;
    if (prev.get(n.id) === n.edited && (await exists(f))) continue;

    const md = await fetchPageMarkdown(n.id);
    await fs.writeFile(f, await seal(key, JSON.stringify({ md })));
    fetched++;
    await sleep(340);
  }

  if (nodes.length > 0) {
    const liveIds = new Set(nodes.map(n => `${n.id}.enc`));
    const existingFiles = await fs.readdir(`${OUT}/n`);
    for (const f of existingFiles) {
      if (!liveIds.has(f)) await fs.unlink(`${OUT}/n/${f}`);
    }
  }

  // 본문 텍스트 수집 및 검색 색인 생성
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

  // 내용 기반 연결선(Edges) 계산
  const edges = buildContentBasedEdges(nodes, contentsMap);
  console.log(`• 내용 및 관계망 기반 연결선(Edges): 총 ${edges.length}개 생성됨`);

  const slimNodes = nodes.map(({ links, summary, ...rest }) => rest);

  // nodes가 0개인데 이전 캐시가 있다면 이전 암호화 파일들을 덮어쓰지 않음
  if (nodes.length > 0 || prev.size === 0) {
    await fs.writeFile(`${OUT}/graph.enc`, await seal(key, JSON.stringify({ nodes: slimNodes, edges })));
    await fs.writeFile(`${OUT}/search.enc`, await seal(key, JSON.stringify(searchIndex)));
    await fs.writeFile(`${OUT}/meta.json`, JSON.stringify({
      v: 1,
      salt: b64(salt),
      iter: ITER,
      builtAt: new Date().toISOString()
    }));
  }

  console.log(`\n🎉 [동기화 성공] 노션 노트 ${nodes.length}개 수집 및 AES-256-GCM 암호화 완료! (갱신 본문: ${fetched}개)`);
}

main().catch(err => {
  console.error(`\n❌ [동기화 실패]: ${err.message}`);
  process.exit(1);
});
