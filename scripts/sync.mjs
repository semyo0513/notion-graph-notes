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

/* ───── 스마트 자동 탐색: 워크스페이스 검증 및 DB 자동 매칭 ───── */
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

  // 2. 통합 봇에게 공유된 모든 노션 항목 전체 검색 (바디 {} 로 100% 호환)
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

  console.log(`\n• 현재 봇 "${botInfo.name}" 에게 연결된 노션 페이지/DB: 총 ${accessibleItems.length}개 발견`);
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

  // 3. 만약 공유된 항목 중 data_source가 있으면 최우선 연결
  const dsItem = accessibleItems.find(i => i.object === 'data_source');
  if (dsItem) {
    const dsId = dsItem.id.replace(/-/g, '');
    console.log(`\n🎉 [자동 매칭 성공] 발견된 Data Source ID(${dsId})로 자동 연결합니다!`);
    return dsId;
  }

  // 4. database 항목이 있으면 연결
  const dbItem = accessibleItems.find(i => i.object === 'database');
  if (dbItem) {
    console.log(`\n🎉 [자동 매칭 성공] 발견된 Database(ID: ${dbItem.id})로 자동 연결합니다!`);
    return await resolveDbToDataSource(dbItem.id);
  }

  // 5. 사용자가 입력한 RAW_ID 직접 조회 시도 (GET /databases, GET /pages)
  if (RAW_ID) {
    console.log(`\n• 입력된 ID(${RAW_ID}) 직접 조회 시도 중...`);
    try {
      const dbObj = await notion('GET', `/databases/${RAW_ID}`);
      console.log(`✓ 입력된 ID로 Database 직접 조회 성공! (${dbObj.title?.map(t => t.plain_text).join('')})`);
      return await resolveDbToDataSource(RAW_ID);
    } catch (e1) {
      console.log(`  - databases/${RAW_ID} 조회 실패: ${e1.details || e1.message}`);
    }

    try {
      const pageObj = await notion('GET', `/pages/${RAW_ID}`);
      console.log(`✓ 입력된 ID는 페이지입니다. 페이지 내부 데이터베이스를 탐색합니다...`);
      const childDs = await findChildDatabaseInPage(RAW_ID);
      if (childDs) return childDs;
    } catch (e2) {
      console.log(`  - pages/${RAW_ID} 조회 실패: ${e2.details || e2.message}`);
    }
  }

  // 6. 페이지 항목들이 있다면 페이지 내부 탐색
  const pageItems = accessibleItems.filter(i => i.object === 'page');
  for (const page of pageItems) {
    const childDs = await findChildDatabaseInPage(page.id);
    if (childDs) {
      console.log(`\n🎉 [자동 매칭 성공] 페이지 [${page.id}] 내부의 데이터베이스로 자동 연결합니다!`);
      return childDs;
    }
  }

  // 7. 여기까지 왔는데 아무것도 없다면 -> 안내 메시지 출력
  const ws = botInfo.bot?.owner?.workspace_name || '(소속 워크스페이스)';
  throw new Error(
    `통합 봇 "${botInfo.name}" 에게 공유된 데이터베이스가 0개입니다.\n\n` +
    `[가장 중요한 점검 사항]\n` +
    `현재 토큰은 [${ws}] 워크스페이스에 연결되어 있습니다.\n` +
    `노션 화면 좌측 상단에서 현재 열려 있는 워크스페이스 이름이 [${ws}] 가 맞는지 꼭 확인하세요!\n` +
    `(노션 계정에 여러 워크스페이스가 있는 경우, 다른 워크스페이스의 데이터베이스에 추가하면 API가 찾지 못합니다.)`
  );
}

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

async function findChildDatabaseInPage(pageId) {
  try {
    const cleanId = pageId.replace(/-/g, '');
    const blocks = await notion('GET', `/blocks/${cleanId}/children?page_size=50`);
    for (const b of blocks.results || []) {
      if (b.type === 'child_database') {
        const childId = b.id.replace(/-/g, '');
        console.log(`  ✓ 페이지 내에서 자식 데이터베이스 블록 발견: [${b.child_database?.title}] (ID: ${childId})`);
        return await resolveDbToDataSource(childId);
      }
    }
  } catch {}
  return null;
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

  let endpoint = `/data_sources/${targetId}/query`;
  try {
    await notion('POST', endpoint, { page_size: 1 });
  } catch (err) {
    endpoint = `/databases/${targetId}/query`;
  }

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

function buildEdges(nodes) {
  const ids = new Set(nodes.map(n => n.id));
  const seen = new Set();
  const edges = [];

  for (const n of nodes) {
    for (const targetId of n.links) {
      if (!ids.has(targetId)) continue;
      const key = n.id < targetId ? `${n.id}|${targetId}` : `${targetId}|${n.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push([n.id, targetId]);
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
    prev = new Map(prevGraph.nodes.map(n => [n.id, n.edited]));
    console.log(`• 이전 캐시 복호화 성공: ${prev.size}개 노트 캐시됨`);
  } catch {
    console.log(`• 신규 빌드 (전체 동기화 시작)`);
  }

  console.log(`\n=== [4/4] 노션 노트 및 본문 수집 시작 ===`);
  const nodes = await queryAll(targetId);
  console.log(`• 노션 전체 노트 수: ${nodes.length}개 발견`);

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
  for (const n of nodes) {
    let body = '';
    try {
      const { md } = JSON.parse(await open(key, await fs.readFile(`${OUT}/n/${n.id}.enc`)));
      body = (md || '').replace(/[#>*_`\[\]()!|-]+/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);
    } catch {}

    searchIndex.push({
      id: n.id,
      title: n.title,
      tags: n.tags,
      folder: n.folder,
      summary: n.summary,
      text: [n.title, n.tags.join(' '), n.folder, n.summary, body].join(' ')
    });
  }

  const slimNodes = nodes.map(({ links, summary, ...rest }) => rest);
  await fs.writeFile(`${OUT}/graph.enc`, await seal(key, JSON.stringify({ nodes: slimNodes, edges: buildEdges(nodes) })));
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
