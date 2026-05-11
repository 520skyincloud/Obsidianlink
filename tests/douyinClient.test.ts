import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDouyinParseUrl, DouyinClient } from "../src/clients/douyin.js";

describe("DouyinClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts successful top-level parser payloads without data", async () => {
    const redirectResponse = new Response("", { status: 200 });
    Object.defineProperty(redirectResponse, "url", {
      value: "https://www.douyin.com/video/7633983870261562674",
      configurable: true
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            msg: "解析成功",
            platform: "douyin",
            type: "视频",
            author: { nickname: "不想写代码" },
            desc: "一不小心发现宝藏项目"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(redirectResponse);

    const result = await new DouyinClient().parse("https://v.douyin.com/demo/");

    expect(result.type).toBe("视频");
    expect(result.nickname).toBe("不想写代码");
    expect(result.desc).toBe("一不小心发现宝藏项目");
    expect(result.awemeId).toBe("7633983870261562674");
  });

  it("normalizes BugPk parser payloads to OCR-friendly video metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 200,
          msg: "解析成功",
          data: {
            type: "video",
            title: "一不小心发现宝藏项目 #开源项目",
            desc: "一不小心发现宝藏项目 #开源项目",
            author: { name: "不想写代码", id: 7631012092032042041 },
            url: "https://example.com/1080.mp4",
            video_backup: [
              { quality: "2160p", url: "https://example.com/2160-h265.mp4", bit_rate: 1106207, width: 3840, height: 2160, codec: "h265" },
              { quality: "720p", url: "https://example.com/720-h264.mp4", bit_rate: 1001774, width: 1280, height: 720, codec: "h264" }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await new DouyinClient().parse("https://v.douyin.com/demo/");

    expect(result.nickname).toBe("不想写代码");
    expect(result.desc).toBe("一不小心发现宝藏项目 #开源项目");
    expect(result.videoUrl).toBe("https://example.com/1080.mp4");
    expect(result.videoUrlHQ).toBe("https://example.com/720-h264.mp4");
  });

  it("builds parser URLs for query-style endpoints", () => {
    expect(buildDouyinParseUrl("https://api.bugpk.com/api/douyin", "https://v.douyin.com/demo/")).toBe(
      "https://api.bugpk.com/api/douyin?url=https%3A%2F%2Fv.douyin.com%2Fdemo%2F"
    );
    expect(buildDouyinParseUrl("https://api.bugpk.com/api/douyin?url=", "https://v.douyin.com/demo/")).toBe(
      "https://api.bugpk.com/api/douyin?url=https%3A%2F%2Fv.douyin.com%2Fdemo%2F"
    );
  });
});
