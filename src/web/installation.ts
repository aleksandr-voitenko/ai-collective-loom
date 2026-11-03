/** Server-issued public presentation metadata; never an authorization signal. */
export function isStagingInstallation() {
  return (
    document.querySelector('meta[name="loom-deployment"]')?.getAttribute('content') === 'staging'
  );
}
