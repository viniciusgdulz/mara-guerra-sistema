export function isAuthRoute(pathname: string): boolean {
  return ["/api/auth/login", "/api/auth/logout", "/api/auth/me"].includes(pathname);
}
