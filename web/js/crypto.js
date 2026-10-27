// Web Crypto API 기반 복호화 유틸리티
// scripts/sync.mjs와 동일 규격: PBKDF2-SHA256 -> AES-256-GCM, [IV 12바이트 | 암호문], gzip 압축

/**
 * 패스프레이즈와 salt를 사용하여 non-extractable AES-GCM 256비트 CryptoKey 도출
 */
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

/**
 * gzip 압축 해제 헬퍼 (DecompressionStream 표준 지원)
 */
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

  // DecompressionStream이 없는 구형 브라우저 처리
  throw new Error('브라우저가 DecompressionStream API를 지원하지 않습니다. 최신 브라우저를 사용해 주세요.');
}

/**
 * 암호화된 파일(.enc)을 가져와 복호화 후 파싱된 JSON 객체 반환
 */
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

  // AES-GCM 복호화 (인증 태그 검증 실패 시 에러 발생 -> 패스프레이즈 불일치 판정)
  let decryptedBytes;
  try {
    decryptedBytes = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
  } catch (err) {
    throw new Error('복호화에 실패했습니다. 패스프레이즈가 일치하지 않거나 파일이 손상되었습니다.');
  }

  // gzip 압축 해제 -> JSON 파싱
  const jsonText = await decompressGzip(new Uint8Array(decryptedBytes));
  return JSON.parse(jsonText);
}
