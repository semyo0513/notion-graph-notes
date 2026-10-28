// Notion API 최신 규격 (2025-09-03 / 2026-03-11 대응)
// 페이지 ID가 들어와도 자식 DB 자동 탐색 & Database ID로부터 Data Source ID 자동 해석
import { webcrypto as crypto } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';

const { NOTION_TOKEN, DATA_SOURCE_ID, DATA_PASSPHRASE } = process.env;

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
console.log(`• 추출된 초기 ID: ${RAW_ID}\n`);

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

/* ───── 실제 쿼리할 Data Source ID 자동 해석 ───── */
async function resolveDataSourceId(initialId) {
  console.log(`=== [2/4] Notion 엔티티 타입 분석: ${initialId} ===`);

  // 1. Data Source ID로 바로 쿼리 가능한지 시도
  try {
    console.log(`• 1차 시도: data_sources/${initialId}/query 테스트...`);
    await notion('POST', `/data_sources/${initialId}/query`, { page_size: 1 });
    console.log(`✓ 확인 완료: ${initialId} 는 유효한 Data Source ID입니다.\n`);
    return initialId;
  } catch (err) {
    console.log(`  (data_sources 쿼리 불가: ${err.details || err.message})`);
  }

  // 2. Database 객체인지 확인 (GET /databases/:id)
  try {
    console.log(`• 2차 시도: databases/${initialId} 메타데이터 조회...`);
    const dbObj = await notion('GET', `/databases/${initialId}`);
    console.log(`✓ Database 발견! 제목: ${dbObj.title?.map(t => t.plain_text).join('') || '제목 없음'}`);

    // 최신 API 규격: databases 객체 내의 data_sources 목록 확인
    if (Array.isArray(dbObj.data_sources) && dbObj.data_sources.length > 0) {
      const dsId = dbObj.data_sources[0].id;
      console.log(`✓ Database 내부의 Data Source ID 발견: ${dsId}\n`);
      return dsId;
    }
    // 이전 API 규격 DB라면 ID 그대로 반환
    return initialId;
  } catch (err) {
    console.log(`  (databases 조회 불가: ${err.details || err.message})`);
  }

  // 3. Page 객체인지 확인 (GET /pages/:id) -> 페이지 안의 자식 DB 탐색
  try {
    console.log(`• 3차 시도: pages/${initialId} 조회 (페이지 내 인라인 DB 탐색)...`);
    const pageObj = await notion('GET', `/pages/${initialId}`);
    console.log(`✓ 입력된 ID는 페이지(Page)입니다. 페이지 내의 데이터베이스 블록을 탐색합니다...`);

    const blocks = await notion('GET', `/blocks/${initialId}/children?page_size=100`);
    for (const b of blocks.results || []) {
      if (b.type === 'child_database') {
        const childDbId = b.id.replace(/-/g, '');
        console.log(`✓ 페이지 내에서 자식 데이터베이스 발견! [${b.child_database?.title}] (ID: ${childDbId})`);
        return await resolveDataSourceId(childDbId);
      }
    }
    throw new Error('이 페이지 안에서 child_database(데이터베이스)를 찾을 수 없습니다.');
  } catch (err) {
    console.log(`  (pages 조회 불가: ${err.details || err.message})`);
  }

  // 4. 검색 API로 통합 봇이 접근 가능한 모든 DB/Data Source 목록 출력 및 자동 연결
  console.log(`• 4차 시도: 통합 봇이 접근 가능한 데이터 소스 전체 검색...`);
  try {
    // 최신 API 규격: filter.value = 'data_source', in_trash = false
    let searchRes;
    try {
      searchRes = await notion('POST', '/search', {
        filter: { value: 'data_source', property: 'object' },
        in_trash: false,
        page_size: 10
      });
    } catch {
      // 필터 없는 전체 검색 폴백
      searchRes = await notion('POST', '/search', {
        in_trash: false,
        page_size: 20
      });
    }

    const items = searchRes.results || [];
    if (items.length > 0) {
      console.log(`✓ 통합 봇에게 공유된 노션 항목 (${items.length}개 발견):`);
      for (const item of items) {
        const type = item.object;
        const title = (item.title || item.properties?.['이름']?.title || [])
          .map(t => t.plain_text).join('') || item.id;
        console.log(`  - [${type}] "${title}" (ID: ${item.id.replace(/-/g, '')})`);
      }

      // data_source 또는 database 항목 찾기
      const targetEntity = items.find(i => i.object === 'data_source') ||
                           items.find(i => i.object === 'database') ||
                           items[0];

      if (targetEntity) {
        const foundId = targetEntity.id.replace(/-/g, '');
        console.log(`\n➔ 발견된 항목 "${targetEntity.object}" (ID: ${foundId})로 자동 동기화를 진행합니다!\n`);
        return foundId;
      }
    } else {
      console.log(`  (통합 봇에게 공유된 데이터베이스가 0개입니다)`);
    }
  } catch (err) {
    console.log(`  (검색 API 오류: ${err.message})`);
  }

  throw new Error(
    `입력하신 ID(${initialId})에 해당하는 데이터베이스를 찾을 수 없으며, 통합 봇 "옵시디언2"에게 공유된 데이터가 없습니다.\n\n` +
    `[가장 중요한 해결 방법]\n` +
    `1. 그래프로 보고자 하시는 노션 데이터베이스 페이지를 엽니다.\n` +
    `2. 페이지 우측 상단 [···] 클릭 -> [연결(Connections)] 클릭\n` +
    `3. 목록에서 통합 봇 "옵시디언2" 를 반드시 추가해 주세요!\n` +
    `   (이 작업을 하지 않으면 노션 보안 정책상 API로 데이터를 가져올 수 없습니다)`
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

/* ───── 노트 목록 쿼리 ───── */
async function queryAll(targetId) {
  const nodes = [];
  let cursor = null;

  // 1차 시도: data_sources 쿼리
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

  // 1. 실제 Data Source ID 자동 해석
  const targetId = await resolveDataSourceId(RAW_ID);

  // 2. 암호화 키 생성 및 캐시 확인
  console.log(`=== [3/4] 암호화 키 및 증분 캐시 검사 ===`);
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
    console.log(`• 신규 빌드 (전체 동기화)`);
  }

  // 3. 전체 노트 조회
  console.log(`\n=== [4/4] 노션 노트 및 본문 수집 시작 ===`);
  const nodes = await queryAll(targetId);
  console.log(`• 노션 전체 노트 수: ${nodes.length}개`);

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

  console.log(`\n🎉 [완료] 전체 노트 ${nodes.length}개 동기화 및 암호화 완료! (본문 신규/갱신: ${fetched}개)`);
}

main().catch(err => {
  console.error(`\n❌ [동기화 실패]: ${err.message}`);
  process.exit(1);
});
