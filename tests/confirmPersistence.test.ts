import { describe, expect, it } from "vitest";
import { repositories } from "../src/database/repositories.js";
import { IngestService } from "../src/ingestService.js";
import { PreviewStore } from "../src/previewStore.js";
import { GeneratedNote, StoredPreview } from "../src/types.js";

describe("persistent preview confirmation", () => {
  it("returns an existing preview for duplicate source message ids", async () => {
    const messageId = `persist-duplicate-${Date.now()}`;
    const incoming = repositories.createIncomingMessage({
      source: "api",
      senderId: "dup-user",
      messageId,
      text: "幂等去重测试",
      normalizedPayload: { text: "幂等去重测试" }
    });
    const job = repositories.createJob({
      messageRecordId: incoming.record.id,
      source: "api",
      senderId: "dup-user",
      status: "waiting_user",
      intentType: "new_ingest"
    });
    const run = repositories.createRun({ jobId: job.id, status: "preview_generated", inputState: { text: "幂等去重测试" } });
    const preview = makeStoredPreview(messageId, "api", "dup-user");
    repositories.savePreview(preview, job.id, run.id, "# markdown");
    repositories.markIncomingMessageProcessed(incoming.record.id, job.id);
    repositories.updateJob(job.id, { previewId: preview.previewId });

    const service = new IngestService(new PreviewStore(), {} as never, {} as never, {} as never, {} as never, {} as never, repositories);
    const duplicate = await service.preview({
      text: "这条文本不应该重新处理",
      source: "api",
      senderId: "dup-user",
      messageId
    });

    expect(duplicate.previewId).toBe(preview.previewId);
    expect(duplicate.summary).toBe(preview.summary);
    expect(repositories.listJobs(20).filter((item) => item.messageRecordId === incoming.record.id)).toHaveLength(1);
  });

  it("can confirm a pending preview restored from SQLite instead of memory", async () => {
    const messageId = `persist-confirm-${Date.now()}`;
    const incoming = repositories.createIncomingMessage({
      source: "web",
      senderId: "persist-user",
      messageId,
      text: "跨重启确认测试",
      normalizedPayload: { text: "跨重启确认测试" }
    });
    const job = repositories.createJob({
      messageRecordId: incoming.record.id,
      source: "web",
      senderId: "persist-user",
      status: "waiting_user",
      intentType: "new_ingest"
    });
    const run = repositories.createRun({ jobId: job.id, status: "preview_generated", inputState: { text: "跨重启确认测试" } });
    const preview = makeStoredPreview(messageId, "web", "persist-user");
    repositories.savePreview(preview, job.id, run.id, "# markdown");

    const written: GeneratedNote[] = [];
    const vault = {
      planNotes: async (notes: GeneratedNote[]) =>
        notes.map((note) => ({
          title: note.title,
          path: note.relativePath,
          type: note.type,
          operation: "create" as const,
          reason: "test",
          confidence: 1
        })),
      writeNotes: async (notes: GeneratedNote[]) => {
        written.push(...notes);
        return notes.map((note) => `/tmp/${note.relativePath}`);
      }
    };
    const service = new IngestService(new PreviewStore(), vault as never, {} as never, {} as never, {} as never, {} as never, repositories);

    const result = await service.confirm({ previewId: preview.previewId, decision: "confirm" });

    expect(result.status).toBe("confirmed");
    expect(result.writtenFiles).toHaveLength(1);
    expect(written[0].type).toBe("inbox");
    expect(repositories.getPreview(preview.previewId)?.status).toBe("confirmed");
    expect(repositories.getStoredPreview(preview.previewId)?.status).toBe("confirmed");
  });

  it("does not create a second job when an incoming message exists without a job id", async () => {
    const messageId = `persist-unclaimed-${Date.now()}`;
    const incoming = repositories.createIncomingMessage({
      source: "api",
      senderId: "unclaimed-user",
      messageId,
      text: "未认领消息重复处理测试",
      normalizedPayload: { text: "未认领消息重复处理测试" }
    });
    const before = repositories.listJobs(200).filter((item) => item.messageRecordId === incoming.record.id);
    const service = new IngestService(new PreviewStore(), {} as never, {} as never, {} as never, {} as never, {} as never, repositories);

    await expect(
      service.preview({
        text: "这条不应该创建 job",
        source: "api",
        senderId: "unclaimed-user",
        messageId
      })
    ).rejects.toThrow("already received");

    const after = repositories.listJobs(200).filter((item) => item.messageRecordId === incoming.record.id);
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(0);
  });
});

function makeStoredPreview(messageId: string, source: StoredPreview["request"]["source"], senderId: string): StoredPreview {
  return {
    previewId: `pv_persist_${Date.now()}`,
    summary: "跨重启确认测试摘要",
    detectedProjects: [],
    notesToWrite: [],
    knowledge: [],
    ideas: [],
    warnings: [],
    request: {
      text: "跨重启确认测试",
      source,
      senderId,
      messageId
    },
    parsedInput: {
      rawText: "跨重启确认测试",
      urls: [],
      githubRepos: [],
      douyinUrls: [],
      candidateQuery: "跨重启确认测试"
    },
    douyin: [],
    ocr: [],
    githubRepos: [],
    createdAt: new Date().toISOString(),
    status: "pending"
  };
}
