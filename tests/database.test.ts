import { describe, expect, it } from "vitest";
import { databaseStatus } from "../src/database/db.js";
import { repositories } from "../src/database/repositories.js";

describe("database repositories", () => {
  it("persists messages, jobs, runs, steps, and previews", () => {
    expect(databaseStatus().ok).toBe(true);
    const messageId = `db-test-${Date.now()}`;
    const first = repositories.createIncomingMessage({
      source: "web",
      senderId: "tester",
      messageId,
      text: "测试 GitHub 链接",
      normalizedPayload: { text: "测试 GitHub 链接" }
    });
    const duplicate = repositories.createIncomingMessage({
      source: "web",
      senderId: "tester",
      messageId,
      text: "测试 GitHub 链接",
      normalizedPayload: { text: "测试 GitHub 链接" }
    });
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);

    const job = repositories.createJob({
      messageRecordId: first.record.id,
      source: "web",
      senderId: "tester",
      status: "running",
      intentType: "new_ingest"
    });
    repositories.markIncomingMessageProcessed(first.record.id, job.id);
    const run = repositories.createRun({ jobId: job.id, status: "running", inputState: { text: "hello" } });
    repositories.addStep({
      runId: run.id,
      jobId: job.id,
      nodeName: "parse_input",
      status: "success",
      inputSummary: "hello",
      outputSummary: "0 urls"
    });
    repositories.addToolCall({
      runId: run.id,
      jobId: job.id,
      nodeName: "parse_input",
      toolName: "url_parser",
      input: { text: "hello" },
      output: { urls: [] },
      status: "success",
      durationMs: 3
    });

    const previewId = `pv_db_${Date.now()}`;
    repositories.savePreview(
      {
        previewId,
        summary: "db preview",
        detectedProjects: [],
        notesToWrite: [],
        knowledge: [],
        ideas: [],
        warnings: [],
        request: { text: "hello", source: "web", senderId: "tester", messageId },
        parsedInput: { rawText: "hello", urls: [], githubRepos: [], douyinUrls: [], candidateQuery: "hello" },
        douyin: [],
        ocr: [],
        githubRepos: [],
        createdAt: new Date().toISOString(),
        status: "pending"
      },
      job.id,
      run.id,
      "# preview"
    );

    expect(repositories.getJob(job.id)?.status).toBe("running");
    expect(repositories.getRun(run.id)?.status).toBe("running");
    expect(repositories.listRunSteps(run.id)).toHaveLength(1);
    expect(repositories.listRunToolCalls(run.id)).toMatchObject([{ toolName: "url_parser", status: "success" }]);
    expect(repositories.getStoredPreview(previewId)?.summary).toBe("db preview");
    expect(repositories.listPreviews(10).some((preview) => preview.runId === run.id)).toBe(true);
  });
});
