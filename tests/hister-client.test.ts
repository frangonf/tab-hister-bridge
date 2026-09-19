import { describe, expect, it, vi } from "vitest";
import {
  checkHisterConnection,
  deleteHisterDocumentRequest,
  getHisterDocument,
  updateHisterLabelRequest,
} from "../src/hister-client";

describe("checkHisterConnection", () => {
  it("rejects an invalid access token", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 })
    );

    const result = await checkHisterConnection(
      fetchFn,
      "http://127.0.0.1:4433",
      { Authorization: "Bearer invalid" }
    );

    expect(result).toEqual({ reachable: true, authorized: false, status: 401 });
  });

  it("reports network failures as unreachable", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValueOnce(
      new TypeError("network down")
    );

    const result = await checkHisterConnection(
      fetchFn,
      "http://127.0.0.1:4433",
      {}
    );

    expect(result).toEqual({ reachable: false, authorized: false });
  });

  it("accepts an authenticated document-not-found response", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("not found", { status: 404 })
    );

    const result = await checkHisterConnection(
      fetchFn,
      "http://127.0.0.1:4433/",
      {}
    );

    expect(result).toEqual({ reachable: true, authorized: true, status: 404 });
  });
});

describe("getHisterDocument", () => {
  it("falls back to the raw URL when a canonical Hister lookup misses", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({
          url: "https://example.com/page?utm_source=x#part",
          text: "Body",
          label: "manual",
          metadata: { source: "existing" },
        })
      );

    const result = await getHisterDocument(
      fetchFn,
      "http://127.0.0.1:4433",
      "https://example.com/page?utm_source=x#part",
      {}
    );

    expect(result).toMatchObject({
      exists: true,
      actualUrl: "https://example.com/page?utm_source=x#part",
      hasText: true,
      label: "manual",
      metadata: { source: "existing" },
      matchedLegacyUrl: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("reports a duplicate legacy identity when the canonical document also exists", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          url: "https://example.com/page",
          text: "Canonical",
          label: "stash",
          metadata: {},
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          url: "https://example.com/page?utm_source=x#part",
          text: "Legacy",
          label: "manual",
          metadata: {},
        })
      );

    const result = await getHisterDocument(
      fetchFn,
      "http://127.0.0.1:4433",
      "https://example.com/page?utm_source=x#part",
      {}
    );

    expect(result).toMatchObject({
      exists: true,
      actualUrl: "https://example.com/page",
      legacyUrl: "https://example.com/page?utm_source=x#part",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not treat authorization failures as missing documents", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const result = await getHisterDocument(
      fetchFn,
      "http://127.0.0.1:4433",
      "https://example.com/page?utm_source=x#part",
      {}
    );

    expect(result).toMatchObject({ exists: false, lookupStatus: 401 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("deleteHisterDocumentRequest", () => {
  it("deletes a legacy raw URL through Hister's URL query", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, { status: 200 })
    );

    const ok = await deleteHisterDocumentRequest(
      fetchFn,
      "http://127.0.0.1:4433",
      "https://example.com/page?utm_source=x#part",
      {}
    );

    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:4433/api/delete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "url:https://example.com/page?utm_source=x#part" }),
      })
    );
  });
});

describe("updateHisterLabelRequest", () => {
  it("falls back to the raw identity only for a canonical 404", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await updateHisterLabelRequest(
      fetchFn,
      "http://127.0.0.1:4433",
      "https://example.com/page?utm_source=x#part",
      "stash/group",
      {}
    );

    expect(result).toEqual({
      ok: true,
      status: 200,
      actualUrl: "https://example.com/page?utm_source=x#part",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
