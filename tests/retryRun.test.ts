import { describe, expect, it } from "vitest";
import { repositories } from "../src/database/repositories.js";
import { IngestService } from "../src/ingestService.js";
import { PreviewStore } from "../src/previewStore.js";
import { GeneratedNote } from "../src/types.js";

describe("agent run retry", () => {
  it("rebuilds a preview from the original incoming message", async () => {
    const messageId = `retry-${Date.now()}`;
    const incoming = repositories.createIncomingMessage({
      source: "api",
      senderId: "retry-user",
      messageId,
      text: "重试一条关于多渠道消息入口的知识",
      normalizedPayload: { text: "重试一条关于多渠道消息入口的知识", source: "api", senderId: "retry-user", messageId }
    });
    const job = repositories.createJob({
      messageRecordId: incoming.record.id,
      source: "api",
      senderId: "retry-user",
      status: "failed",
      intentType: "new_ingest"
    });
    repositories.markIncomingMessageProcessed(incoming.record.id, job.id);
    const failedRun = repositories.createRun({
      jobId: job.id,
      status: "failed",
      inputState: { input: { rawText: incoming.record.text } }
    });
    repositories.updateRun(failedRun.id, { status: "failed", error: "model failed", endedAt: new Date().toISOString() });

    const service = new IngestService(
      new PreviewStore(),
      {
        readExistingProjectIndex: async () => "",
        planNotes: async (notes: GeneratedNote[]) =>
          notes.map((note) => ({
            title: note.title,
            path: note.relativePath,
            type: note.type,
            operation: "create" as const,
            reason: "retry test",
            confidence: 1
          }))
      } as never,
      {} as never,
      { getRepo: async () => undefined, searchRepo: async () => undefined } as never,
      {} as never,
      {
        analyze: async () => ({
          summary: "重试后生成的预览",
          detectedProjects: [],
          tags: ["retry"],
          knowledge: [
            {
              title: "多渠道消息入口重试机制",
              category: "智能体架构",
              contentKind: "method",
              domains: ["AI智能体", "自动化"],
              entities: ["Agent Run", "Job Queue"],
              summary: "失败 run 可以复用原始 incoming message 重新生成 preview。",
              keyPoints: ["复原输入", "新建 run", "保留 job"],
              sourceInsights: ["retry API 不再是 501"],
              relatedConcepts: ["任务状态机"],
              applicationIdeas: ["流水线页一键重试"],
              nextActions: ["继续补 UI 按钮"]
            }
          ],
          ideas: [
            {
              title: "失败任务一键修复台",
              ideaKind: "automation",
              combinedWith: ["Agent Run", "Job Queue"],
              productConcept: "在流水线页看到失败后直接重试。",
              softwarePossibility: "POST /api/agent/runs/:runId/retry。",
              hardwarePossibility: "可接快捷键。",
              userScenario: "模型接口短暂失败后重新跑。",
              minimalExperiment: "对失败 run 调 retry。",
              nextAction: "把按钮接到前端。"
            }
          ]
        })
      } as never,
      repositories
    );

    const retried = await service.retryRun(failedRun.id);
    const updatedJob = repositories.getJob(job.id);

    expect(retried.status).toBe("waiting_user");
    expect(retried.runId).not.toBe(failedRun.id);
    expect(retried.previewId).toMatch(/^pv_/);
    expect(retried.knowledge[0].title).toBe("多渠道消息入口重试机制");
    expect(updatedJob?.status).toBe("waiting_user");
    expect(updatedJob?.previewId).toBe(retried.previewId);
    expect(updatedJob?.retryCount).toBe(1);
  });
});
