import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { ObsidianVault } from "../src/obsidian/vault.js";
import { GeneratedNote } from "../src/types.js";

describe("ObsidianVault write operations", () => {
  it("plans existing files as append/update operations and does not overwrite them", async () => {
    const originalVault = config.OBSIDIAN_VAULT_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidianlink-vault-test-"));
    config.OBSIDIAN_VAULT_PATH = dir;
    try {
      const vault = new ObsidianVault();
      const note: GeneratedNote = {
        title: "owner/repo",
        relativePath: "1_项目/0_开源项目/owner-repo.md",
        content: "---\ntype: project\n---\n# owner/repo\n\n新内容",
        type: "project",
        githubRepo: "owner/repo"
      };
      await vault.writeNotes([note]);
      const first = await fs.readFile(path.join(dir, note.relativePath), "utf8");
      expect(first).toContain("新内容");

      const plan = await vault.planNotes([note]);
      expect(plan[0].operation).toBe("update_frontmatter");

      const changed: GeneratedNote = { ...note, content: "---\ntype: project\n---\n# owner/repo\n\n第二次发现" };
      changed.operation = plan[0].operation;
      await vault.writeNotes([changed]);
      const second = await fs.readFile(path.join(dir, note.relativePath), "utf8");
      expect(second).toContain("新内容");
      expect(second).toContain("第二次发现");
      expect(second).toContain("新发现");

      await vault.writeNotes([changed]);
      const third = await fs.readFile(path.join(dir, note.relativePath), "utf8");
      expect((third.match(/obsidianlink-discovery:/g) ?? [])).toHaveLength(1);
      expect((third.match(/第二次发现/g) ?? [])).toHaveLength(1);
    } finally {
      config.OBSIDIAN_VAULT_PATH = originalVault;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("checks broken Obsidian wiki links and suggests likely targets", async () => {
    const originalVault = config.OBSIDIAN_VAULT_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidianlink-vault-links-"));
    config.OBSIDIAN_VAULT_PATH = dir;
    try {
      await fs.mkdir(path.join(dir, "2_知识/20_概念"), { recursive: true });
      await fs.mkdir(path.join(dir, "4_想法/0_产品设想"), { recursive: true });
      await fs.writeFile(path.join(dir, "2_知识/20_概念/多渠道消息入口.md"), "# 多渠道消息入口\n", "utf8");
      await fs.writeFile(
        path.join(dir, "4_想法/0_产品设想/智能体控制台.md"),
        [
          "# 智能体控制台",
          "",
          "- 存在路径：[[2_知识/20_概念/多渠道消息入口]]",
          "- 存在文件名：[[多渠道消息入口|入口]]",
          "- 缺失：[[多渠道消息入囗]]"
        ].join("\n"),
        "utf8"
      );

      const result = await new ObsidianVault().checkBrokenLinks();

      expect(result.checkedFiles).toBe(2);
      expect(result.totalLinks).toBe(3);
      expect(result.ok).toBe(false);
      expect(result.brokenLinks).toHaveLength(1);
      expect(result.brokenLinks[0]).toMatchObject({
        sourcePath: "4_想法/0_产品设想/智能体控制台.md",
        normalizedTarget: "多渠道消息入囗"
      });
      expect(result.brokenLinks[0].suggestions).toContain("2_知识/20_概念/多渠道消息入口");
    } finally {
      config.OBSIDIAN_VAULT_PATH = originalVault;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
