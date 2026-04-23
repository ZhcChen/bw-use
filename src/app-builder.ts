/**
 * Legacy bundle id kept for cleaning up old macOS wrapper apps created by
 * previous versions that supported standalone Dock icons.
 */
export function getBundleId(id: string) {
  return `com.bw-use.browser.${id}`;
}
