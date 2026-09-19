import { describe, expect, it, vi } from "vitest";
import { startBackgroundJob } from "../src/backfill-job";

describe("startBackgroundJob", () => {
  it("returns its acknowledgement without waiting for a large job", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job = vi.fn(() => pending);
    const onError = vi.fn();

    const acknowledgement = startBackgroundJob(
      job,
      { inProgress: true },
      onError,
    );

    expect(acknowledgement).toEqual({ inProgress: true });
    expect(job).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    finish();
    await pending;
  });

  it("reports failures from the detached job", async () => {
    const error = new Error("failed");
    const onError = vi.fn();

    startBackgroundJob(() => Promise.reject(error), undefined, onError);
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
