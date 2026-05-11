import { config } from "../config.js";
import { GitHubRepo } from "../types.js";
import { truncate } from "../utils.js";

interface GitHubRepoApi {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  topics?: string[];
  license?: { spdx_id?: string; name?: string } | null;
  updated_at: string;
  language: string | null;
}

interface GitHubSearchApi {
  items: GitHubRepoApi[];
}

export class GitHubClient {
  async getRepo(fullName: string): Promise<GitHubRepo> {
    this.assertToken();
    const repo = await this.request<GitHubRepoApi>(`https://api.github.com/repos/${fullName}`);
    const readme = await this.getReadme(repo.full_name);
    return toRepo(repo, readme);
  }

  async searchRepo(query: string): Promise<GitHubRepo | null> {
    this.assertToken();
    if (!query.trim()) return null;
    const params = new URLSearchParams({
      q: `${query} in:name,description,readme`,
      sort: "stars",
      order: "desc",
      per_page: "1"
    });
    const result = await this.request<GitHubSearchApi>(`https://api.github.com/search/repositories?${params}`);
    const first = result.items[0];
    if (!first) return null;
    return this.getRepo(first.full_name);
  }

  private async getReadme(fullName: string): Promise<string> {
    const response = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
      headers: this.headers("application/vnd.github.raw+json")
    });
    if (response.status === 404) return "";
    if (!response.ok) {
      throw new Error(`GitHub README request failed: ${response.status} ${await response.text()}`);
    }
    return truncate(await response.text(), 20000);
  }

  private async request<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }

  private headers(accept = "application/vnd.github+json"): Record<string, string> {
    return {
      Accept: accept,
      Authorization: `Bearer ${config.GITHUB_TOKEN}`,
      "User-Agent": "ObsidianLink/0.1"
    };
  }

  private assertToken(): void {
    if (!config.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN is required for GitHub research");
    }
  }
}

function toRepo(repo: GitHubRepoApi, readme: string): GitHubRepo {
  return {
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    description: repo.description,
    stars: repo.stargazers_count,
    topics: repo.topics ?? [],
    license: repo.license?.spdx_id || repo.license?.name || null,
    updatedAt: repo.updated_at,
    language: repo.language,
    readme
  };
}
