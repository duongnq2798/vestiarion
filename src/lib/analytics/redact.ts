export function redactPath(pathname: string): string {
  if (/^\/invite\/[^/]+/.test(pathname)) return "/invite/:token";
  return pathname.replace(/^\/o\/[^/]+/, "/o/:org");
}
