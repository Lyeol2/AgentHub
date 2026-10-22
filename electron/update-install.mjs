// Keep the HTTP response independent of shutdown: shutdown waits for active
// requests to finish before saving. The installer starts only after that save.
export function createUpdateInstall({ prepare, install, onError, schedule = setImmediate }) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    schedule(async () => {
      try {
        await prepare();
        install();
      } catch (error) {
        pending = false;
        onError(error);
      }
    });
  };
}
