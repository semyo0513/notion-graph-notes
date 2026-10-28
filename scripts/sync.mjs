// Notion API 직접 호출 → 정적 데이터 암호화 생성기 (Node 22 내장 fetch/crypto/zlib)
import { webcrypto as crypto } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';

const { NOTION_TOKEN, DATA_SOURCE_ID, DATA_PASSPHRASE } = process.env;

console.log('=== [1/4] GitHub Secrets 환경변수 확인 ===');
console.log(`• NOTION_TOKEN: ${NOTION_TOKEN ? '설정됨 (길이: ' + NOTION_TOKEN.length + '자)' : '❌ 누락됨!'}`);
console.log(`• DATA_SOURCE_ID: ${DATA_SOURCE_ID ? '설정됨 (입력값: ' + DATA_SOURCE_ID + ')' : '❌ 누락됨!'}`);
console.log(`• DATA_PASSPHRASE: ${DATA_PASSPHRASE ? '설정됨' : '❌ 누락됨!'}`);

if (!NOTION_TOKEN || !DATA_SOURCE_ID || !DATA_PASSPHRASE) {
  console.error('\n[치명적 오류] GitHub Secrets에 3가지 값이 모두 등록되어 있어야 합니다.');
  console.error('Settings -> Secrets and variables -> Actions 에서 NOTION_TOKEN, DATA_SOURCE_ID, DATA_PASSPHRASE 를 확인하세요.');
  process.exit(1);
}

/**
 * URL 전체가 들어와도 32자리 고유 ID(UUID)를 자동 추출
 */
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

const CLEAN_DB_ID = extractNotionId(DATA_SOURCE_ID);
console.log(`• 추출된 최종 Database ID: ${CLEAN_DB_ID}\n`);
const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const OUT = 'dist/data';
const ITER = 600000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const te = new TextEncoder(), td = new TextDecoder();
const b64 = u8 => Buffer.from(u8).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const exists = p => fs.access(p).then(() => true, () => false);

/* ───── Notion API 직접 호출 (서버 환경 = CORS 없음) ───── */
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
    let errCode = '';
    let errMsg = errText;
    try {
      const errJson = JSON.parse(errText);
      errCode = errJson.code || '';
      errMsg = errJson.message || errText;
    } catch {}

    if (res.status === 404) {
      throw new Error(
        `Notion API 404 오류: 데이터베이스 ID(${CLEAN_DB_ID})를 찾을 수 없습니다.\n` +
        `Notion 응답 메시지: [${errCode}] ${errMsg}\n\n` +
        `[해결 체크리스트]\n` +
        `1. 노션 DB 페이지 우측 상단 [···] -> [연결(Connections)]에 생성하신 통합 봇을 반드시 추가했는지 확인하세요.\n` +
        `2. 만약 입력하신 주소가 일반 페이지 주소라면, 데이터베이스 자체의 [링크 복사]를 눌러 데이터베이스 ID를 넣어주세요.`
      );
    }
    if (res.status === 401) {
      throw new Error(`Notion API 401 인증 실패: 토큰이 올바르지 않습니다. (응답: ${errMsg})`);
    }

    throw new Error(`Notion API [${res.status}] ${method} ${path.split('?')[0]}: ${errMsg}`);
  }
  throw new Error('Notion API 요청 실패 (최대 재시도 초과)');
}

/* ───── 암호화 (브라우저 crypto.js와 동일 규격) ───── */
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
async function queryAll() {
  const nodes = [];
  let cursor = null;

  // 1차: data_sources 쿼리 (2025-09-03 이후)
  let endpoint = `/data_sources/${CLEAN_DB_ID}/query`;
  try {
    await notion('POST', endpoint, { page_size: 1 });
  } catch (err) {
    if (err.message.includes('404')) {
      // 2차: databases 쿼리
      endpoint = `/databases/${CLEAN_DB_ID}/query`;
    } else {
      throw err;
    }
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

/* ───── 메인 동기화 실행 ───── */
async function main() {
  await fs.mkdir(`${OUT}/n`, { recursive: true });

  const prevMeta = await fs.readFile(`${OUT}/meta.json`, 'utf8').then(JSON.parse, () => null);
  const salt = prevMeta?.salt ? unb64(prevMeta.salt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(DATA_PASSPHRASE, salt);

  let prev = new Map();
  try {
    const prevBuf = await fs.readFile(`${OUT}/graph.enc`);
    const prevGraph = JSON.parse(await open(key, prevBuf));
    prev = new Map(prevGraph.nodes.map(n => [n.id, n.edited]));
  } catch {}

  console.log(`[시작] 데이터베이스 ID: ${CLEAN_DB_ID} 쿼리 중...`);
  const nodes = await queryAll();

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

  console.log(`[완료] 노션 노트 총 ${nodes.length}개 동기화 / 본문 갱신: ${fetched}개`);
}

main().catch(err => {
  console.error(`동기화 실패: ${err.message}`);
  process.exit(1);
});
