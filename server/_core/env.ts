export const ENV = {
  // 兜底非空默认值：JWT 会把 appId 写入 payload，且 verifySession 要求 appId 非空，
  // 否则账密登录(未配 VITE_APP_ID)时 token 校验必然失败 → auth.me 返回 null → 登录后 404。
  appId: process.env.VITE_APP_ID || "audio-eval",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",

  // 京东云 OSS(S3 兼容)对象存储配置
  ossEndpoint: process.env.OSS_ENDPOINT ?? "",
  ossRegion: process.env.OSS_REGION ?? "cn-north-1",
  ossBucket: process.env.OSS_BUCKET ?? "",
  ossAccessKeyId: process.env.OSS_ACCESS_KEY_ID ?? "",
  ossSecretAccessKey: process.env.OSS_SECRET_ACCESS_KEY ?? "",

  // 管理员账号密码登录(脱离 Manus OAuth 后的管理端门禁)
  adminUsername: process.env.ADMIN_USERNAME ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  adminOpenId: process.env.ADMIN_OPEN_ID ?? "admin",
};
