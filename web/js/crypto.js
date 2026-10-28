// Web Crypto API 기반 복호화 유틸리티
// PBKDF2-SHA256 (600,000회) -> AES-256-GCM, [IV 12바이트 | 암호문], gzip 압축해제

export async function deriveKey(passphrase, saltB64, iter) {
  const binaryString = atob(saltB64);
  const salt = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    salt[i] = binaryString.charCodeAt(i);
  }

  const te = new TextEncoder();
  const baseKey = await window.crypto.subtle.importKey(
    'raw',
    te.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: iter,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // 키 추출 불가 (메모리 보안)
    ['decrypt']
  );
}

async function decompressGzip(compressedBytes) {
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(compressedBytes);
    writer.close();
    const response = new Response(ds.readable);
    const arrayBuffer = await response.arrayBuffer();
    return new TextDecoder().decode(arrayBuffer);
  }
  throw new Error('브라우저가 DecompressionStream API를 지원하지 않습니다.');
}

export async function openFile(key, url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`파일 로드 실패 [${res.status}]: ${url}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 12) {
    throw new Error('유효하지 않은 암호화 데이터 포맷입니다.');
  }

  const iv = buf.subarray(0, 12);
  const ciphertext = buf.subarray(12);

  let decryptedBytes;
  try {
    decryptedBytes = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
  } catch {
    throw new Error('패스프레이즈가 일치하지 않습니다.');
  }

  const jsonText = await decompressGzip(new Uint8Array(decryptedBytes));
  return JSON.parse(jsonText);
}
