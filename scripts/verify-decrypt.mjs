import { webcrypto as crypto } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';

const te = new TextEncoder(), td = new TextDecoder();
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

async function open(key, buf) {
  const iv = buf.subarray(0, 12);
  const ct = buf.subarray(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return td.decode(gunzipSync(new Uint8Array(decrypted)));
}

async function test() {
  const meta = JSON.parse(await fs.readFile('dist/data/meta.json', 'utf8'));
  const salt = unb64(meta.salt);

  // 1. 정상 패스프레이즈 검증
  const key = await deriveKey('test-passphrase-1234', salt, meta.iter);
  const graphBuf = await fs.readFile('dist/data/graph.enc');
  const graphJson = JSON.parse(await open(key, graphBuf));
  console.log(`[성공] graph.enc 복호화 성공: 노드 ${graphJson.nodes.length}개, 엣지 ${graphJson.edges.length}개`);

  const n1Buf = await fs.readFile('dist/data/n/n1.enc');
  const n1Json = JSON.parse(await open(key, n1Buf));
  console.log(`[성공] n1.enc 복호화 성공: 본문 길이 ${n1Json.md.length}자`);

  // 2. 틀린 패스프레이즈로 복호화 시도 (반드시 실패해야 함)
  const wrongKey = await deriveKey('wrong-passphrase', salt, meta.iter);
  let failed = false;
  try {
    await open(wrongKey, graphBuf);
  } catch (e) {
    failed = true;
    console.log('[성공] 틀린 패스프레이즈 입력 시 복호화 거부 확인 완료');
  }

  if (!failed) {
    throw new Error('보안 실패: 잘못된 패스프레이즈로 복호화가 되었습니다!');
  }
}

test().catch(err => {
  console.error('테스트 실패:', err);
  process.exit(1);
});
