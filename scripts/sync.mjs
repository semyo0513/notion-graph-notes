// Notion → 암호화 정적 데이터 생성기
// 의존성 없음 (Node 22 내장 fetch, crypto, zlib 사용)
import { webcrypto as crypto } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

// .env 지원 (로컬 실행 시 편의)
try {
  const envContent = await fs.readFile('.env', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {
  // .env 파일이 없으면 환경변수 그대로 사용
}

const { NOTION_TOKEN, DATA_SOURCE_ID, DATA_PASSPHRASE } = process.env;
if (!NOTION_TOKEN || !DATA_SOURCE_ID || !DATA_PASSPHRASE) {
  console.error('오류: NOTION_TOKEN, DATA_SOURCE_ID, DATA_PASSPHRASE 환경변수가 필요합니다.');
  process.exit(1);
}

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const OUT = 'dist/data';
const ITER = 600000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const te = new TextEncoder(), td = new TextDecoder();
const b64 = u8 => Buffer.from(u8).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const exists = p => fs.access(p).then(() => true, () => false);

/* ───── Notion API 호출 (Retry-After 준수) ───── */
async function notion(method, apiPath, body) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(NOTION + apiPath, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (res.status === 429 || res.status === 529) {
      const retryAfter = Number(res.headers.get('retry-after') || 1);
      const waitTime = Math.min(retryAfter, 30) * 1000 + i * 300;
      await sleep(waitTime);
      continue;
    }

    if (res.ok) return res.json();

    const errText = await res.text().catch(() => '');
    throw new Error(`Notion API 오류 [${res.status}] ${method} ${apiPath.split('?')[0]}: ${errText.slice(0, 100)}`);
  }
  throw new Error('Notion API 요청 실패 (최대 재시도 초과)');
}

/* ───── 암호화 / 복호화 ───── */
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
  // 문자열 → gzip → AES-GCM → [IV(12 바이트) | 암호문]
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

/* ───── Notion 데이터 쿼리 ───── */
async function queryAll() {
  const nodes = [];
  let cursor = null;

  // 1차 시도: data_sources 쿼리 (2025-09-03 이후 권장)
  let endpoint = `/data_sources/${DATA_SOURCE_ID}/query`;
  try {
    const test = await notion('POST', endpoint, { page_size: 1 });
  } catch (err) {
    // 혹시 기존 DB ID인 경우 폴백
    endpoint = `/databases/${DATA_SOURCE_ID}/query`;
  }

  do {
    const r = await notion('POST', endpoint, {
      page_size: 100,
      ...(cursor && { start_cursor: cursor })
    });
    for (const p of r.results) {
      nodes.push(toNode(p));
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);

  return nodes;
}

function toNode(p) {
  const P = p.properties || {};

  // '이름' 또는 title 속성 탐색
  let titleProp = P['이름']?.title;
  if (!titleProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'title');
    if (key) titleProp = P[key].title;
  }
  const title = (titleProp || []).map(t => t.plain_text).join('') || '(제목 없음)';

  // '태그' 또는 multi_select 속성 탐색
  let tagsProp = P['태그']?.multi_select;
  if (!tagsProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'multi_select');
    if (key) tagsProp = P[key].multi_select;
  }
  const tags = (tagsProp || []).map(t => t.name);

  // '폴더' 또는 select 속성 탐색
  let folderProp = P['폴더']?.select?.name;
  if (!folderProp) {
    const key = Object.keys(P).find(k => P[k]?.type === 'select');
    if (key) folderProp = P[key]?.select?.name;
  }
  const folder = folderProp || '기본';

  // '요약' 속성 탐색
  const summary = ((P['요약']?.rich_text) || []).map(t => t.plain_text).join('');

  // '연결' 속성 탐색 (relation)
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

/* ───── 본문 Markdown 수집 ───── */
async function fetchPageMarkdown(pageId) {
  try {
    const res = await notion('GET', `/pages/${pageId}/markdown`);
    if (res && typeof res.markdown === 'string') {
      return res.markdown;
    }
  } catch (err) {
    // /pages/:id/markdown 미지원 시 블록 트리 폴백
  }

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
    return lines.join('\n\n') || '(내용이 없습니다.)';
  } catch {
    return '(본문을 불러올 수 없습니다.)';
  }
}

/* ───── 메인 동기화 실행 ───── */
async function main() {
  await fs.mkdir(`${OUT}/n`, { recursive: true });

  // 1) salt 재사용 확인 및 키 도출
  const prevMeta = await fs.readFile(`${OUT}/meta.json`, 'utf8').then(JSON.parse, () => null);
  const salt = prevMeta?.salt ? unb64(prevMeta.salt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(DATA_PASSPHRASE, salt);

  // 이전 graph.enc 복호화하여 변경 비교용 목록 복원
  let prev = new Map();
  try {
    const prevBuf = await fs.readFile(`${OUT}/graph.enc`);
    const prevGraph = JSON.parse(await open(key, prevBuf));
    prev = new Map(prevGraph.nodes.map(n => [n.id, n.edited]));
  } catch {
    // 첫 빌드이거나 패스프레이즈가 변경된 경우 전체 재수집
  }

  // 2) Notion 전체 노트 메타데이터 수집
  const nodes = await queryAll();

  // 3) 변경되거나 신규인 노트만 본문 재수집 (평균 3 req/s 준수: 340ms 지연)
  let fetched = 0;
  for (const n of nodes) {
    const filePath = `${OUT}/n/${n.id}.enc`;
    const isCached = prev.get(n.id) === n.edited && (await exists(filePath));
    if (isCached) continue;

    const md = await fetchPageMarkdown(n.id);
    const encData = await seal(key, JSON.stringify({ md }));
    await fs.writeFile(filePath, encData);
    fetched++;
    await sleep(340);
  }

  // 4) 삭제된 노트의 암호화 파일 정리
  const liveIds = new Set(nodes.map(n => `${n.id}.enc`));
  const existingFiles = await fs.readdir(`${OUT}/n`);
  for (const f of existingFiles) {
    if (!liveIds.has(f)) {
      await fs.unlink(`${OUT}/n/${f}`);
    }
  }

  // 5) 전문 검색 인덱스용 데이터 준비 (본문 앞부분 포함)
  const searchIndex = [];
  for (const n of nodes) {
    let bodyText = '';
    try {
      const buf = await fs.readFile(`${OUT}/n/${n.id}.enc`);
      const { md } = JSON.parse(await open(key, buf));
      bodyText = (md || '')
        .replace(/[#>*_`\[\]()!|-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 3000);
    } catch {
      // 오류 시 공백
    }

    searchIndex.push({
      id: n.id,
      title: n.title,
      tags: n.tags,
      folder: n.folder,
      summary: n.summary,
      text: [n.title, n.tags.join(' '), n.folder, n.summary, bodyText].join(' ')
    });
  }

  // 6) 그래프 데이터 및 검색 데이터 암호화 저장
  const slimNodes = nodes.map(({ links, summary, ...rest }) => rest);
  const graphPayload = {
    nodes: slimNodes,
    edges: buildEdges(nodes)
  };

  await fs.writeFile(`${OUT}/graph.enc`, await seal(key, JSON.stringify(graphPayload)));
  await fs.writeFile(`${OUT}/search.enc`, await seal(key, JSON.stringify(searchIndex)));
  await fs.writeFile(
    `${OUT}/meta.json`,
    JSON.stringify({
      v: 1,
      salt: b64(salt),
      iter: ITER,
      builtAt: new Date().toISOString()
    })
  );

  console.log(`[완료] 노션 노트 총 ${nodes.length}개 / 본문 갱신: ${fetched}개`);
}

main().catch(err => {
  console.error(`실행 실패: ${err.message}`);
  process.exit(1);
});
