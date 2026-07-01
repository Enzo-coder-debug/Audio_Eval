export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Generate login URL at runtime so redirect URI reflects the current origin.
export const getLoginUrl = () => {
  // 本地开发模式:直接走后端 mock 登录,脱离 Manus OAuth。
  // 默认以 admin 身份登录;如需普通用户登录,可手动访问 /api/dev/login?role=user。
  if (import.meta.env.DEV) {
    return `${window.location.origin}/api/dev/login`;
  }

  // 生产环境(脱离 Manus):答卷人走免登录分享链接,仅管理员需登录。
  // 跳转到内置管理员账号密码登录页。
  return `${window.location.origin}/admin/login`;
};
