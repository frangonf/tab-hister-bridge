export function startBackgroundJob<T>(
  job: () => Promise<void>,
  acknowledgement: T,
  onError: (error: unknown) => void,
): T {
  try {
    void job().catch(onError);
  } catch (error) {
    onError(error);
  }
  return acknowledgement;
}
