import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { OcrResult } from "../types.js";

export class OcrClient {
  async analyzeVideo(videoUrl?: string): Promise<OcrResult> {
    if (!videoUrl) {
      return { text: "", framesAnalyzed: 0, available: false, error: "No video URL available" };
    }
    const ffmpeg = await resolveCommand("ffmpeg");
    const tesseract = await resolveCommand("tesseract");
    if (!ffmpeg || !tesseract) {
      return {
        text: "",
        framesAnalyzed: 0,
        available: false,
        error: "ffmpeg and tesseract are required for OCR"
      };
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidianlink-ocr-"));
    let result: OcrResult;
    try {
      const videoPath = await prepareLocalVideo(videoUrl, dir);
      const subtitleText = await extractEmbeddedSubtitles(ffmpeg, videoPath, dir);
      const framePattern = path.join(dir, "frame-%03d.png");
      await run(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        videoPath,
        "-vf",
        `fps=1/${config.OCR_FRAME_INTERVAL_SECONDS}`,
        "-frames:v",
        String(config.OCR_MAX_FRAMES),
        framePattern
      ]);
      const frames = (await fs.readdir(dir)).filter((file) => file.endsWith(".png")).sort();
      const chunks: string[] = [];
      const frameTexts: string[] = [];
      if (subtitleText) chunks.push(subtitleText);
      for (const frame of frames) {
        const output = await run(tesseract, [path.join(dir, frame), "stdout", "-l", "chi_sim+eng"]);
        const clean = output.trim();
        if (clean) {
          frameTexts.push(clean);
          chunks.push(clean);
        }
      }
      result = {
        text: [...new Set(chunks.join("\n").split(/\n+/).map((line) => line.trim()).filter(Boolean))].join("\n"),
        framesAnalyzed: frames.length,
        available: true,
        sourceVideo: videoUrl,
        subtitleText,
        frameTexts
      };
    } catch (error) {
      result = {
        text: "",
        framesAnalyzed: 0,
        available: true,
        sourceVideo: videoUrl,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      result.tempCleaned = true;
    } catch (cleanupError) {
      result.tempCleaned = false;
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      result.error = result.error ? `${result.error}; cleanup failed: ${message}` : `cleanup failed: ${message}`;
    }
    return result;
  }
}

async function prepareLocalVideo(videoUrl: string, dir: string): Promise<string> {
  if (!/^https?:\/\//i.test(videoUrl)) return videoUrl;
  const response = await fetch(videoUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 ObsidianLink/0.1"
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Video download failed: ${response.status} ${response.statusText}`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > config.OCR_MAX_VIDEO_BYTES) {
    throw new Error(`Video is too large for OCR: ${length} bytes`);
  }
  const target = path.join(dir, "source-video.mp4");
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > config.OCR_MAX_VIDEO_BYTES) {
        callback(new Error(`Video exceeded OCR size limit: ${bytes} bytes`));
        return;
      }
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), limiter, createWriteStream(target));
  return target;
}

async function resolveCommand(command: string): Promise<string | undefined> {
  const candidates = [
    command,
    `/Users/sky/.homebrew/bin/${command}`,
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`
  ];
  for (const candidate of candidates) {
    try {
      await run(candidate, command === "ffmpeg" ? ["-version"] : ["--version"]);
      return candidate;
    } catch {
      // Try the next common install path.
    }
  }
  return undefined;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function extractEmbeddedSubtitles(ffmpeg: string, videoUrl: string, dir: string): Promise<string> {
  const subtitlePath = path.join(dir, "subtitle.srt");
  try {
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", videoUrl, "-map", "0:s:0", "-f", "srt", subtitlePath]);
    const raw = await fs.readFile(subtitlePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^\d+$/.test(line) && !/^\d\d:\d\d:\d\d[,.]\d+ --> /.test(line))
      .join("\n");
  } catch {
    return "";
  }
}
