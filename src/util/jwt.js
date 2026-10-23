/** 只用来读取 JWT 的 exp/sub，不做签名校验（签名校验收端在上游）。 */
export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function jwtExpiresInSeconds(token) {
  const payload = decodeJwt(token);
  if (typeof payload?.exp !== 'number') return null;
  return payload.exp - Math.floor(Date.now() / 1000);
}
